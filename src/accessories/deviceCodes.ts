// Per-model capability tables live here. The Coway protocol vocabulary
// (register codes, mode/power/light values) lives in src/api/endpoints.ts —
// ONE table serves both the command path and the status-read path, so the
// two directions can't drift.
// Source: ported from RobertD502/cowayaio (Python) and
// RobertD502/home-assistant-iocare's per-model gating.
// Verified live for the 400S during Phase 1 task 1 — see HANDOFF.md notes.

/**
 * Per-model Display Light switch availability.
 *
 * On the 400S family the 0007 register is a plain binary (0=off, 2=on). On
 * the 250S and IconS the same register is multi-mode with inverted values:
 * cowayaio's LightMode enum for those models is ON='0', AQI_OFF='1',
 * OFF='2', HALF_OFF='3' (IconS only). Sending our 400S "on" value ('2') to a
 * 250S turns the light OFF, and reading `=== 2` as "on" inverts the switch
 * state — home-assistant-iocare hides its plain light switch for exactly
 * these two models and exposes a multi-mode select instead. HomeKit has no
 * clean select primitive on a purifier tile, so we hide the switch on those
 * models rather than ship an inverted control.
 */
export const LIGHT_SWITCH_MODELS: Record<string, boolean> = {
  // Verified
  'AP-2015E':   true,  // Airmega 400S
  // Unverified — per cowayaio's plain async_set_light ("NOT used for 250s")
  'AP-1521E':   true,  // Airmega 300S
  'AP-1515G':   true,  // Airmega 300S variant (issue #8)
  'AP-1512HHS': true,  // Airmega MightyS
  'AP-1719A':   false, // Airmega 250S — inverted multi-mode register
  'AP-1720G':   false, // Airmega 250S variant (issue #9) — inverted multi-mode register
  'AP-1722B':   false, // Airmega IconS — inverted multi-mode register
};

// Conservative default for an unrecognized productModel: hide the switch.
// A missing control is an inconvenience; an inverted one actively lies.
export const LIGHT_SWITCH_UNKNOWN = false;

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
  'AP-1515G':   { pm10: true,  pm25: false }, // Airmega 300S variant (issue #8)
  'AP-1512HHS': { pm10: true,  pm25: false }, // Airmega MightyS
  'AP-1719A':   { pm10: true,  pm25: true  }, // Airmega 250S
  'AP-1720G':   { pm10: true,  pm25: true  }, // Airmega 250S variant (issue #9)
  'AP-1722B':   { pm10: false, pm25: true  }, // Airmega IconS
};

// Conservative default for an unrecognized productModel: expose nothing
// PM-related, since pushing fake densities is worse than pushing nothing
// (HomeKit still gets the AirQuality grade, which is universal).
export const PM_CAPABILITIES_UNKNOWN: PmCapabilities = { pm10: false, pm25: false };

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
  sleep: boolean;  // mode=2 user-settable
  eco: boolean;    // mode=6 user-settable (vs. firmware-driven Auto sub-state)
  smart: boolean;  // mode=5 (Rapid) user-settable
}

export const PRESET_CAPABILITIES: Record<string, PresetCapabilities> = {
  // Verified
  'AP-2015E':   { sleep: true,  eco: false, smart: false }, // Airmega 400S
  // Unverified — per cowayaio docstrings + HA's per-model gating
  'AP-1521E':   { sleep: true,  eco: false, smart: false }, // Airmega 300S
  'AP-1515G':   { sleep: true,  eco: false, smart: false }, // Airmega 300S variant (issue #8)
  'AP-1512HHS': { sleep: false, eco: true,  smart: false }, // Airmega MightyS
  'AP-1719A':   { sleep: true,  eco: false, smart: true  }, // Airmega 250S
  'AP-1720G':   { sleep: true,  eco: false, smart: true  }, // Airmega 250S variant (issue #9)
  'AP-1722B':   { sleep: true,  eco: false, smart: false }, // Airmega IconS
};

// Conservative default for an unrecognized productModel: expose only Sleep
// (the most widely supported preset). Better to under-expose than to register
// a non-functional switch that the user can press to no effect.
export const PRESET_CAPABILITIES_UNKNOWN: PresetCapabilities = {
  sleep: true, eco: false, smart: false,
};
