"use strict";
// All Coway control-command codes and value mappings live here.
// Source: ported from RobertD502/cowayaio (Python).
// Verified live for the 400S during Phase 1 task 1 — see HANDOFF.md notes.
//
// Coway addresses each control via a hex-string "attribute" key. The control endpoint
// accepts {attributes: {<key>: <value>}, ...}. Values are strings (some endpoints
// accept raw ints — check while porting).
Object.defineProperty(exports, "__esModule", { value: true });
exports.PREFILTER_CYCLE = exports.LightMode = exports.ModeValue = exports.Attribute = void 0;
exports.Attribute = {
    POWER: '0001', // '1' on, '0' off
    MODE: '0002', // 1=auto, 2=night/sleep, 5=rapid (250s), 6=eco
    FAN_SPEED: '0003', // '1' | '2' | '3'
    LIGHT: '0007', // 0=off, 2=on (400S binary). 250s/IconS support more values via LightMode.
    TIMER: '0008', // minutes: 0 | 60 | 120 | 240 | 480
    BUTTON_LOCK: '0024', // 0=off, 1=on
    SMART_SENSITIVITY: '000A', // 1=sensitive, 2=moderate, 3=insensitive
};
// Mode register (0x0002) values, keyed by cowayaio's naming:
exports.ModeValue = {
    AUTO: '1',
    NIGHT: '2', // surfaced as the "Sleep" preset switch in HomeKit
    RAPID: '5', // 250S only — surfaced as the "Smart" preset switch where supported
    ECO: '6', // surfaced as the "Eco" preset switch in HomeKit
};
// Light register (0x0007) values for models that support more than on/off.
exports.LightMode = {
    OFF: '0',
    ON: '2',
    // 250S/IconS may support additional modes — fill in when porting from cowayaio constants.
};
// Pre-filter wash-cycle frequency values (0x0001 on the control-param endpoint).
// Index is the "weeks" exposed in the IoCare+ app (2, 3, or 4).
// Out of scope for v1 but kept here so the porting target is one file.
exports.PREFILTER_CYCLE = {
    2: '1',
    3: '2',
    4: '3',
};
//# sourceMappingURL=deviceCodes.js.map