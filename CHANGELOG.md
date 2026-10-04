# Changelog

All notable changes to `homebridge-airmega-iocare` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.1] — 2026-10-04

Fixes for two changes Coway made to its service, support for two more model variants, and a few reliability improvements. No configuration changes are needed.

### Fixed
- The purifier's status updates again. In mid-September Coway rebuilt the web page the plugin reads status from, and every refresh since then failed with "could not extract purifier state from HTML", leaving Apple Home stuck on the last known state. The plugin now reads the new page format.
- Logging in works for accounts Coway isn't currently asking to change their password. Coway moved those accounts to a new sign-in flow in early October, and the plugin now uses it. Accounts that see the 60-day password reminder keep using the existing flow.
- The Airmega 300S reporting model code `AP-1515G` and the 250S reporting `AP-1720G` are now recognized, so they get the same controls and sensors as the rest of their families instead of a reduced fallback set. ([#8](https://github.com/jakemgold/homebridge-airmega-iocare/issues/8), [#9](https://github.com/jakemgold/homebridge-airmega-iocare/issues/9))
- When Coway rate-limits the account, the plugin now pauses status updates for an hour. It used to keep checking every minute, which Coway says prolongs the block.
- A command that fails (for example, while Coway is down) now logs one clear line instead of a stack trace, and Apple Home reports that the control didn't respond.

### Changed
- The plugin now identifies itself to Coway by its own name. It previously borrowed the identifier of the library behind the Home Assistant integration, which Coway uses to recognize Home Assistant traffic.
- Coway's status page no longer reports the purifier's firmware version, so the firmware shown in Apple Home stays at its last known value.
- The README and setup screen now explain that after changing your Coway password, you also need to update it in the plugin settings.

### Security
- Updated axios, the library the plugin uses to talk to Coway, to 1.20.0 for a batch of security advisories. Existing installs pick up the update along with this version.

## [1.1.0] — 2026-07-05

A reliability release. A deep review of the whole plugin turned up a batch of real bugs; this release fixes them and makes the plugin a better citizen of Coway's servers. No configuration changes are needed.

### Fixed
- The fan slider now sets the speed it shows. Each notch used to land one speed too high, and speed 1 couldn't be selected from the slider at all. Sliding to zero now simply turns the unit off instead of also firing a stray speed command.
- Quick sequences no longer fight each other. Picking Sleep (or Auto, or Off) right after moving the slider used to let the leftover speed command knock the unit back out of the mode you just chose, and a background refresh could briefly flip the app back to the old state after any change.
- Turning the unit on shows it running right away instead of sticking on "Starting…".
- A Coway server glitch can no longer remove the purifier from your Home setup, which also destroyed its room assignment and automations. A failed startup now keeps retrying instead of leaving a dead tile until the next reboot.
- Fixed a token-refresh race that forced a needless full re-login roughly every hour. When Coway rate-limits the account, the plugin now backs off immediately instead of retrying in a burst that made things worse.
- Login now rides out transient Coway server errors, and skipping the 60-day password reminder works reliably (verified against a live account inside the reminder window).
- Missing sensor readings no longer show up as perfectly clean air or 100% filter life. If Coway's status feed changes shape, the plugin keeps the last known state and says so in the log instead of silently showing the purifier as off.
- The Display Light switch is hidden on the 250S and IconS. Those models use inverted light values, so the switch did the opposite of what it said. The 400S, 300S, and MightyS are unaffected.

### Changed
- Air quality now reads on Coway's own severity scale: the four grades map to Excellent, Fair, Inferior, and Poor. Coway's "Unhealthy" used to display as a reassuring "Fair". If you have automations keyed on air quality, they'll trigger one step sooner than before.
- Filter life is refreshed every 30 minutes instead of on every poll (it changes over days, not minutes), roughly halving the plugin's traffic to Coway.
- If polling fails repeatedly, the log now says so plainly instead of staying quiet.

## [1.0.1] — 2026-06-30

Config-schema fix required for Homebridge Verified. No functional or runtime change.

### Fixed
- `config.schema.json` now declares its mandatory fields with a top-level `required` array (`["name", "username", "password"]`) instead of the non-standard per-field `"required": true`. The per-field boolean is invalid JSON Schema and failed the Homebridge Verified config-schema check; the Homebridge UI already treated these fields as required, so behavior is unchanged. ([homebridge/plugins#1100](https://github.com/homebridge/plugins/issues/1100))

## [1.0.0] — 2026-06-28

First stable release. Functionally identical to beta.6, promoted after a dogfooding period and two externally reported issues (empty device discovery and the one-way Sleep switch), both resolved. The plugin is verified live on an Airmega 400S and targets Coway's current IoCare+ API.

### Highlights across the 1.0.0 line
- Full Apple Home control of the Airmega 400S: power, three-step fan speed, Auto/Manual, the Sleep preset, Display Light, air-quality grade, PM10, and both filter indicators, with per-model gating for the 300S, 250S, MightyS, and IconS.
- Resilient by design: exponential backoff on 5xx/429, debounced setters, graceful degradation when Coway is unreachable, and redaction of sensitive data from logs.
- Runs on Homebridge 1.8.x and 2.x.

## [1.0.0-beta.6] — 2026-06-28

Fixes a one-way preset switch and brings the README in line with per-model behavior.

### Fixed
- Turning a preset switch (e.g. **Sleep**) **off** in Apple Home now returns the unit to **Auto**. Previously this was a no-op — a leftover from when three mutually-exclusive presets existed, where an "off" was always followed by another preset's "on". After the beta.4 per-model gating, most models (including the 400S) expose a single preset switch, so the switch could be turned on but never off, stranding the unit in the preset until the fan-mode picker was used. The exit is deferred and guarded so the 250S's Sleep/Smart swap still doesn't fire a stray Auto. ([#7](https://github.com/jakemgold/homebridge-airmega-iocare/issues/7))

### Documentation
- README now documents presets and particulate sensors **per model** (the 400S exposes only the Sleep preset and PM10; "Smart"/"Eco" are firmware-driven Auto sub-states, not switches), and clarifies that Apple Home renders the mode picker as Off / Manual / Auto. The old "Sleep / Eco / Smart, mutually exclusive" description predated the beta.4 per-model gating. ([#7](https://github.com/jakemgold/homebridge-airmega-iocare/issues/7))

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
