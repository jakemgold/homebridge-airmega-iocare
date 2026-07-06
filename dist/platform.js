"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AirmegaPlatform = void 0;
const settings_1 = require("./settings");
const auth_1 = require("./api/auth");
const cowayClient_1 = require("./api/cowayClient");
const airPurifier_1 = require("./accessories/airPurifier");
// Discovery retry backoff: start at the polling interval (never retry tighter
// than it), double up to a 15-minute cap. A RateLimitedError waits the full
// hour Coway's own error message asks for.
const DISCOVERY_RETRY_MAX_MS = 15 * 60 * 1000;
const DISCOVERY_RETRY_RATE_LIMITED_MS = 60 * 60 * 1000;
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
    // Devices already wired to an AirPurifierAccessory, by UUID. Guards against
    // double-wiring (double polling loops, doubled command handlers) when
    // discovery retries after a partial failure or Coway returns the same
    // device under two places.
    wired = new Set();
    discoveryRetryMs = 0; // set in the constructor from pollingInterval
    constructor(log, config, api) {
        this.log = log;
        this.config = config;
        this.api = api;
        this.Service = api.hap.Service;
        this.Characteristic = api.hap.Characteristic;
        // Schema enforces minimum 30s but config.json is hand-edited too. Clamp in
        // code so a misconfigured 0 (or anything below 30) can't tight-loop the
        // Coway API and rate-limit the account. Coerce through Number so a
        // hand-edited string like "abc" produces NaN, which we then replace with
        // the default — otherwise NaN * 1000 = NaN, and setInterval(fn, NaN)
        // coerces to ~1ms and hammers Coway.
        const rawPoll = Number(config?.pollingInterval);
        const pollSeconds = Number.isFinite(rawPoll) ? Math.max(30, rawPoll) : settings_1.DEFAULT_POLL_SECONDS;
        this.pollingInterval = pollSeconds * 1000;
        this.discoveryRetryMs = this.pollingInterval;
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
        // The CowayClient now owns the password. Drop our reference so a future
        // log of `platform.config` (debug helper, error inspector, etc.) doesn't
        // leak it.
        config.password = '';
        this.api.on('didFinishLaunching', () => this.runDiscovery());
    }
    /**
     * Run discovery, and on failure schedule a retry with backoff. Without the
     * retry, one transient failure at boot (the Pi comes up before the network,
     * a Coway 5xx wave, an auth blip) left cached accessories restored but
     * never wired: live-looking tiles whose reads served stale values and whose
     * writes silently did nothing until Homebridge was manually restarted.
     */
    runDiscovery() {
        this.discoverDevices().catch(err => {
            // Log only the message — bare Error objects from axios carry .config
            // and .request which include Authorization headers and the login
            // form body (with the password) in their string form.
            const msg = err instanceof Error ? err.message : String(err);
            const rateLimited = err instanceof auth_1.RateLimitedError;
            const delay = rateLimited ? DISCOVERY_RETRY_RATE_LIMITED_MS : this.discoveryRetryMs;
            if (!rateLimited) {
                this.discoveryRetryMs = Math.min(this.discoveryRetryMs * 2, DISCOVERY_RETRY_MAX_MS);
            }
            this.log.error(`Device discovery failed (retrying in ${Math.round(delay / 1000)}s):`, msg);
            setTimeout(() => this.runDiscovery(), delay);
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
        const liveUuids = new Set();
        for (const device of devices) {
            const uuid = this.api.hap.uuid.generate(device.deviceId);
            liveUuids.add(uuid);
            // Skip anything already wired: a duplicate row (same serial under two
            // places) or a discovery retry that partially succeeded last time.
            if (this.wired.has(uuid))
                continue;
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
                // Track it alongside the cache-restored accessories so a later pass
                // (retry, duplicate row) finds it instead of registering a twin UUID.
                this.accessories.push(accessory);
            }
            this.wired.add(uuid);
        }
        const stale = this.accessories.filter(a => !liveUuids.has(a.UUID));
        if (stale.length === 0) {
            return;
        }
        if (devices.length === 0) {
            // Zero devices while cached accessories exist is far more likely a
            // Coway-side glitch than the user removing every purifier from the
            // account — and unregistering is destructive (room assignments,
            // scenes, and automations go with the accessory). Keep them and let
            // the user remove truly-gone devices from the Homebridge UI.
            this.log.warn(`Coway returned zero purifiers but ${stale.length} cached accessory(ies) exist; ` +
                'leaving them registered. Remove them from the Homebridge UI if the devices are really gone.');
            return;
        }
        this.api.unregisterPlatformAccessories(settings_1.PLUGIN_NAME, settings_1.PLATFORM_NAME, stale);
        for (const gone of stale) {
            const idx = this.accessories.indexOf(gone);
            if (idx >= 0)
                this.accessories.splice(idx, 1);
        }
    }
}
exports.AirmegaPlatform = AirmegaPlatform;
//# sourceMappingURL=platform.js.map