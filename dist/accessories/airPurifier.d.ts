import { PlatformAccessory } from 'homebridge';
import { AirmegaPlatform } from '../platform';
export declare class AirPurifierAccessory {
    private readonly platform;
    private readonly accessory;
    private readonly pollingInterval;
    private readonly device;
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
    constructor(platform: AirmegaPlatform, accessory: PlatformAccessory, pollingInterval: number);
    private handlePowerSet;
    private handleTargetStateSet;
    private handleRotationSpeedSet;
    private handlePresetSet;
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
    private fanSpeedToHomeKit;
    private homeKitToFanSpeed;
}
