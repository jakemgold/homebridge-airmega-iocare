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
/**
 * Per-model user-selectable preset availability.
 *
 * Coway exposes more mode register values (0x0002) than any single model
 * actually lets the user set:
 *   1 = Smart (Auto)        — every model
 *   2 = Sleep / Night       — 400S, 300S, 250S, IconS
 *   5 = Rapid               — 250S only (cowayaio: async_set_rapid_mode docstring)
 *   6 = Smart-Eco           — MightyS only as a user preset
 *                             (firmware-driven Auto sub-state on others)
 *
 * Sources triangulated for these rows:
 *   - cowayaio's `async_set_eco_mode` / `async_set_rapid_mode` docstrings
 *     explicitly say which models each command targets.
 *   - home-assistant-iocare's `fan.py:108-122` per-model preset_modes branch.
 *   - Coway's official 400S user manual: Eco and Sleep within Smart Mode
 *     activate AUTOMATICALLY (firmware-driven sub-states), not via buttons.
 *     The user can pick Sleep separately from Manual Mode (= our mode=2).
 *
 * Verified entries are confirmed by live probe / direct ownership. The
 * 400S row is verified; the others mirror the references above.
 *
 * MightyS doesn't get a Sleep preset because Eco is its quiet mode — the
 * model doesn't expose Night separately, per HA's `PRESET_MODES_AP`.
 */
export interface PresetCapabilities {
    sleep: boolean;
    eco: boolean;
    smart: boolean;
}
export declare const PRESET_CAPABILITIES: Record<string, PresetCapabilities>;
export declare const PRESET_CAPABILITIES_UNKNOWN: PresetCapabilities;
