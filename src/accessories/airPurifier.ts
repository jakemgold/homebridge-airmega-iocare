import {
  PlatformAccessory, Service, CharacteristicValue,
} from 'homebridge';

import { AirmegaPlatform } from '../platform';
import { Attribute, LightMode, ModeValue, PowerValue } from '../api/endpoints';
import { CowayDevice, DeviceState } from '../api/types';
import {
  LIGHT_SWITCH_MODELS, LIGHT_SWITCH_UNKNOWN,
  PM_CAPABILITIES, PM_CAPABILITIES_UNKNOWN, PmCapabilities,
  PRESET_CAPABILITIES, PRESET_CAPABILITIES_UNKNOWN, PresetCapabilities,
} from './deviceCodes';

interface PresetSpec {
  key: 'sleep' | 'eco' | 'smart';
  subtype: string;
  display: string;
  modeValue: string;
  apiMode: DeviceState['mode'];
}

const PRESETS: readonly PresetSpec[] = [
  { key: 'sleep', subtype: 'preset-sleep', display: 'Sleep', modeValue: ModeValue.NIGHT, apiMode: 'night' },
  { key: 'eco',   subtype: 'preset-eco',   display: 'Eco',   modeValue: ModeValue.ECO,   apiMode: 'eco' },
  { key: 'smart', subtype: 'preset-smart', display: 'Smart', modeValue: ModeValue.RAPID, apiMode: 'rapid' },
];

const LIGHT_SUBTYPE = 'led';

// HAP requires FirmwareRevision to be a dotted numeric string (e.g. '1.0.6').
// Anything that doesn't match raises a "not a valid value" warning and the
// characteristic falls back to its default — so we validate before pushing.
const FIRMWARE_REVISION_RE = /^\d+(\.\d+){0,2}$/;
// Used until the first state poll lands a real value, and as a defensive
// fallback if Coway ever returns a non-numeric MCU string.
const FIRMWARE_REVISION_FALLBACK = '0.0.0';

// Coalesce rapid-fire characteristic writes (Apple Home spams them when the
// user drags a slider) and only fire the latest value once the user pauses.
// 250ms is short enough that the user perceives the action as immediate but
// long enough to absorb a typical drag.
const SETTER_DEBOUNCE_MS = 250;

// Poll failures are debug-level (they're routine: one 5xx, one timeout) until
// this many fail consecutively — then warn, because the user is now looking
// at stale state with no signal at default log level. Re-warn periodically so
// a long outage doesn't go quiet after a single line.
const POLL_FAILURE_WARN_THRESHOLD = 3;
const POLL_FAILURE_REWARN_EVERY = 30;

// When a preset switch is turned off, we exit to Auto — but only after a short
// delay. On the 250S (the one model with two presets) Apple Home fires OFF on
// the old switch immediately before ON on the new one when swapping presets;
// this window lets that ON arrive and cancel the exit so we don't fire a stray
// Auto command between them. Comfortably longer than the back-to-back OFF/ON
// gap, short enough that exiting Sleep still feels immediate.
const PRESET_EXIT_DEBOUNCE_MS = 400;

export class AirPurifierAccessory {
  private readonly device: CowayDevice;
  private readonly pmCaps: PmCapabilities;
  private readonly presetCaps: PresetCapabilities;

  private readonly purifier: Service;
  private readonly airQuality: Service;
  private readonly preFilter: Service;
  private readonly max2Filter: Service;
  private readonly accessoryInfo: Service;
  private readonly presetServices = new Map<PresetSpec['key'], Service>();
  private readonly lightService?: Service;
  private lastFirmwareRevision?: string;

  private readonly fanSpeedDebouncer: Debouncer<1 | 2 | 3>;

  private state?: DeviceState;
  private pollHandle?: NodeJS.Timeout;
  private presetExitHandle?: NodeJS.Timeout;
  private refreshing = false;
  // Bumped whenever a device command is initiated. refresh() compares the
  // value before and after its fetch: a poll snapshot taken before a command
  // resolved after it would otherwise overwrite the optimistic state and
  // flip HomeKit back to pre-command values until the next poll.
  private commandEpoch = 0;
  private consecutivePollFailures = 0;

  constructor(
    private readonly platform: AirmegaPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly pollingInterval: number,
  ) {
    this.device = accessory.context.device as CowayDevice;
    this.pmCaps = PM_CAPABILITIES[this.device.productModel] ?? PM_CAPABILITIES_UNKNOWN;
    this.presetCaps = PRESET_CAPABILITIES[this.device.productModel] ?? PRESET_CAPABILITIES_UNKNOWN;
    // PM_CAPABILITIES and PRESET_CAPABILITIES are populated from the same
    // model set, so a miss in either means the model is unrecognized — one
    // warn covers the consequences for both capability tables.
    if (!PM_CAPABILITIES[this.device.productModel] || !PRESET_CAPABILITIES[this.device.productModel]) {
      platform.log.warn(
        `${this.device.name}: unknown productModel "${this.device.productModel}"; ` +
        `not exposing PM2.5/PM10 or the Display Light switch to HomeKit and registering ` +
        `only the Sleep preset. ` +
        `Please file an issue with this productModel string so a capability row can be added.`,
      );
    }
    this.fanSpeedDebouncer = new Debouncer<1 | 2 | 3>(SETTER_DEBOUNCE_MS, async speed => {
      try {
        this.commandEpoch++;
        await this.platform.client.sendCommand(this.device, Attribute.FAN_SPEED, String(speed));
      } catch (err) {
        this.platform.log.warn(
          `${this.device.name}: fan speed command failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
    const C = platform.Characteristic;
    const S = platform.Service;

    this.accessoryInfo = accessory.getService(S.AccessoryInformation)!;
    this.accessoryInfo
      .setCharacteristic(C.Manufacturer, 'Coway')
      .setCharacteristic(C.Model, this.device.productModel ?? this.device.model)
      .setCharacteristic(C.SerialNumber, this.device.serial ?? this.device.deviceId);
    // Preserve a firmware version restored from the accessory cache rather
    // than stomping it back to the fallback on every restart — the real value
    // only returns with the first successful poll, which a Coway outage at
    // boot can postpone indefinitely.
    const cachedFw = this.accessoryInfo.getCharacteristic(C.FirmwareRevision).value;
    if (typeof cachedFw === 'string' && FIRMWARE_REVISION_RE.test(cachedFw)) {
      this.lastFirmwareRevision = cachedFw;
    } else {
      this.accessoryInfo.setCharacteristic(C.FirmwareRevision, FIRMWARE_REVISION_FALLBACK);
    }

    this.purifier = accessory.getService(S.AirPurifier) ?? accessory.addService(S.AirPurifier);
    this.setServiceName(this.purifier, this.device.name);
    // Mark the AirPurifier as the primary service so Apple Home shows the
    // purifier tile, with the preset switches and air-quality sensor surfacing
    // as sub-tiles.
    this.purifier.setPrimaryService(true);

    this.purifier.getCharacteristic(C.Active)
      .onGet(() => this.state?.power ? 1 : 0)
      .onSet(this.guardCommand('power', v => this.handlePowerSet(v)));

    this.purifier.getCharacteristic(C.CurrentAirPurifierState)
      .onGet(() => this.state?.power ? 2 : 0); // 2 = purifying, 0 = inactive

    this.purifier.getCharacteristic(C.TargetAirPurifierState)
      .onGet(() => this.isAutoForUser(this.state?.mode) ? 1 : 0)
      .onSet(this.guardCommand('mode', v => this.handleTargetStateSet(v)));

    this.purifier.getCharacteristic(C.RotationSpeed)
      .setProps({ minStep: 100 / 3 })
      .onGet(() => this.fanSpeedToHomeKit(this.state?.fanSpeed ?? 1))
      .onSet(this.guardCommand('fan speed', v => this.handleRotationSpeedSet(v)));

    this.airQuality = accessory.getService(S.AirQualitySensor)
      ?? accessory.addService(S.AirQualitySensor);
    this.setServiceName(this.airQuality, 'Air Quality');
    this.airQuality.getCharacteristic(C.AirQuality)
      .onGet(() => this.state?.airQuality ?? 0);

    // Per-model PM gating. The AirQualitySensor service template includes
    // PM2_5Density and PM10Density as optional characteristics — once we've
    // ever called updateCharacteristic on them, they stick on the cached
    // accessory and render in HomeKit at their default of 0 even if we stop
    // pushing. Explicit removal cleans up accessories that were registered
    // before this gating existed.
    this.applyPmCharacteristic(C.PM2_5Density, this.pmCaps.pm25);
    this.applyPmCharacteristic(C.PM10Density, this.pmCaps.pm10);

    this.preFilter = accessory.getServiceById(S.FilterMaintenance, 'pre')
      ?? accessory.addService(S.FilterMaintenance, 'Pre-filter', 'pre');
    this.setServiceName(this.preFilter, 'Pre-filter');
    this.max2Filter = accessory.getServiceById(S.FilterMaintenance, 'max2')
      ?? accessory.addService(S.FilterMaintenance, 'Max2 Filter', 'max2');
    this.setServiceName(this.max2Filter, 'Max2 Filter');

    for (const preset of PRESETS) {
      if (!this.presetCaps[preset.key]) {
        // Remove stale switch from accessories registered before per-model
        // gating existed — without this they'd persist in Apple Home as a
        // tile the user can press to no effect (or, post-PR #1's status
        // validation, a tile that returns a Coway error every time).
        const stale = accessory.getServiceById(S.Switch, preset.subtype);
        if (stale) accessory.removeService(stale);
        continue;
      }
      const svc = accessory.getServiceById(S.Switch, preset.subtype)
        ?? accessory.addService(S.Switch, preset.display, preset.subtype);
      this.setServiceName(svc, preset.display);
      svc.getCharacteristic(C.On)
        .onGet(() => this.state?.mode === preset.apiMode)
        .onSet(this.guardCommand(`${preset.display} preset`, v => this.handlePresetSet(preset, v)));
      this.presetServices.set(preset.key, svc);
    }

    // Per-model gating on top of the user config: the 250S/IconS light
    // register is inverted relative to the 400S semantics we speak (see
    // LIGHT_SWITCH_MODELS), so exposing the switch there would show the
    // opposite state and send the opposite command.
    const modelHasLightSwitch =
      LIGHT_SWITCH_MODELS[this.device.productModel] ?? LIGHT_SWITCH_UNKNOWN;
    const exposeLight = (platform.config.exposeLight ?? true) && modelHasLightSwitch;
    if (exposeLight) {
      this.lightService = accessory.getServiceById(S.Switch, LIGHT_SUBTYPE)
        ?? accessory.addService(S.Switch, 'Display Light', LIGHT_SUBTYPE);
      this.setServiceName(this.lightService, 'Display Light');
      this.lightService.getCharacteristic(C.On)
        .onGet(() => this.state?.lightOn ?? false)
        .onSet(this.guardCommand('Display Light', v => this.handleLightSet(v)));
    } else {
      // Remove a previously-registered service — user disabled it, or the
      // accessory was cached from a version that exposed it on every model.
      const stale = accessory.getServiceById(S.Switch, LIGHT_SUBTYPE);
      if (stale) accessory.removeService(stale);
    }

    this.startPolling();
  }

  // --- characteristic handlers ---

  private async handlePowerSet(value: CharacteristicValue): Promise<void> {
    this.cancelPresetExit();
    // A pending debounced fan-speed write would land after this command and
    // wake the unit or force manual mode — the power command supersedes it.
    this.fanSpeedDebouncer.cancel();
    const target = value === 1;
    this.commandEpoch++;
    await this.platform.client.sendCommand(
      this.device, Attribute.POWER, target ? PowerValue.ON : PowerValue.OFF,
    );
    if (this.state) this.state.power = target;
    // Push the paired current-state characteristic so event-subscribed
    // controllers don't sit in the transitional "Starting…" combination
    // (Active=1, CurrentState=INACTIVE) until the next poll.
    this.purifier.updateCharacteristic(
      this.platform.Characteristic.CurrentAirPurifierState, target ? 2 : 0,
    );
  }

  private async handleTargetStateSet(value: CharacteristicValue): Promise<void> {
    this.cancelPresetExit();
    // A pending debounced fan-speed write fires after the mode command and
    // would knock the device straight back out of the target mode (fan
    // writes implicitly force manual). state.fanSpeed already carries the
    // debounced value, so the manual branch below re-sends the same intent.
    this.fanSpeedDebouncer.cancel();
    if (value === 1) {
      this.commandEpoch++;
      await this.platform.client.sendCommand(this.device, Attribute.MODE, ModeValue.AUTO);
      if (this.state) this.state.mode = 'auto';
      this.clearAllPresets();
      return;
    }
    // Going to manual: writing fan speed implicitly switches the device out of auto.
    // We re-send the current fan speed so we don't accidentally jump to a new speed.
    // Clamp to the FAN_SPEED command contract ('1'|'2'|'3'): reported speeds
    // above 3 are read-only telemetry for special modes (5 = Rapid on the
    // 250S) and commanding them back would re-trigger those modes or be
    // rejected outright.
    const fan = Math.min(this.state?.fanSpeed ?? 1, 3);
    this.commandEpoch++;
    await this.platform.client.sendCommand(this.device, Attribute.FAN_SPEED, String(fan));
    if (this.state) this.state.mode = 'manual';
    this.clearAllPresets();
  }

  private async handleRotationSpeedSet(value: CharacteristicValue): Promise<void> {
    this.cancelPresetExit();
    const pct = value as number;
    if (pct === 0) {
      // The Home app sends RotationSpeed=0 together with Active=0 when the
      // slider is dragged to zero. Power-off is handled by handlePowerSet;
      // mapping 0 to a speed here would fire a stray FAN_SPEED write at the
      // just-powered-off unit 250ms later (and fan writes implicitly force
      // manual mode). Match the reference integration: 0 is power-off only.
      this.fanSpeedDebouncer.cancel();
      return;
    }
    const speed = this.homeKitToFanSpeed(pct);
    // Bump the epoch now, not just when the debounced send fires: the
    // optimistic state below must survive a poll snapshot that resolves
    // inside the 250ms debounce window.
    this.commandEpoch++;
    // Update local state optimistically so the next characteristic read is
    // consistent and HomeKit doesn't show stale values during the debounce
    // window.
    if (this.state) {
      this.state.fanSpeed = speed;
      this.state.mode = 'manual';
    }
    this.clearAllPresets();
    // A manual speed write exits auto; tell subscribed controllers now
    // instead of leaving the mode picker stale until the next poll.
    this.purifier.updateCharacteristic(
      this.platform.Characteristic.TargetAirPurifierState, 0,
    );
    // When the user drags the speed slider, Apple Home spams onSet calls
    // (often three or four per drag). Coalesce them and only fire the latest
    // value to Coway after the user pauses, capping API traffic and avoiding
    // visible flicker as multiple commands settle.
    this.fanSpeedDebouncer.schedule(speed);
  }

  private async handlePresetSet(preset: PresetSpec, value: CharacteristicValue): Promise<void> {
    if (value) {
      // A fresh preset activation cancels any pending exit from a preset that
      // was just turned off (the 250S swap fires OFF-old then ON-new) — and
      // any pending debounced fan-speed write, which would otherwise fire
      // after the mode command and drop the device back to manual.
      this.cancelPresetExit();
      this.fanSpeedDebouncer.cancel();
      this.commandEpoch++;
      await this.platform.client.sendCommand(this.device, Attribute.MODE, preset.modeValue);
      if (this.state) this.state.mode = preset.apiMode;
      // Mutual exclusion: clear the other preset switches synchronously.
      for (const other of PRESETS) {
        if (other.key === preset.key) continue;
        const svc = this.presetServices.get(other.key);
        svc?.updateCharacteristic(this.platform.Characteristic.On, false);
      }
      return;
    }
    // Preset turned off. With three mutually-exclusive presets this was a no-op:
    // HomeKit sends OFF on the old switch before ON on the new one, so we waited
    // for the ON. But most models now expose a single preset switch (issue #7),
    // and for those an "off" has no following "on" — leaving the user stranded
    // in the preset with the switch springing back on at the next poll. So we
    // exit to Auto, deferred and guarded (see schedulePresetExit) so the 250S's
    // two-preset swap still doesn't fire a stray Auto.
    this.schedulePresetExit(preset);
  }

  /** Cancel a pending "exit preset to Auto" deferred by a preset switch-off. */
  private cancelPresetExit(): void {
    if (this.presetExitHandle) {
      clearTimeout(this.presetExitHandle);
      this.presetExitHandle = undefined;
    }
  }

  /**
   * Schedule an exit-to-Auto after a preset switch is turned off. Deferred by
   * PRESET_EXIT_DEBOUNCE_MS and guarded: if the device is no longer in this
   * preset's mode when the timer fires — because another preset was activated,
   * the fan speed changed, or the mode picker was used in the meantime — we
   * leave it alone. Any of those user actions also cancels the timer outright.
   */
  private schedulePresetExit(preset: PresetSpec): void {
    this.cancelPresetExit();
    this.presetExitHandle = setTimeout(() => {
      this.presetExitHandle = undefined;
      // Skip the exit only when we KNOW the device has left the preset.
      // Unknown state (no successful poll yet — a slow or failing first
      // fetch) must still exit: the preset ON command went out regardless of
      // state, so bailing here would strand the device in the preset while
      // the HomeKit switch reads off.
      if (this.state && this.state.mode !== preset.apiMode) return;
      // Detached timer: a rejection here would crash Homebridge, so catch it.
      this.exitPresetToAuto().catch(err => this.platform.log.warn(
        `${this.device.name}: exit-preset command failed: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      ));
    }, PRESET_EXIT_DEBOUNCE_MS);
  }

  private async exitPresetToAuto(): Promise<void> {
    this.commandEpoch++;
    await this.platform.client.sendCommand(this.device, Attribute.MODE, ModeValue.AUTO);
    if (this.state) this.state.mode = 'auto';
    this.clearAllPresets();
    this.purifier.updateCharacteristic(
      this.platform.Characteristic.TargetAirPurifierState,
      this.isAutoForUser('auto') ? 1 : 0,
    );
  }

  private async handleLightSet(value: CharacteristicValue): Promise<void> {
    if (this.state && !this.state.power) {
      // Per cowayaio's docs the 400S ignores light commands when the unit is
      // off. Reflect that in HomeKit by snapping the toggle back.
      this.platform.log.debug(`${this.device.name}: ignoring light toggle while power is off`);
      this.lightService?.updateCharacteristic(this.platform.Characteristic.On, this.state.lightOn);
      return;
    }
    this.commandEpoch++;
    await this.platform.client.sendCommand(
      this.device, Attribute.LIGHT, value ? LightMode.ON : LightMode.OFF,
    );
    if (this.state) this.state.lightOn = !!value;
  }

  // --- polling ---

  private startPolling(): void {
    // Log only the message — bare Error objects from axios may carry config
    // and request properties that contain Authorization headers or the login
    // form body in their stringified form.
    this.refresh().catch(e =>
      this.platform.log.warn(
        `${this.device.name}: initial refresh failed: ${e instanceof Error ? e.message : String(e)}`,
      ),
    );
    this.pollHandle = setInterval(() => {
      this.refresh().catch(e => this.notePollFailure(e));
    }, this.pollingInterval);
  }

  /**
   * Log a poll failure. One-off failures are routine (a 5xx, a timeout) and
   * stay at debug; a streak means HomeKit is serving stale state with no
   * user-visible signal, so escalate to warn at the threshold and re-warn
   * periodically for the duration of the outage.
   */
  private notePollFailure(e: unknown): void {
    this.consecutivePollFailures++;
    const msg = `${this.device.name}: poll failed: ${e instanceof Error ? e.message : String(e)}`;
    const n = this.consecutivePollFailures;
    if (n === POLL_FAILURE_WARN_THRESHOLD || n % POLL_FAILURE_REWARN_EVERY === 0) {
      this.platform.log.warn(
        `${msg} (${n} consecutive failures; HomeKit is showing last known state)`,
      );
      return;
    }
    this.platform.log.debug(msg);
  }

  private async refresh(): Promise<void> {
    // The client already logged the pause when it started; HomeKit keeps
    // showing the last known state until it lifts.
    if (this.platform.client.isRateLimited()) {
      this.platform.log.debug(`${this.device.name}: skipping poll while Coway rate-limits the account`);
      return;
    }
    // Guard against overlapping polls: a slow Coway response (3 round-trips,
    // up to ~75s with worst-case retries) can outlast the polling interval,
    // and unguarded setInterval would queue successors on top.
    if (this.refreshing) {
      this.platform.log.debug(`${this.device.name}: skipping poll, prior refresh still in flight`);
      return;
    }
    this.refreshing = true;
    try {
      const epochAtFetch = this.commandEpoch;
      const snapshot = await this.platform.client.getDeviceState(this.device);
      // Coway responded — the outage (if any) is over, whether or not we
      // adopt this particular snapshot below.
      if (this.consecutivePollFailures >= POLL_FAILURE_WARN_THRESHOLD) {
        this.platform.log.info(
          `${this.device.name}: polling recovered after ${this.consecutivePollFailures} failures.`,
        );
      }
      this.consecutivePollFailures = 0;
      if (epochAtFetch !== this.commandEpoch) {
        // A user command was initiated while this poll was in flight, so the
        // snapshot predates it. Adopting it would overwrite the optimistic
        // state and flip HomeKit back to pre-command values. Drop it; the
        // next poll reports the post-command state.
        this.platform.log.debug(
          `${this.device.name}: discarding poll snapshot fetched before a command`,
        );
        return;
      }
      this.state = snapshot;
      this.pushUpdates();
    } finally {
      this.refreshing = false;
    }
  }

  private pushUpdates(): void {
    if (!this.state) return;
    const C = this.platform.Characteristic;

    this.purifier.updateCharacteristic(C.Active, this.state.power ? 1 : 0);
    this.purifier.updateCharacteristic(C.CurrentAirPurifierState, this.state.power ? 2 : 0);
    this.purifier.updateCharacteristic(
      C.TargetAirPurifierState, this.isAutoForUser(this.state.mode) ? 1 : 0,
    );
    this.purifier.updateCharacteristic(
      C.RotationSpeed, this.fanSpeedToHomeKit(this.state.fanSpeed),
    );

    this.airQuality.updateCharacteristic(C.AirQuality, this.state.airQuality);
    // PM updates are gated by the per-model capability table. Models that
    // don't actually report PM2.5 (e.g. the 400S) populate PM25_IDX with 0,
    // which would otherwise look like "very clean air" in HomeKit forever.
    if (this.pmCaps.pm25 && this.state.pm25 !== undefined) {
      this.airQuality.updateCharacteristic(C.PM2_5Density, this.state.pm25);
    }
    if (this.pmCaps.pm10 && this.state.pm10 !== undefined) {
      this.airQuality.updateCharacteristic(C.PM10Density, this.state.pm10);
    }

    // Only push filter values when Coway returned them. Skipping the update
    // leaves HomeKit's last known value in place, which is safer than
    // synthesizing a healthy 100% on missing data.
    if (this.state.preFilterPct !== undefined) {
      this.preFilter.updateCharacteristic(C.FilterLifeLevel, this.state.preFilterPct);
      this.preFilter.updateCharacteristic(
        C.FilterChangeIndication, this.state.preFilterPct < 10 ? 1 : 0,
      );
    }
    if (this.state.max2FilterPct !== undefined) {
      this.max2Filter.updateCharacteristic(C.FilterLifeLevel, this.state.max2FilterPct);
      this.max2Filter.updateCharacteristic(
        C.FilterChangeIndication, this.state.max2FilterPct < 10 ? 1 : 0,
      );
    }

    for (const preset of PRESETS) {
      const svc = this.presetServices.get(preset.key);
      svc?.updateCharacteristic(C.On, this.state.mode === preset.apiMode);
    }

    this.lightService?.updateCharacteristic(C.On, this.state.lightOn);

    this.pushFirmwareRevision(this.state.mcuVersion);
  }

  /**
   * Update the AccessoryInformation FirmwareRevision when Coway returns a
   * dotted-numeric MCU version. Skipped silently if the value doesn't match
   * HAP's required format, since pushing a non-conforming string would only
   * earn a warning and a revert to the default.
   */
  private pushFirmwareRevision(mcuVersion: string | undefined): void {
    if (!mcuVersion || !FIRMWARE_REVISION_RE.test(mcuVersion)) return;
    if (mcuVersion === this.lastFirmwareRevision) return;
    this.accessoryInfo.updateCharacteristic(
      this.platform.Characteristic.FirmwareRevision, mcuVersion,
    );
    this.lastFirmwareRevision = mcuVersion;
  }

  private clearAllPresets(): void {
    const C = this.platform.Characteristic;
    for (const preset of PRESETS) {
      this.presetServices.get(preset.key)?.updateCharacteristic(C.On, false);
    }
  }

  // --- helpers ---

  /**
   * Wrap a characteristic set handler so a failed command logs one line and
   * fails the write with HAP's communication-failure status. A plain error
   * escaping a set handler makes HAP log it as an unhandled error with a full
   * stack trace.
   */
  private guardCommand(
    label: string,
    handler: (value: CharacteristicValue) => Promise<void>,
  ): (value: CharacteristicValue) => Promise<void> {
    return async value => {
      try {
        await handler(value);
      } catch (err) {
        this.platform.log.warn(
          `${this.device.name}: ${label} command failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        const { HapStatusError, HAPStatus } = this.platform.api.hap;
        throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      }
    };
  }

  /**
   * Set both `Name` (the static, often hidden identifier) and `ConfiguredName`
   * (the user-visible label Apple Home actually displays for sub-services).
   * Without ConfiguredName, every sub-tile in iOS 16+ falls back to the
   * accessory's own name — which is why all five Airmega sub-tiles previously
   * read "Airmega 400S" instead of "Sleep" / "Eco" / "Display Light" / etc.
   *
   * `addOptionalCharacteristic` is needed because HAP-NodeJS's metadata for
   * AirPurifier / AirQualitySensor / FilterMaintenance / Switch doesn't list
   * ConfiguredName as a recognized optional characteristic, so writing it via
   * setCharacteristic alone produces a "Characteristic not in required or
   * optional characteristic section" warning per service. Registering it on
   * the optional list first silences the warning and matches the documented
   * pattern for adding non-canonical characteristics.
   */
  private setServiceName(svc: Service, name: string): void {
    const C = this.platform.Characteristic;
    svc.setCharacteristic(C.Name, name);
    svc.addOptionalCharacteristic(C.ConfiguredName);
    svc.setCharacteristic(C.ConfiguredName, name);
  }

  /**
   * Add or remove an optional characteristic on the AirQualitySensor service
   * based on whether the model supports it. Called once during construction
   * so cached accessories that were registered before per-model gating shed
   * stale PM2.5/PM10 characteristics rather than showing a fake 0.
   */
  // `any` because HAP-NodeJS's characteristic constructors are typed as
  // `WithUUID<new () => Characteristic>` unions that don't flow through
  // getCharacteristic/testCharacteristic overloads cleanly.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private applyPmCharacteristic(ctor: any, supported: boolean): void {
    if (supported) {
      this.airQuality.getCharacteristic(ctor);
    } else if (this.airQuality.testCharacteristic(ctor)) {
      this.airQuality.removeCharacteristic(this.airQuality.getCharacteristic(ctor));
    }
  }

  /**
   * Decide whether the device's current mode should read as "Auto" to the
   * HomeKit user. mode='auto' (register=1) is obviously Auto. mode='eco'
   * (register=6) is a firmware-driven sub-state of Smart Mode on every
   * model except the MightyS, so for those models the user is still
   * conceptually in Auto when the firmware enters Eco on its own. On the
   * MightyS, Eco is an explicit user preset and should read as Manual
   * with the Eco preset switch active — matching how Apple Home surfaces
   * any other user-selected preset.
   */
  private isAutoForUser(mode: DeviceState['mode'] | undefined): boolean {
    if (mode === 'auto') return true;
    if (mode === 'eco' && !this.presetCaps.eco) return true;
    return false;
  }

  private fanSpeedToHomeKit(s: number): number {
    // Coway reports speeds above 3 while in special modes (5 = Rapid on the
    // 250S); RotationSpeed is 0-100 over our three steps, so cap at 3 rather
    // than emitting an out-of-range value HAP would warn about every poll.
    const step = Math.min(s, 3);
    return Math.round((step / 3) * 100);
  }
  private homeKitToFanSpeed(pct: number): 1 | 2 | 3 {
    // iOS snaps the slider to multiples of minStep (100/3), so writes arrive
    // as 33.333... and 66.666..., not integers — and HAP passes the floats
    // through unrounded. Round first, then compare against the rounded
    // detents; bare `<= 33` / `<= 66` mapped every detent one speed high and
    // made speed 1 unreachable from the slider.
    const rounded = Math.round(pct);
    if (rounded <= 33) return 1;
    if (rounded <= 67) return 2;
    return 3;
  }
}

/**
 * Coalesces rapid-fire writes into a single trailing call. Each `schedule(v)`
 * (re)starts a timer; when the timer fires, the most-recent value is passed
 * to `onFire`. We use this for the fan-speed slider where Apple Home emits
 * several onSet callbacks per drag — without it, every intermediate value
 * round-trips to Coway and the user sees flicker as commands settle.
 */
class Debouncer<T> {
  private timer?: NodeJS.Timeout;
  private latest?: T;

  constructor(
    private readonly delayMs: number,
    private readonly onFire: (value: T) => Promise<void>,
  ) {}

  schedule(value: T): void {
    this.latest = value;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const v = this.latest as T;
      // Errors must be caught here — the setTimeout callback is detached from
      // any caller and an unhandled rejection would crash Homebridge.
      this.onFire(v).catch(() => undefined);
    }, this.delayMs);
  }

  /**
   * Drop the pending value, if any. Called when a superseding command (power,
   * mode, preset) is sent: a fan-speed write landing after it would knock the
   * device back out of the mode the user just selected.
   */
  cancel(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.latest = undefined;
  }
}
