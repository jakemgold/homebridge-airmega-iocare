export declare const Attribute: {
    readonly POWER: "0001";
    readonly MODE: "0002";
    readonly FAN_SPEED: "0003";
    readonly LIGHT: "0007";
    readonly TIMER: "0008";
    readonly BUTTON_LOCK: "0024";
    readonly SMART_SENSITIVITY: "000A";
};
export declare const ModeValue: {
    readonly AUTO: "1";
    readonly NIGHT: "2";
    readonly RAPID: "5";
    readonly ECO: "6";
};
export declare const LightMode: {
    readonly OFF: "0";
    readonly ON: "2";
};
export declare const PREFILTER_CYCLE: Record<number, string>;
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
export declare const PM_CAPABILITIES: Record<string, PmCapabilities>;
export declare const PM_CAPABILITIES_UNKNOWN: PmCapabilities;
