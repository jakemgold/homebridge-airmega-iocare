"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AirmegaPlatform = void 0;
const settings_1 = require("./settings");
const cowayClient_1 = require("./api/cowayClient");
const airPurifier_1 = require("./accessories/airPurifier");
class AirmegaPlatform {
    log;
    config;
    api;
    Service;
    Characteristic;
    // Cached accessories restored from disk by Homebridge on launch.
    accessories = [];
    // Assigned conditionally in the constructor; only accessed via discoverDevices
    // and from accessories created therein, so by construction it's never read
    // before assignment.
    client;
    pollingInterval;
    configured;
    constructor(log, config, api) {
        this.log = log;
        this.config = config;
        this.api = api;
        this.Service = api.hap.Service;
        this.Characteristic = api.hap.Characteristic;
        this.pollingInterval = (config?.pollingInterval ?? settings_1.DEFAULT_POLL_SECONDS) * 1000;
        if (!config?.username || !config?.password) {
            this.log.error('Username and password are required.');
            this.configured = false;
            return;
        }
        this.configured = true;
        this.client = new cowayClient_1.CowayClient({
            username: config.username,
            password: config.password,
            skipPasswordChange: config.skipPasswordChange ?? true,
            log: this.log,
        });
        this.api.on('didFinishLaunching', () => {
            this.discoverDevices().catch(err => {
                this.log.error('Device discovery failed:', err);
            });
        });
    }
    configureAccessory(accessory) {
        this.log.info(`Loading cached accessory: ${accessory.displayName}`);
        this.accessories.push(accessory);
    }
    async discoverDevices() {
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
                new airPurifier_1.AirPurifierAccessory(this, existing, this.pollingInterval);
            }
            else {
                const accessory = new this.api.platformAccessory(device.name, uuid);
                accessory.context.device = device;
                new airPurifier_1.AirPurifierAccessory(this, accessory, this.pollingInterval);
                this.api.registerPlatformAccessories(settings_1.PLUGIN_NAME, settings_1.PLATFORM_NAME, [accessory]);
            }
        }
        const liveUuids = new Set(devices.map(d => this.api.hap.uuid.generate(d.deviceId)));
        const stale = this.accessories.filter(a => !liveUuids.has(a.UUID));
        if (stale.length > 0) {
            this.api.unregisterPlatformAccessories(settings_1.PLUGIN_NAME, settings_1.PLATFORM_NAME, stale);
        }
    }
}
exports.AirmegaPlatform = AirmegaPlatform;
//# sourceMappingURL=platform.js.map