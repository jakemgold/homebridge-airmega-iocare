"use strict";
// Per-model capability tables live here. The Coway protocol vocabulary
// (register codes, mode/power/light values) lives in src/api/endpoints.ts —
// ONE table serves both the command path and the status-read path, so the
// two directions can't drift.
// Source: ported from RobertD502/cowayaio (Python) and
// RobertD502/home-assistant-iocare's per-model gating.
// Verified live for the 400S during Phase 1 task 1 — see HANDOFF.md notes.
Object.defineProperty(exports, "__esModule", { value: true });
exports.PRESET_CAPABILITIES_UNKNOWN = exports.PRESET_CAPABILITIES = exports.PM_CAPABILITIES_UNKNOWN = exports.PM_CAPABILITIES = exports.LIGHT_SWITCH_UNKNOWN = exports.LIGHT_SWITCH_MODELS = void 0;
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
exports.LIGHT_SWITCH_MODELS = {
    // Verified
    'AP-2015E': true, // Airmega 400S
    // Unverified — per cowayaio's plain async_set_light ("NOT used for 250s")
    'AP-1521E': true, // Airmega 300S
    'AP-1515G': true, // Airmega 300S variant (issue #8)
    'AP-1512HHS': true, // Airmega MightyS
    'AP-1719A': false, // Airmega 250S — inverted multi-mode register
    'AP-1720G': false, // Airmega 250S variant (issue #9) — inverted multi-mode register
    'AP-1722B': false, // Airmega IconS — inverted multi-mode register
};
// Conservative default for an unrecognized productModel: hide the switch.
// A missing control is an inconvenience; an inverted one actively lies.
exports.LIGHT_SWITCH_UNKNOWN = false;
exports.PM_CAPABILITIES = {
    // Verified
    'AP-2015E': { pm10: true, pm25: false }, // Airmega 400S
    // Unverified — sourced from HA's documented per-model availability
    'AP-1521E': { pm10: true, pm25: false }, // Airmega 300S
    'AP-1515G': { pm10: true, pm25: false }, // Airmega 300S variant (issue #8)
    'AP-1512HHS': { pm10: true, pm25: false }, // Airmega MightyS
    'AP-1719A': { pm10: true, pm25: true }, // Airmega 250S
    'AP-1720G': { pm10: true, pm25: true }, // Airmega 250S variant (issue #9)
    'AP-1722B': { pm10: false, pm25: true }, // Airmega IconS
};
// Conservative default for an unrecognized productModel: expose nothing
// PM-related, since pushing fake densities is worse than pushing nothing
// (HomeKit still gets the AirQuality grade, which is universal).
exports.PM_CAPABILITIES_UNKNOWN = { pm10: false, pm25: false };
exports.PRESET_CAPABILITIES = {
    // Verified
    'AP-2015E': { sleep: true, eco: false, smart: false }, // Airmega 400S
    // Unverified — per cowayaio docstrings + HA's per-model gating
    'AP-1521E': { sleep: true, eco: false, smart: false }, // Airmega 300S
    'AP-1515G': { sleep: true, eco: false, smart: false }, // Airmega 300S variant (issue #8)
    'AP-1512HHS': { sleep: false, eco: true, smart: false }, // Airmega MightyS
    'AP-1719A': { sleep: true, eco: false, smart: true }, // Airmega 250S
    'AP-1720G': { sleep: true, eco: false, smart: true }, // Airmega 250S variant (issue #9)
    'AP-1722B': { sleep: true, eco: false, smart: false }, // Airmega IconS
};
// Conservative default for an unrecognized productModel: expose only Sleep
// (the most widely supported preset). Better to under-expose than to register
// a non-functional switch that the user can press to no effect.
exports.PRESET_CAPABILITIES_UNKNOWN = {
    sleep: true, eco: false, smart: false,
};
//# sourceMappingURL=deviceCodes.js.map