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
    private fanSpeedToHomeKit;
    private homeKitToFanSpeed;
}
