import { PlatformAccessory } from 'homebridge';
import { AirmegaPlatform } from '../platform';
export declare class AirPurifierAccessory {
    private readonly platform;
    private readonly accessory;
    private readonly pollingInterval;
    private readonly device;
    private readonly pmCaps;
    private readonly presetCaps;
    private readonly purifier;
    private readonly airQuality;
    private readonly preFilter;
    private readonly max2Filter;
    private readonly accessoryInfo;
    private readonly presetServices;
    private readonly lightService?;
    private lastFirmwareRevision?;
    private readonly fanSpeedDebouncer;
    private state?;
    private pollHandle?;
    private presetExitHandle?;
    private refreshing;
    constructor(platform: AirmegaPlatform, accessory: PlatformAccessory, pollingInterval: number);
    private handlePowerSet;
    private handleTargetStateSet;
    private handleRotationSpeedSet;
    private handlePresetSet;
    /** Cancel a pending "exit preset to Auto" deferred by a preset switch-off. */
    private cancelPresetExit;
    /**
     * Schedule an exit-to-Auto after a preset switch is turned off. Deferred by
     * PRESET_EXIT_DEBOUNCE_MS and guarded: if the device is no longer in this
     * preset's mode when the timer fires — because another preset was activated,
     * the fan speed changed, or the mode picker was used in the meantime — we
     * leave it alone. Any of those user actions also cancels the timer outright.
     */
    private schedulePresetExit;
    private handleLightSet;
    private startPolling;
    private refresh;
    private pushUpdates;
    /**
     * Update the AccessoryInformation FirmwareRevision when Coway returns a
     * dotted-numeric MCU version. Skipped silently if the value doesn't match
     * HAP's required format, since pushing a non-conforming string would only
     * earn a warning and a revert to the default.
     */
    private pushFirmwareRevision;
    private clearAllPresets;
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
    private setServiceName;
    /**
     * Add or remove an optional characteristic on the AirQualitySensor service
     * based on whether the model supports it. Called once during construction
     * so cached accessories that were registered before per-model gating shed
     * stale PM2.5/PM10 characteristics rather than showing a fake 0.
     */
    private applyPmCharacteristic;
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
    private isAutoForUser;
    private fanSpeedToHomeKit;
    private homeKitToFanSpeed;
}
