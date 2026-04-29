import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service, Characteristic } from 'homebridge';
import { CowayClient } from './api/cowayClient';
export interface AirmegaConfig extends PlatformConfig {
    username: string;
    password: string;
    skipPasswordChange?: boolean;
    pollingInterval?: number;
    exposeLight?: boolean;
}
export declare class AirmegaPlatform implements DynamicPlatformPlugin {
    readonly log: Logger;
    readonly config: AirmegaConfig;
    readonly api: API;
    readonly Service: typeof Service;
    readonly Characteristic: typeof Characteristic;
    readonly accessories: PlatformAccessory[];
    readonly client: CowayClient;
    private readonly pollingInterval;
    private readonly configured;
    constructor(log: Logger, config: AirmegaConfig, api: API);
    configureAccessory(accessory: PlatformAccessory): void;
    discoverDevices(): Promise<void>;
}
