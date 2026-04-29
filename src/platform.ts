import {
  API, DynamicPlatformPlugin, Logger, PlatformAccessory,
  PlatformConfig, Service, Characteristic,
} from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME, DEFAULT_POLL_SECONDS } from './settings';
import { CowayClient } from './api/cowayClient';
import { AirPurifierAccessory } from './accessories/airPurifier';

export interface AirmegaConfig extends PlatformConfig {
  username: string;
  password: string;
  skipPasswordChange?: boolean;
  pollingInterval?: number;
  exposeLight?: boolean;
}

export class AirmegaPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  // Cached accessories restored from disk by Homebridge on launch.
  public readonly accessories: PlatformAccessory[] = [];

  // Assigned conditionally in the constructor; only accessed via discoverDevices
  // and from accessories created therein, so by construction it's never read
  // before assignment.
  public readonly client!: CowayClient;
  private readonly pollingInterval: number;
  private readonly configured: boolean;

  constructor(
    public readonly log: Logger,
    public readonly config: AirmegaConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    // Schema enforces minimum 30s but config.json is hand-edited too. Clamp in
    // code so a misconfigured 0 (or anything below 30) can't tight-loop the
    // Coway API and rate-limit the account.
    const pollSeconds = Math.max(30, config?.pollingInterval ?? DEFAULT_POLL_SECONDS);
    this.pollingInterval = pollSeconds * 1000;

    if (!config?.username || !config?.password) {
      this.log.error('Username and password are required.');
      this.configured = false;
      return;
    }
    this.configured = true;

    this.client = new CowayClient({
      username: config.username,
      password: config.password,
      skipPasswordChange: config.skipPasswordChange ?? true,
      log: this.log,
    });
    // The CowayClient now owns the password. Drop our reference so a future
    // log of `platform.config` (debug helper, error inspector, etc.) doesn't
    // leak it.
    config.password = '';

    this.api.on('didFinishLaunching', () => {
      this.discoverDevices().catch(err => {
        // Log only the message — bare Error objects from axios carry .config
        // and .request which include Authorization headers and the login
        // form body (with the password) in their string form.
        this.log.error('Device discovery failed:', err instanceof Error ? err.message : String(err));
      });
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info(`Loading cached accessory: ${accessory.displayName}`);
    this.accessories.push(accessory);
  }

  async discoverDevices(): Promise<void> {
    if (!this.configured) {
      return;
    }
    await this.client.login();
    const devices = await this.client.listDevices();

    for (const device of devices) {
      const uuid = this.api.hap.uuid.generate(device.deviceId);
      const existing = this.accessories.find(a => a.UUID === uuid);

      if (existing) {
        existing.context.device = device;
        this.api.updatePlatformAccessories([existing]);
        new AirPurifierAccessory(this, existing, this.pollingInterval);
      } else {
        const accessory = new this.api.platformAccessory(device.name, uuid);
        accessory.context.device = device;
        new AirPurifierAccessory(this, accessory, this.pollingInterval);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
    }

    const liveUuids = new Set(devices.map(d => this.api.hap.uuid.generate(d.deviceId)));
    const stale = this.accessories.filter(a => !liveUuids.has(a.UUID));
    if (stale.length > 0) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
    }
  }
}
