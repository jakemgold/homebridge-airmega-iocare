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
    private readonly presetServices;
    private readonly lightService?;
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
    private clearAllPresets;
    /**
     * Set both `Name` (the static, often hidden identifier) and `ConfiguredName`
     * (the user-visible label Apple Home actually displays for sub-services).
     * Without ConfiguredName, every sub-tile in iOS 16+ falls back to the
     * accessory's own name — which is why all five Airmega sub-tiles previously
     * read "Airmega 400S" instead of "Sleep" / "Eco" / "Display Light" / etc.
     */
    private setServiceName;
    private fanSpeedToHomeKit;
    private homeKitToFanSpeed;
}
