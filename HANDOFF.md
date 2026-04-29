# homebridge-airmega-iocare — Handoff Doc

A Homebridge plugin for the Coway Airmega 400S (and likely 300S/250S/MightyS/IconS) using the current IoCare+ API.

## Strategy: don't start from scratch

Three reference projects do most of our work for us. We're not reverse-engineering the API — we're translating from sources that already did.

**Authoritative API reference (current, Python):**
- `RobertD502/cowayaio` — standalone Python lib, v0.2.4 released Oct 15, 2025. This is the current IoCare+ API client. Ground truth for endpoints, auth flow, payload shapes, command codes.
  - https://github.com/RobertD502/cowayaio
- `RobertD502/home-assistant-iocare` — HA integration that consumes cowayaio. Useful for seeing how the API maps to user-facing concepts (fan speeds, modes, etc.). Confirmed working with 400S.
  - https://github.com/RobertD502/home-assistant-iocare

**Homebridge-specific scaffolding (TypeScript, structure to mimic):**
- `OrigamiDream/homebridge-coway` — TS Homebridge plugin, "v1.0.1 - New APIs" May 2024. Has the IoCare+ auth flow already in TS but only supports a Korean Marvel air purifier model. Steal the auth + plugin scaffolding, replace device logic.
  - https://github.com/OrigamiDream/homebridge-coway

**Plugin template (skeleton baseline):**
- https://github.com/homebridge/homebridge-plugin-template

The plan: scaffold from `homebridge-plugin-template`, port the auth + HTTP client from `OrigamiDream/homebridge-coway` (TS, already done), port the 400S device-state mapping and command codes from `RobertD502/cowayaio` (Python → TS), wire to HomeKit's standard `AirPurifier` + `AirQualitySensor` + `FilterMaintenance` services.

---

## Repo layout

```
homebridge-airmega-iocare/
├── package.json
├── tsconfig.json
├── config.schema.json          # drives the Homebridge UI config form
├── README.md
├── LICENSE                     # MIT
├── .eslintrc.json
├── .gitignore
├── .npmignore
└── src/
    ├── index.ts                # plugin entry — registers the platform
    ├── settings.ts             # PLATFORM_NAME, PLUGIN_NAME, constants
    ├── platform.ts             # DynamicPlatformPlugin — discovery + lifecycle
    ├── api/
    │   ├── cowayClient.ts      # IoCare+ HTTP client (port from cowayaio)
    │   ├── auth.ts             # OAuth-style login + token refresh
    │   ├── endpoints.ts        # URL + path constants
    │   └── types.ts            # TypeScript types for API responses
    └── accessories/
        ├── airPurifier.ts      # main HomeKit AirPurifier accessory
        ├── airQualitySensor.ts # PM2.5/PM10/AQI sensor
        ├── filterMaintenance.ts# pre-filter + Max2 filter life
        ├── presetSwitches.ts   # Sleep/Eco/Smart switches with mutual exclusion
        ├── lightSwitch.ts      # LED display on/off
        └── deviceCodes.ts      # Coway command/mode constants (port from cowayaio)
```

---

## HomeKit mapping

This is the spec for the accessory side. Each row = one Coway capability → one HomeKit characteristic.

| Coway capability               | HomeKit service        | Characteristic               | Notes |
|--------------------------------|------------------------|------------------------------|-------|
| Power on/off                   | AirPurifier            | Active                       | 0 = off, 1 = on |
| Current state (idle/running)   | AirPurifier            | CurrentAirPurifierState      | 0 inactive, 1 idle, 2 purifying |
| Auto vs Manual mode            | AirPurifier            | TargetAirPurifierState       | 0 manual, 1 auto |
| Fan speed (1–3, sometimes 1–6) | AirPurifier            | RotationSpeed                | Map Coway 1/2/3 → HomeKit 33/66/100 (or 16/33/50/66/83/100 for 6-speed) |
| Sleep preset                   | Switch (sub-service)   | On                           | Mutually exclusive with Eco/Smart switches; see "Preset switches" below |
| Eco preset                     | Switch (sub-service)   | On                           | Mutually exclusive with Sleep/Smart switches |
| Smart preset                   | Switch (sub-service)   | On                           | Mutually exclusive with Sleep/Eco switches |
| LED on/off                     | Switch (or Lightbulb)  | On                           | Per RobertD502 docs, light control only works when purifier is ON |
| Indoor air quality (Good/Moderate/Unhealthy/VeryUnhealthy) | AirQualitySensor | AirQuality | Map Coway 1/2/3/4 → 1/2/3/4/5 |
| PM2.5                          | AirQualitySensor       | PM2_5Density                 | µg/m³ |
| PM10                           | AirQualitySensor       | PM10Density                  | µg/m³ |
| Pre-filter life %              | FilterMaintenance      | FilterLifeLevel              | Also FilterChangeIndication = 1 when low |
| Max2 (HEPA) filter life %      | FilterMaintenance      | FilterLifeLevel              | Second filter — HomeKit only displays one in the tile, but both fire change alerts |

Polling: 60s default for state, configurable. Coway's API is not push.

### Preset switches (Sleep / Eco / Smart)

HomeKit has no native multi-state selector for arbitrary modes (Television's InputSource is the only labeled picker, and shoehorning an air purifier into a TV service is ugly). The clean pattern is three mutually exclusive `Switch` services bundled on the same `PlatformAccessory` as the `AirPurifier` — they appear as sub-tiles when the user taps into the Airmega in Apple Home.

Implementation rules:

1. **Bundle, don't separate.** Add all three switches via `accessory.addService(Switch, name, subtype)` on the existing accessory, using distinct subtypes (`'preset-sleep'`, `'preset-eco'`, `'preset-smart'`). Same accessory = sub-tile grouping in Home.
2. **Mutual exclusion on set.** When a switch's `On` is set to true, send the matching mode command to Coway, then `updateCharacteristic(On, false)` on the other two switch services synchronously. When set to false, do nothing if no other preset is being activated (the user explicitly turned the active preset off — fall back to whatever Coway defaults to, typically Manual).
3. **Polling reconciles state.** On each poll, set whichever switch matches `state.mode` to On and clear the other two. This handles changes made on the device or in the IoCare+ app.
4. **Auto/Manual stays separate.** The existing `TargetAirPurifierState` characteristic on the AirPurifier service still toggles Auto vs Manual. Sleep/Eco/Smart are distinct modes from Coway's perspective and shouldn't conflate.
5. **Naming.** Set the switch service's `Name` characteristic to "Sleep" / "Eco" / "Smart" (no prefix) — the parent accessory name supplies context, and Siri picks up "turn on Airmega Sleep" naturally.


---

## package.json

```json
{
  "displayName": "Homebridge Airmega 400S",
  "name": "homebridge-airmega-iocare",
  "version": "0.1.0",
  "description": "Homebridge plugin for the Coway Airmega 400S (and other IoCare+ purifiers)",
  "license": "MIT",
  "main": "dist/index.js",
  "engines": {
    "node": "^18.20.4 || ^20.15.1 || ^22",
    "homebridge": "^1.8.0 || ^2.0.0-beta.0"
  },
  "scripts": {
    "lint": "eslint src/**/*.ts",
    "watch": "npm run build && npm link && nodemon",
    "build": "rimraf ./dist && tsc",
    "prepare": "npm run build",
    "prepublishOnly": "npm run lint && npm run build"
  },
  "keywords": ["homebridge-plugin", "coway", "airmega", "iocare", "air-purifier"],
  "dependencies": {
    "axios": "^1.7.0"
  },
  "devDependencies": {
    "@types/node": "^20.11.0",
    "@typescript-eslint/eslint-plugin": "^7.0.0",
    "@typescript-eslint/parser": "^7.0.0",
    "eslint": "^8.57.0",
    "homebridge": "^1.8.0",
    "nodemon": "^3.1.0",
    "rimraf": "^5.0.5",
    "typescript": "^5.4.0"
  }
}
```

---

## tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "sourceMap": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

---

## config.schema.json (drives Homebridge UI)

```json
{
  "pluginAlias": "AirmegaPlatform",
  "pluginType": "platform",
  "singular": true,
  "schema": {
    "type": "object",
    "properties": {
      "name": {
        "title": "Name",
        "type": "string",
        "default": "Airmega",
        "required": true
      },
      "username": {
        "title": "IoCare+ Username (email)",
        "type": "string",
        "required": true
      },
      "password": {
        "title": "IoCare+ Password",
        "type": "string",
        "required": true,
        "x-schema-form": { "type": "password" }
      },
      "skipPasswordChange": {
        "title": "Skip 60-day password change prompt",
        "type": "boolean",
        "default": true,
        "description": "Coway forces password rotation every 60 days. Leave true to defer; set false to be re-prompted via reauth."
      },
      "pollingInterval": {
        "title": "Polling interval (seconds)",
        "type": "integer",
        "default": 60,
        "minimum": 30
      },
      "exposeLight": {
        "title": "Expose LED display as a switch",
        "type": "boolean",
        "default": true
      }
    }
  }
}
```

---

## src/settings.ts

```typescript
export const PLATFORM_NAME = 'AirmegaPlatform';
export const PLUGIN_NAME = 'homebridge-airmega-iocare';

// Models confirmed by RobertD502/home-assistant-iocare
export const SUPPORTED_MODELS = ['400S', '300S', '250S', 'MightyS', 'IconS'] as const;
export type ModelCode = typeof SUPPORTED_MODELS[number];

// Default polling
export const DEFAULT_POLL_SECONDS = 60;

// Coway forces password rotation every 60 days; the API returns a flag to defer
export const SKIP_PASSWORD_CHANGE_DEFAULT = true;
```

---

## src/index.ts

```typescript
import { API } from 'homebridge';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { AirmegaPlatform } from './platform';

export = (api: API) => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, AirmegaPlatform);
};
```

---

## src/platform.ts (skeleton)

```typescript
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
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;

  // Cached accessories restored from disk by Homebridge on launch
  public readonly accessories: PlatformAccessory[] = [];

  public readonly client: CowayClient;
  private readonly pollingInterval: number;

  constructor(
    public readonly log: Logger,
    public readonly config: AirmegaConfig,
    public readonly api: API,
  ) {
    if (!config?.username || !config?.password) {
      this.log.error('Username and password are required.');
      return;
    }

    this.pollingInterval = (config.pollingInterval ?? DEFAULT_POLL_SECONDS) * 1000;

    this.client = new CowayClient({
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

  // Called by Homebridge for each cached accessory at startup
  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info(`Loading cached accessory: ${accessory.displayName}`);
    this.accessories.push(accessory);
  }

  async discoverDevices(): Promise<void> {
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

    // Remove accessories that no longer exist
    const liveUuids = new Set(devices.map(d => this.api.hap.uuid.generate(d.deviceId)));
    const stale = this.accessories.filter(a => !liveUuids.has(a.UUID));
    if (stale.length > 0) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
    }
  }
}
```

---

## src/api/cowayClient.ts (skeleton — port logic from cowayaio)

```typescript
import axios, { AxiosInstance } from 'axios';
import { Logger } from 'homebridge';
import { performLogin, refreshAccessToken, AuthTokens } from './auth';
import { CowayDevice, DeviceState } from './types';

export interface CowayClientOptions {
  username: string;
  password: string;
  skipPasswordChange: boolean;
  log: Logger;
}

export class CowayClient {
  private http: AxiosInstance;
  private tokens?: AuthTokens;

  constructor(private readonly opts: CowayClientOptions) {
    this.http = axios.create({ timeout: 15000 });

    // Auto-attach bearer + refresh on 401
    this.http.interceptors.request.use(cfg => {
      if (this.tokens?.accessToken) {
        cfg.headers = cfg.headers ?? {};
        (cfg.headers as Record<string, string>).Authorization = `Bearer ${this.tokens.accessToken}`;
      }
      return cfg;
    });

    this.http.interceptors.response.use(
      r => r,
      async err => {
        if (err.response?.status === 401 && this.tokens?.refreshToken) {
          this.opts.log.debug('Access token expired, refreshing…');
          this.tokens = await refreshAccessToken(this.tokens.refreshToken);
          err.config.headers.Authorization = `Bearer ${this.tokens.accessToken}`;
          return this.http.request(err.config);
        }
        return Promise.reject(err);
      },
    );
  }

  async login(): Promise<void> {
    this.tokens = await performLogin({
      username: this.opts.username,
      password: this.opts.password,
      skipPasswordChange: this.opts.skipPasswordChange,
      log: this.opts.log,
    });
    this.opts.log.info('Logged in to Coway IoCare+');
  }

  // TODO: port from cowayaio — list user's registered devices.
  // Reference: cowayaio/coway_client.py — async_get_purifiers / get_devices
  async listDevices(): Promise<CowayDevice[]> {
    throw new Error('not implemented — port from cowayaio');
  }

  // TODO: port from cowayaio — fetch full state (mode, speed, AQI, filters, etc.)
  // Reference: cowayaio — async_fetch_all_data / async_get_full_status
  async getDeviceState(_deviceId: string): Promise<DeviceState> {
    throw new Error('not implemented — port from cowayaio');
  }

  // TODO: port from cowayaio — send a control command.
  // Coway uses a 'control' endpoint with a deviceType + command code + value.
  // Reference: cowayaio — async_set_power / async_set_fan_speed / async_set_mode / etc.
  async sendCommand(
    _deviceId: string,
    _command: string,
    _value: string | number,
  ): Promise<void> {
    throw new Error('not implemented — port from cowayaio');
  }
}
```

---

## src/api/auth.ts (skeleton)

The IoCare+ auth flow is OAuth-ish: username/password → access + refresh tokens. Coway uses an OIDC-style flow with a hardcoded client_id used by the official app. **Pull the exact endpoint URLs, client_id, and form field names from `OrigamiDream/homebridge-coway`'s auth implementation** (it's already in TS) and cross-check against `cowayaio` for any drift.

```typescript
import { Logger } from 'homebridge';

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
}

export interface LoginParams {
  username: string;
  password: string;
  skipPasswordChange: boolean;
  log: Logger;
}

export async function performLogin(_params: LoginParams): Promise<AuthTokens> {
  // TODO: implement.
  // Reference 1 (TS, current): OrigamiDream/homebridge-coway — homebridge/coway/auth.ts
  // Reference 2 (Python, current): RobertD502/cowayaio — cowayaio/coway_client.py
  //
  // High-level flow (verify against current source before implementing):
  //   1. GET an OAuth/OIDC authorization page to extract a state/CSRF/cookie.
  //   2. POST username + password to the login endpoint with that state.
  //   3. Follow the redirect to grab an authorization code.
  //   4. Exchange the code at the token endpoint for access + refresh tokens.
  //   5. If skipPasswordChange is true and the response indicates a 60-day
  //      change is due, POST the "skip" flag and continue.
  throw new Error('not implemented');
}

export async function refreshAccessToken(_refreshToken: string): Promise<AuthTokens> {
  // TODO: standard refresh_token grant against the Coway token endpoint.
  throw new Error('not implemented');
}
```

---

## src/api/types.ts (starter — expand from cowayaio)

```typescript
export interface CowayDevice {
  deviceId: string;       // Coway calls this barcode/dvcBrandCd in some payloads
  name: string;           // user-set nickname
  model: string;          // e.g. 'AIRMEGA 400S'
  modelCode: string;      // internal Coway code; used to dispatch command shapes
  serial?: string;
  firmwareVersion?: string;
}

export type AirQualityLevel = 1 | 2 | 3 | 4; // Good / Moderate / Unhealthy / Very Unhealthy

export interface DeviceState {
  power: boolean;
  mode: 'auto' | 'manual' | 'sleep' | 'eco' | 'smart';
  fanSpeed: 1 | 2 | 3 | 4 | 5 | 6;
  lightOn: boolean;
  airQuality: AirQualityLevel;
  pm25?: number;
  pm10?: number;
  preFilterPct: number;   // 0–100
  max2FilterPct: number;  // 0–100
  timerMinutesRemaining?: number;
}
```

---

## src/accessories/airPurifier.ts (skeleton)

```typescript
import {
  PlatformAccessory, Service, CharacteristicValue,
} from 'homebridge';
import { AirmegaPlatform } from '../platform';
import { DeviceState } from '../api/types';

export class AirPurifierAccessory {
  private purifierService: Service;
  private airQualityService: Service;
  private preFilterService: Service;
  private max2FilterService: Service;

  private state?: DeviceState;
  private pollHandle?: NodeJS.Timeout;

  constructor(
    private readonly platform: AirmegaPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly pollingInterval: number,
  ) {
    const device = accessory.context.device;
    const C = platform.Characteristic;
    const S = platform.Service;

    accessory.getService(S.AccessoryInformation)!
      .setCharacteristic(C.Manufacturer, 'Coway')
      .setCharacteristic(C.Model, device.model)
      .setCharacteristic(C.SerialNumber, device.serial ?? device.deviceId);

    this.purifierService = accessory.getService(S.AirPurifier)
      ?? accessory.addService(S.AirPurifier);

    this.purifierService.getCharacteristic(C.Active)
      .onGet(() => this.state?.power ? 1 : 0)
      .onSet(this.handleActiveSet.bind(this));

    this.purifierService.getCharacteristic(C.CurrentAirPurifierState)
      .onGet(() => this.state?.power ? 2 : 0); // 2 = purifying, 0 = inactive

    this.purifierService.getCharacteristic(C.TargetAirPurifierState)
      .onGet(() => this.state?.mode === 'auto' ? 1 : 0)
      .onSet(this.handleTargetStateSet.bind(this));

    this.purifierService.getCharacteristic(C.RotationSpeed)
      .setProps({ minStep: 100 / 3 }) // 3-speed Airmega; tune per model
      .onGet(() => this.fanSpeedToHomeKit(this.state?.fanSpeed ?? 1))
      .onSet(this.handleRotationSpeedSet.bind(this));

    this.airQualityService = accessory.getService(S.AirQualitySensor)
      ?? accessory.addService(S.AirQualitySensor);

    this.airQualityService.getCharacteristic(C.AirQuality)
      .onGet(() => this.state?.airQuality ?? 0);

    // Pre-filter and Max2 filter — separate FilterMaintenance services
    this.preFilterService = accessory.getServiceById(S.FilterMaintenance, 'pre')
      ?? accessory.addService(S.FilterMaintenance, 'Pre-filter', 'pre');
    this.max2FilterService = accessory.getServiceById(S.FilterMaintenance, 'max2')
      ?? accessory.addService(S.FilterMaintenance, 'Max2 Filter', 'max2');

    this.startPolling();
  }

  private fanSpeedToHomeKit(s: number): number {
    return Math.round((s / 3) * 100); // adjust if device exposes 6 speeds
  }
  private homeKitToFanSpeed(pct: number): 1 | 2 | 3 {
    if (pct <= 33) return 1;
    if (pct <= 66) return 2;
    return 3;
  }

  private async handleActiveSet(value: CharacteristicValue): Promise<void> {
    const deviceId = this.accessory.context.device.deviceId;
    await this.platform.client.sendCommand(deviceId, 'power', value === 1 ? 1 : 0);
    await this.refresh();
  }

  private async handleTargetStateSet(value: CharacteristicValue): Promise<void> {
    const deviceId = this.accessory.context.device.deviceId;
    await this.platform.client.sendCommand(deviceId, 'mode', value === 1 ? 'auto' : 'manual');
    await this.refresh();
  }

  private async handleRotationSpeedSet(value: CharacteristicValue): Promise<void> {
    const speed = this.homeKitToFanSpeed(value as number);
    const deviceId = this.accessory.context.device.deviceId;
    await this.platform.client.sendCommand(deviceId, 'fanSpeed', speed);
    await this.refresh();
  }

  private startPolling(): void {
    this.refresh().catch(e => this.platform.log.warn('initial refresh failed', e));
    this.pollHandle = setInterval(() => {
      this.refresh().catch(e => this.platform.log.debug('poll failed', e));
    }, this.pollingInterval);
  }

  private async refresh(): Promise<void> {
    const deviceId = this.accessory.context.device.deviceId;
    this.state = await this.platform.client.getDeviceState(deviceId);
    this.pushUpdates();
  }

  private pushUpdates(): void {
    if (!this.state) return;
    const C = this.platform.Characteristic;

    this.purifierService.updateCharacteristic(C.Active, this.state.power ? 1 : 0);
    this.purifierService.updateCharacteristic(
      C.CurrentAirPurifierState,
      this.state.power ? 2 : 0,
    );
    this.purifierService.updateCharacteristic(
      C.TargetAirPurifierState,
      this.state.mode === 'auto' ? 1 : 0,
    );
    this.purifierService.updateCharacteristic(
      C.RotationSpeed,
      this.fanSpeedToHomeKit(this.state.fanSpeed),
    );

    this.airQualityService.updateCharacteristic(C.AirQuality, this.state.airQuality);
    if (this.state.pm25 !== undefined) {
      this.airQualityService.updateCharacteristic(C.PM2_5Density, this.state.pm25);
    }
    if (this.state.pm10 !== undefined) {
      this.airQualityService.updateCharacteristic(C.PM10Density, this.state.pm10);
    }

    this.preFilterService.updateCharacteristic(C.FilterLifeLevel, this.state.preFilterPct);
    this.preFilterService.updateCharacteristic(
      C.FilterChangeIndication,
      this.state.preFilterPct < 10 ? 1 : 0,
    );
    this.max2FilterService.updateCharacteristic(C.FilterLifeLevel, this.state.max2FilterPct);
    this.max2FilterService.updateCharacteristic(
      C.FilterChangeIndication,
      this.state.max2FilterPct < 10 ? 1 : 0,
    );
  }
}
```

---

## Development workflow (Mac dev → Pi test)

If you can't run Claude Code on the same machine as Homebridge (typical: Pi running Homebridge, Mac running Claude Code), you don't need rsync. Push to GitHub and install on the Pi from the GitHub URL:

1. Develop and commit on the Mac. Push to GitHub.
2. On the Pi, open the Homebridge UI → top-right three-dots menu → **Terminal**.
3. Install (or reinstall to update):
   ```
   sudo npm install -g --unsafe-perm git+https://github.com/YOUR_USERNAME/homebridge-airmega-iocare.git
   ```
4. Restart Homebridge from the UI.

The `prepare` script in `package.json` builds the TypeScript at install time on the Pi, so you don't need to commit `dist/`. Add `dist/` to `.gitignore`.

To pin to a specific branch (e.g. a `dev` branch for testing):
```
sudo npm install -g --unsafe-perm git+https://github.com/YOUR_USERNAME/homebridge-airmega-iocare.git#dev
```

Once the plugin is stable, publish to npm and switch to the UI's built-in update button — but for the initial development loop, the GitHub-install route is the right path.

---

## Step-by-step plan for Claude Code

This ships in two phases. Phase 1 is "works for Jake personally." Phase 2 is "publishable." Stop between phases and confirm with Jake.

### Phase 1: Prototype

1. **Validate the API against Jake's account** before writing any plugin code. Coway changes their API without notice; if it's broken right now we're building on sand. Set up a Python venv on the Mac, install `cowayaio`, and run a small script to confirm login + device list works:

   ```bash
   python3 -m venv /tmp/coway-test
   source /tmp/coway-test/bin/activate
   pip install cowayaio
   ```

   Ask Jake to export his IoCare+ credentials as env vars for the duration of the test (don't write them to disk):
   ```bash
   export COWAY_USERNAME='...'
   export COWAY_PASSWORD='...'
   ```

   Write a short async script (`/tmp/coway-test/check.py`) that uses `cowayaio` to log in, list devices, and fetch one state poll. Print device count, model name, current mode, and AQI. If it works, we're good. If it 401s or returns weird shapes, stop and tell Jake — we may need to wait for `cowayaio` to catch up to a Coway API change. After the test, deactivate the venv and delete `/tmp/coway-test/`. Do not commit the test script or credentials anywhere.

2. **Bootstrap.** `git clone https://github.com/homebridge/homebridge-plugin-template homebridge-airmega-iocare && cd homebridge-airmega-iocare && rm -rf .git && git init`. Replace `package.json`, `tsconfig.json`, `config.schema.json` with the versions in this doc.

3. **Drop in the source skeletons.** Create `src/index.ts`, `src/settings.ts`, `src/platform.ts`, `src/api/{auth,cowayClient,types,endpoints}.ts`, `src/accessories/airPurifier.ts` from this doc. Confirm `npm install && npm run build` compiles cleanly before writing business logic.

4. **Port the auth layer.** Read `OrigamiDream/homebridge-coway` (TypeScript, already does IoCare+ auth). Lift the endpoint URLs, client_id, login flow, token refresh, and 60-day password skip handling into `src/api/auth.ts` and `src/api/endpoints.ts`. Cross-check against `RobertD502/cowayaio` — if the two disagree on any field name or URL, trust `cowayaio` since it's been updated more recently. **Watch for v0 HAP patterns** while porting (see "Homebridge 2.0 readiness" below) and modernize them as you go.

5. **Port device listing.** From `RobertD502/cowayaio/coway_client.py`, port `async_get_purifiers` (or whatever the current function is named) into `CowayClient.listDevices()`. Map the response shape into `CowayDevice`.

6. **Port state fetching.** Port the full-status fetcher (likely `async_fetch_all_data` or similar) into `CowayClient.getDeviceState()`. The Airmega 400S returns mode, fan speed, light state, AQI, PM values, and two filter percentages. Map raw codes to the `DeviceState` type.

7. **Port command sending.** Port the control function and the command codes (power, fanSpeed, mode, light). Coway uses small string/int codes — keep them in `src/accessories/deviceCodes.ts` so the mapping is one-stop.

8. **Wire HomeKit.** The `AirPurifierAccessory` skeleton handles power/mode/speed/AQI/filters. Add `presetSwitches.ts` implementing Sleep/Eco/Smart as three mutually exclusive `Switch` services bundled on the same accessory (see "Preset switches" above for the rules). Add `lightSwitch.ts` if `exposeLight` is true. No timer support in v1.

9. **Test against Jake's live 400S** via the GitHub-URL install workflow on his Pi. Validate: power toggle, mode switch, speed change, preset switches (mutual exclusion), AQI updates, filter percentages, light control. **Phase 1 ends here. Stop and confirm with Jake before starting Phase 2.**

### Phase 2: Public release (v1.0)

10. **Hardening.** Exponential backoff on 5xx and 429 responses. Debounce rapid characteristic sets (Home app spams these — coalesce to one Coway call within ~250ms). Graceful degradation on Coway downtime (don't crash, hold last known state, retry on next poll). Login retry on token expiration. Structured warning logged on the 60-day password rotation prompt.

11. **Cross-version validation.** Bounce Jake's Pi to a Homebridge 2.0-beta via the UI's "Install Alternate Version" button on the Homebridge tile. Confirm clean plugin load and operation. Drop back to 1.8.x if Jake prefers stability. No code changes should be needed if "Homebridge 2.0 readiness" rules were followed during the port — this is verification, not new work.

12. **README.** Install instructions (npm + Homebridge UI), config example, HomeKit tile screenshot, supported-models list, recommendation to enable child-bridge mode for fault isolation, and credits to `RobertD502/cowayaio`, `RobertD502/home-assistant-iocare`, and `OrigamiDream/homebridge-coway`.

13. **GitHub polish.** Issue templates (bug report + feature request), CONTRIBUTING note, MIT LICENSE file, semantic-version git tags matching npm releases.

14. **Publish to npm.** `npm publish` as `homebridge-airmega-iocare` (unscoped). Verify the plugin appears in Homebridge UI plugin search within ~10 minutes.

15. **Optional, post-release.** Apply for Homebridge Verified status by opening an issue at `homebridge/verified` after the plugin has accumulated some real-world usage and is stable.

---

## Homebridge 2.0 readiness

Homebridge 2.0 is in late beta and ships HAP-NodeJS v1, which has real breaking changes. Our `package.json` declares v2-ready via:

```json
"engines": {
  "homebridge": "^1.8.0 || ^2.0.0-beta.0"
}
```

That alone triggers the green readiness check in the Homebridge UI for users — but only if our code actually works on v2. The skeleton in this doc was written using modern API patterns and should run cleanly on both v1.8+ and v2.0-beta. The risk is in the **port from OrigamiDream/homebridge-coway** (last released May 2024, pre-stable v2), which may carry forward deprecated patterns. Flag and rewrite these as you port:

- **Enum imports.** Replace `Characteristic.Units`, `Characteristic.Formats`, `Characteristic.Perms` with `api.hap.Units`, `api.hap.Formats`, `api.hap.Perms`. The classic-style imports were removed in HAP-NodeJS v1.
- **Getting characteristic values.** `Characteristic.getValue()` is gone — use the `Characteristic.value` property.
- **Service lookup by subtype.** `Accessory.getServiceByUUIDAndSubType()` is gone — use `Accessory.getServiceById()`. Our skeleton already does this for the two FilterMaintenance services; carry the pattern forward consistently.
- **Setting primary service.** `Accessory.setPrimaryService(service)` is gone — call `service.setPrimaryService()` directly. If we mark the AirPurifier as primary so the preset switches group as sub-tiles, use the new form.
- **`BatteryService` → `Battery`.** Not relevant for us (no battery), but if any reference code touches it, modernize.
- **`updateReachability()`.** Removed entirely. Reachability isn't a thing in HomeKit anymore. Strip any calls that show up in ported code.

**Test on both versions before publishing.** Easiest path: have your Pi on Homebridge 1.x for the initial dev loop, then bump it to a 2.0 beta via the UI's "Install Alternate Version" button on the Homebridge tile, restart, and verify the plugin still loads cleanly. If it does, leave the Pi on 2.0; if it crashes, drop back to 1.x and fix.

The full breaking-change list lives at https://github.com/homebridge/homebridge/wiki/Updating-To-Homebridge-v2.0.

---

## Known gotchas

- **Child bridge mode is strongly recommended.** When Jake installs the plugin, the Homebridge UI offers a "Bridge Settings" → "Child Bridge" toggle on the plugin tile. Turn it on. It runs the plugin in its own process so a Coway API outage or a plugin crash can't take down the rest of HomeKit. Without it, an Airmega plugin failure restart-loops the entire bridge — every accessory tied to Homebridge goes "no response" until the loop resolves. The README should call this out for users.
- **Rate limiting is undocumented and real.** Coway's API has no published rate limits but they exist. During development it's easy to hammer the API with rapid login attempts or polling spikes and get the account temporarily locked. Implement exponential backoff on 5xx and 429 responses from day one. Never retry tighter than the polling interval. Cap retries at ~5 before surfacing a warn-level log and waiting for the next natural poll.

- **60-day password rotation.** Coway forces a password change every 60 days. The `skipPasswordChange` flag defers it but eventually you have to change it in the IoCare+ app and reauth. Surface this as a Homebridge log warning when you detect the prompt in a login response.
- **One filter shown at a time in Home.** HomeKit only displays one `FilterMaintenance` service in the accessory tile. Both fire change alerts, so functionally it's fine — note this in the README.
- **Light control requires the purifier to be on.** Per RobertD502's docs, sending a light command while powered off is a no-op or errors. Guard the setter.
- **Polling, not push.** Coway's API is poll-only. 60s default is a reasonable balance; don't go below 30s or you'll get rate-limited.
- **Coway can break the API again.** That's why this plugin exists. Keep the API layer (`src/api/*`) cleanly separated from the HomeKit layer (`src/accessories/*`) so a future API shift only touches one folder.
