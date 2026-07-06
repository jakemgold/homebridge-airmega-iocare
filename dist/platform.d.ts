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
    private readonly wired;
    private discoveryRetryMs;
    constructor(log: Logger, config: AirmegaConfig, api: API);
    /**
     * Run discovery, and on failure schedule a retry with backoff. Without the
     * retry, one transient failure at boot (the Pi comes up before the network,
     * a Coway 5xx wave, an auth blip) left cached accessories restored but
     * never wired: live-looking tiles whose reads served stale values and whose
     * writes silently did nothing until Homebridge was manually restarted.
     */
    private runDiscovery;
    configureAccessory(accessory: PlatformAccessory): void;
    discoverDevices(): Promise<void>;
}
