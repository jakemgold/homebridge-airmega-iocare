"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AirPurifierAccessory = void 0;
const deviceCodes_1 = require("./deviceCodes");
const PRESETS = [
    { key: 'sleep', subtype: 'preset-sleep', display: 'Sleep', modeValue: deviceCodes_1.ModeValue.NIGHT, apiMode: 'night' },
    { key: 'eco', subtype: 'preset-eco', display: 'Eco', modeValue: deviceCodes_1.ModeValue.ECO, apiMode: 'eco' },
    { key: 'smart', subtype: 'preset-smart', display: 'Smart', modeValue: deviceCodes_1.ModeValue.RAPID, apiMode: 'rapid' },
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
class AirPurifierAccessory {
    platform;
    accessory;
    pollingInterval;
    device;
    purifier;
    airQuality;
    preFilter;
    max2Filter;
    accessoryInfo;
    presetServices = new Map();
    lightService;
    lastFirmwareRevision;
    fanSpeedDebouncer;
    state;
    pollHandle;
    constructor(platform, accessory, pollingInterval) {
        this.platform = platform;
        this.accessory = accessory;
        this.pollingInterval = pollingInterval;
        this.device = accessory.context.device;
        this.fanSpeedDebouncer = new Debouncer(SETTER_DEBOUNCE_MS, async (speed) => {
            try {
                await this.platform.client.sendCommand(this.device, deviceCodes_1.Attribute.FAN_SPEED, String(speed));
            }
            catch (err) {
                this.platform.log.warn(`${this.device.name}: fan speed command failed: ${err instanceof Error ? err.message : String(err)}`);
            }
        });
        const C = platform.Characteristic;
        const S = platform.Service;
        this.accessoryInfo = accessory.getService(S.AccessoryInformation);
        this.accessoryInfo
            .setCharacteristic(C.Manufacturer, 'Coway')
            .setCharacteristic(C.Model, this.device.productModel ?? this.device.model)
            .setCharacteristic(C.SerialNumber, this.device.serial ?? this.device.deviceId)
            .setCharacteristic(C.FirmwareRevision, FIRMWARE_REVISION_FALLBACK);
        this.purifier = accessory.getService(S.AirPurifier) ?? accessory.addService(S.AirPurifier);
        this.setServiceName(this.purifier, this.device.name);
        // Mark the AirPurifier as the primary service so Apple Home shows the
        // purifier tile, with the preset switches and air-quality sensor surfacing
        // as sub-tiles.
        this.purifier.setPrimaryService(true);
        this.purifier.getCharacteristic(C.Active)
            .onGet(() => this.state?.power ? 1 : 0)
            .onSet(v => this.handlePowerSet(v));
        this.purifier.getCharacteristic(C.CurrentAirPurifierState)
            .onGet(() => this.state?.power ? 2 : 0); // 2 = purifying, 0 = inactive
        this.purifier.getCharacteristic(C.TargetAirPurifierState)
            .onGet(() => this.state?.mode === 'auto' ? 1 : 0)
            .onSet(v => this.handleTargetStateSet(v));
        this.purifier.getCharacteristic(C.RotationSpeed)
            .setProps({ minStep: 100 / 3 })
            .onGet(() => this.fanSpeedToHomeKit(this.state?.fanSpeed ?? 1))
            .onSet(v => this.handleRotationSpeedSet(v));
        this.airQuality = accessory.getService(S.AirQualitySensor)
            ?? accessory.addService(S.AirQualitySensor);
        this.setServiceName(this.airQuality, 'Air Quality');
        this.airQuality.getCharacteristic(C.AirQuality)
            .onGet(() => this.state?.airQuality ?? 0);
        this.preFilter = accessory.getServiceById(S.FilterMaintenance, 'pre')
            ?? accessory.addService(S.FilterMaintenance, 'Pre-filter', 'pre');
        this.setServiceName(this.preFilter, 'Pre-filter');
        this.max2Filter = accessory.getServiceById(S.FilterMaintenance, 'max2')
            ?? accessory.addService(S.FilterMaintenance, 'Max2 Filter', 'max2');
        this.setServiceName(this.max2Filter, 'Max2 Filter');
        for (const preset of PRESETS) {
            const svc = accessory.getServiceById(S.Switch, preset.subtype)
                ?? accessory.addService(S.Switch, preset.display, preset.subtype);
            this.setServiceName(svc, preset.display);
            svc.getCharacteristic(C.On)
                .onGet(() => this.state?.mode === preset.apiMode)
                .onSet(v => this.handlePresetSet(preset, v));
            this.presetServices.set(preset.key, svc);
        }
        const exposeLight = platform.config.exposeLight ?? true;
        if (exposeLight) {
            this.lightService = accessory.getServiceById(S.Switch, LIGHT_SUBTYPE)
                ?? accessory.addService(S.Switch, 'Display Light', LIGHT_SUBTYPE);
            this.setServiceName(this.lightService, 'Display Light');
            this.lightService.getCharacteristic(C.On)
                .onGet(() => this.state?.lightOn ?? false)
                .onSet(v => this.handleLightSet(v));
        }
        else {
            // If the user disabled light exposure, remove a previously-registered service.
            const stale = accessory.getServiceById(S.Switch, LIGHT_SUBTYPE);
            if (stale)
                accessory.removeService(stale);
        }
        this.startPolling();
    }
    // --- characteristic handlers ---
    async handlePowerSet(value) {
        const target = value === 1;
        await this.platform.client.sendCommand(this.device, deviceCodes_1.Attribute.POWER, target ? '1' : '0');
        if (this.state)
            this.state.power = target;
    }
    async handleTargetStateSet(value) {
        if (value === 1) {
            await this.platform.client.sendCommand(this.device, deviceCodes_1.Attribute.MODE, deviceCodes_1.ModeValue.AUTO);
            if (this.state)
                this.state.mode = 'auto';
            this.clearAllPresets();
            return;
        }
        // Going to manual: writing fan speed implicitly switches the device out of auto.
        // We re-send the current fan speed so we don't accidentally jump to a new speed.
        const fan = this.state?.fanSpeed ?? 1;
        await this.platform.client.sendCommand(this.device, deviceCodes_1.Attribute.FAN_SPEED, String(fan));
        if (this.state)
            this.state.mode = 'manual';
        this.clearAllPresets();
    }
    async handleRotationSpeedSet(value) {
        const speed = this.homeKitToFanSpeed(value);
        // Update local state optimistically so the next characteristic read is
        // consistent and HomeKit doesn't show stale values during the debounce
        // window.
        if (this.state) {
            this.state.fanSpeed = speed;
            this.state.mode = 'manual';
        }
        this.clearAllPresets();
        // When the user drags the speed slider, Apple Home spams onSet calls
        // (often three or four per drag). Coalesce them and only fire the latest
        // value to Coway after the user pauses, capping API traffic and avoiding
        // visible flicker as multiple commands settle.
        this.fanSpeedDebouncer.schedule(speed);
    }
    async handlePresetSet(preset, value) {
        if (value) {
            await this.platform.client.sendCommand(this.device, deviceCodes_1.Attribute.MODE, preset.modeValue);
            if (this.state)
                this.state.mode = preset.apiMode;
            // Mutual exclusion: clear the other two preset switches synchronously.
            for (const other of PRESETS) {
                if (other.key === preset.key)
                    continue;
                const svc = this.presetServices.get(other.key);
                svc?.updateCharacteristic(this.platform.Characteristic.On, false);
            }
            return;
        }
        // Per HANDOFF.md: when a preset is explicitly turned off and no other preset
        // is being activated, do nothing. The next poll reconciles. This avoids
        // sending a stray manual/auto command when the user is mid-switch between
        // presets (HomeKit sends OFF on the old switch before ON on the new one).
    }
    async handleLightSet(value) {
        if (this.state && !this.state.power) {
            // Per cowayaio's docs the 400S ignores light commands when the unit is
            // off. Reflect that in HomeKit by snapping the toggle back.
            this.platform.log.debug(`${this.device.name}: ignoring light toggle while power is off`);
            this.lightService?.updateCharacteristic(this.platform.Characteristic.On, this.state.lightOn);
            return;
        }
        await this.platform.client.sendCommand(this.device, deviceCodes_1.Attribute.LIGHT, value ? deviceCodes_1.LightMode.ON : deviceCodes_1.LightMode.OFF);
        if (this.state)
            this.state.lightOn = !!value;
    }
    // --- polling ---
    startPolling() {
        // Log only the message — bare Error objects from axios may carry config
        // and request properties that contain Authorization headers or the login
        // form body in their stringified form.
        this.refresh().catch(e => this.platform.log.warn(`${this.device.name}: initial refresh failed: ${e instanceof Error ? e.message : String(e)}`));
        this.pollHandle = setInterval(() => {
            this.refresh().catch(e => this.platform.log.debug(`${this.device.name}: poll failed: ${e instanceof Error ? e.message : String(e)}`));
        }, this.pollingInterval);
    }
    async refresh() {
        this.state = await this.platform.client.getDeviceState(this.device);
        this.pushUpdates();
    }
    pushUpdates() {
        if (!this.state)
            return;
        const C = this.platform.Characteristic;
        this.purifier.updateCharacteristic(C.Active, this.state.power ? 1 : 0);
        this.purifier.updateCharacteristic(C.CurrentAirPurifierState, this.state.power ? 2 : 0);
        this.purifier.updateCharacteristic(C.TargetAirPurifierState, this.state.mode === 'auto' ? 1 : 0);
        this.purifier.updateCharacteristic(C.RotationSpeed, this.fanSpeedToHomeKit(this.state.fanSpeed));
        this.airQuality.updateCharacteristic(C.AirQuality, this.state.airQuality);
        if (this.state.pm25 !== undefined) {
            this.airQuality.updateCharacteristic(C.PM2_5Density, this.state.pm25);
        }
        if (this.state.pm10 !== undefined) {
            this.airQuality.updateCharacteristic(C.PM10Density, this.state.pm10);
        }
        this.preFilter.updateCharacteristic(C.FilterLifeLevel, this.state.preFilterPct);
        this.preFilter.updateCharacteristic(C.FilterChangeIndication, this.state.preFilterPct < 10 ? 1 : 0);
        this.max2Filter.updateCharacteristic(C.FilterLifeLevel, this.state.max2FilterPct);
        this.max2Filter.updateCharacteristic(C.FilterChangeIndication, this.state.max2FilterPct < 10 ? 1 : 0);
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
    pushFirmwareRevision(mcuVersion) {
        if (!mcuVersion || !FIRMWARE_REVISION_RE.test(mcuVersion))
            return;
        if (mcuVersion === this.lastFirmwareRevision)
            return;
        this.accessoryInfo.updateCharacteristic(this.platform.Characteristic.FirmwareRevision, mcuVersion);
        this.lastFirmwareRevision = mcuVersion;
    }
    clearAllPresets() {
        const C = this.platform.Characteristic;
        for (const preset of PRESETS) {
            this.presetServices.get(preset.key)?.updateCharacteristic(C.On, false);
        }
    }
    // --- helpers ---
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
    setServiceName(svc, name) {
        const C = this.platform.Characteristic;
        svc.setCharacteristic(C.Name, name);
        svc.addOptionalCharacteristic(C.ConfiguredName);
        svc.setCharacteristic(C.ConfiguredName, name);
    }
    fanSpeedToHomeKit(s) {
        return Math.round((s / 3) * 100);
    }
    homeKitToFanSpeed(pct) {
        if (pct <= 33)
            return 1;
        if (pct <= 66)
            return 2;
        return 3;
    }
}
exports.AirPurifierAccessory = AirPurifierAccessory;
/**
 * Coalesces rapid-fire writes into a single trailing call. Each `schedule(v)`
 * (re)starts a timer; when the timer fires, the most-recent value is passed
 * to `onFire`. We use this for the fan-speed slider where Apple Home emits
 * several onSet callbacks per drag — without it, every intermediate value
 * round-trips to Coway and the user sees flicker as commands settle.
 */
class Debouncer {
    delayMs;
    onFire;
    timer;
    latest;
    constructor(delayMs, onFire) {
        this.delayMs = delayMs;
        this.onFire = onFire;
    }
    schedule(value) {
        this.latest = value;
        if (this.timer)
            clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.timer = undefined;
            const v = this.latest;
            // Errors must be caught here — the setTimeout callback is detached from
            // any caller and an unhandled rejection would crash Homebridge.
            this.onFire(v).catch(() => undefined);
        }, this.delayMs);
    }
}
//# sourceMappingURL=airPurifier.js.map