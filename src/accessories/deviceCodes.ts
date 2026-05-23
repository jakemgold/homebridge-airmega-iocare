// All Coway control-command codes and value mappings live here.
// Source: ported from RobertD502/cowayaio (Python).
// Verified live for the 400S during Phase 1 task 1 — see HANDOFF.md notes.
//
// Coway addresses each control via a hex-string "attribute" key. The control endpoint
// accepts {attributes: {<key>: <value>}, ...}. Values are strings (some endpoints
// accept raw ints — check while porting).

export const Attribute = {
  POWER: '0001',          // '1' on, '0' off
  MODE: '0002',           // 1=auto, 2=night/sleep, 5=rapid (250s), 6=eco
  FAN_SPEED: '0003',      // '1' | '2' | '3'
  LIGHT: '0007',          // 0=off, 2=on (400S binary). 250s/IconS support more values via LightMode.
  TIMER: '0008',          // minutes: 0 | 60 | 120 | 240 | 480
  BUTTON_LOCK: '0024',    // 0=off, 1=on
  SMART_SENSITIVITY: '000A', // 1=sensitive, 2=moderate, 3=insensitive
} as const;

// Mode register (0x0002) values, keyed by cowayaio's naming:
export const ModeValue = {
  AUTO: '1',
  NIGHT: '2',   // surfaced as the "Sleep" preset switch in HomeKit
  RAPID: '5',   // 250S only — surfaced as the "Smart" preset switch where supported
  ECO: '6',     // surfaced as the "Eco" preset switch in HomeKit
} as const;

// Light register (0x0007) values for models that support more than on/off.
export const LightMode = {
  OFF: '0',
  ON: '2',
  // 250S/IconS may support additional modes — fill in when porting from cowayaio constants.
} as const;

// Pre-filter wash-cycle frequency values (0x0001 on the control-param endpoint).
// Index is the "weeks" exposed in the IoCare+ app (2, 3, or 4).
// Out of scope for v1 but kept here so the porting target is one file.
export const PREFILTER_CYCLE: Record<number, string> = {
  2: '1',
  3: '2',
  4: '3',
};

/**
 * Per-model PM sensor availability for the Airmega family.
 *
 * The IoCare+ API exposes PM2.5 and PM10 differently depending on the model.
 * Some models report only PM10 (the AIRMEGA family), others only PM2.5 (IconS),
 * and one model (250S) reports both. Mapping is sourced from the
 * home-assistant-iocare README and `sensor.py` gating, plus a live API probe
 * against a 400S that confirmed the 400S row.
 *
 * Verified live: AP-2015E (400S). The 400S response has no `'0001'` sensor key
 * at all; `PM25_IDX` is present but always 0 — i.e. it's a placeholder, not a
 * real reading. PM10 lives at `'0002'` and reflects the device's actual sensor.
 *
 * Unverified rows come from HA's documentation. If your purifier is listed
 * here but the productModel string doesn't match what Coway returns for it,
 * please open an issue with the actual `productModel` value from your logs.
 */
export interface PmCapabilities {
  pm10: boolean;
  pm25: boolean;
}

export const PM_CAPABILITIES: Record<string, PmCapabilities> = {
  // Verified
  'AP-2015E':   { pm10: true,  pm25: false }, // Airmega 400S
  // Unverified — sourced from HA's documented per-model availability
  'AP-1521E':   { pm10: true,  pm25: false }, // Airmega 300S
  'AP-1512HHS': { pm10: true,  pm25: false }, // Airmega MightyS
  'AP-1719A':   { pm10: true,  pm25: true  }, // Airmega 250S
  'AP-1722B':   { pm10: false, pm25: true  }, // Airmega IconS
};

// Conservative default for an unrecognized productModel: expose nothing
// PM-related, since pushing fake densities is worse than pushing nothing
// (HomeKit still gets the AirQuality grade, which is universal).
export const PM_CAPABILITIES_UNKNOWN: PmCapabilities = { pm10: false, pm25: false };
