# Changelog

All notable changes to `homebridge-airmega-iocare` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0-beta.5] — 2026-06-25

Discovery fix for accounts where a controllable purifier was never detected.

### Fixed
- Device discovery no longer skips a place when Coway reports `deviceCnt: 0` for it. Coway returns a zero count for some accounts that nonetheless own a controllable purifier (e.g. shared/guest devices, or a stale count), which left those users with no accessory despite the IoCare+ app working fine. The count is now advisory: every place's device list is fetched and the actual rows decide. Discovery-only, so this adds at most one request per empty place at startup. ([#6](https://github.com/jakemgold/homebridge-airmega-iocare/issues/6))

### Added
- Debug logging of the raw (redacted) per-place device list and each place's reported vs. actual device count, so empty-discovery reports can be diagnosed from logs without guesswork.

## [1.0.0-beta.4] — 2026-05-23

Per-model gating: removes HomeKit tiles that didn't correspond to real device capabilities. Verified against a live 400S; per-model behavior for 300S, MightyS, 250S, and IconS sourced from cowayaio docstrings, the home-assistant-iocare integration, and Coway's official 400S manual.

### Removed
- "PM2.5 Density" characteristic from the Air Quality tile on the 400S, 300S, and MightyS. Coway doesn't actually report PM2.5 on those models — the value had been a placeholder shown as "0μg/m³" indefinitely. The 250S keeps both PM2.5 and PM10; the IconS keeps only PM2.5.
- "Eco" and "Smart" preset switches on models where they don't correspond to user-controllable modes. MightyS keeps "Eco"; 250S keeps "Smart"; everything else gets only "Sleep".

### Fixed
- HomeKit no longer flips to Manual when the 400S (or any model where Eco is firmware-driven, i.e. not MightyS) automatically enters its Smart-Eco sub-state. It now correctly stays in Auto, matching what the physical device and IoCare+ app show.

### Changed
- Bumped `@typescript-eslint/*` from `^7` to `^8` to clear a typescript-estree compat warning the prepublish lint was emitting against TypeScript 5.9.x.

### Notes
- If you had HomeKit automations referencing the removed Eco, Smart, or PM2.5 tiles, those automations will silently stop firing after upgrading — quick audit recommended.
- Unknown-model fallback: an unrecognized `productModel` exposes only the AirQuality grade plus the Sleep preset, with a warn log including the model string so it can be added to the capability tables.

## [1.0.0-beta.3] — 2026-05-23

Reliability hardening from a Codex review of the Phase 2 work. No new features; existing behavior is more honest about failure cases.

### Fixed
- Command writes (power, fan speed, mode, light) now validate the HTTP status. Previously a 401/429/5xx was logged as "command sent" even though Coway had rejected it; now surfaces as a warning, with exponential backoff on transient errors and a one-shot 401 retry after token refresh. ([#1](https://github.com/jakemgold/homebridge-airmega-iocare/pull/1))
- Polling no longer queues overlapping refreshes if Coway is slow. An in-flight poll suppresses the next tick. ([#1](https://github.com/jakemgold/homebridge-airmega-iocare/pull/1))
- Hand-edited `pollingInterval` values like `"abc"` no longer produce `NaN` and tight-loop the API. Coerced through `Number` with fallback to the default. ([#1](https://github.com/jakemgold/homebridge-airmega-iocare/pull/1))
- When Coway returns no parseable state, HomeKit now keeps last-known values instead of synthesizing "filter at 100%" or "Air Quality Excellent". ([#1](https://github.com/jakemgold/homebridge-airmega-iocare/pull/1))
- Transient (429/5xx) failures on token refresh no longer escalate to a full Keycloak re-login. They bubble up and wait for the next poll. ([#2](https://github.com/jakemgold/homebridge-airmega-iocare/pull/2))

### Changed
- Error messages and the debug login log no longer leak access/refresh tokens, names, emails, phone numbers, or device serials. New `redactBody` / `maskEmail` helpers applied across the auth and client error paths. ([#2](https://github.com/jakemgold/homebridge-airmega-iocare/pull/2))
- CI no longer mutates the dependency graph during builds (`npm audit fix` removed); audit is now non-mutating and gated at high severity. Lockfile bumps come via Dependabot. ([#3](https://github.com/jakemgold/homebridge-airmega-iocare/pull/3))

## [1.0.0-beta.2] — 2026-04-29

### Added
- Device firmware revision (Coway's `currentMcuVer`) is now extracted from the HTML scrape and pushed to the `AccessoryInformation.FirmwareRevision` characteristic. Apple Home shows the real MCU version instead of `0.0.0`. Includes a numeric-format guard for the case Coway ever returns a non-dotted-decimal string.

## [1.0.0-beta.1] — 2026-04-28

First npm beta. Brings the prototype to a state where strangers can install it from `npm install -g homebridge-airmega-iocare` and have it work.

### Added
- Discovers all purifiers on the configured IoCare+ account via Coway's place + device endpoints.
- HomeKit services per purifier: AirPurifier (power, fan speed in 3 steps, Auto/Manual), AirQualitySensor (grade + PM2.5/PM10 densities), two FilterMaintenance services (Pre-filter, Max2), three mutually-exclusive preset Switches (Sleep, Eco, Smart), optional Display Light switch.
- 60s polling (configurable, minimum 30s) with exponential backoff on Coway 5xx and 429 responses.
- Debounced fan-speed writes so Apple Home's slider drags don't spam Coway.
- Strict layer separation between Coway protocol (`src/api/`) and HomeKit (`src/accessories/`).
- TLS host validation on URLs extracted from Coway's auth HTML; response-size caps; prototype-pollution-safe JSON parsing for the HTML scrape.
- Graceful handling of Coway's 60-day password-rotation prompt (warn and continue).
- Homebridge 1.8.x and 2.0-beta compatible.
