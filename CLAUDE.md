# Claude Code project context

## Goal
Build `homebridge-airmega-iocare` — a Homebridge plugin that exposes the Coway Airmega 400S to Apple HomeKit via Coway's current IoCare+ API. The 400S is the primary target; code paths should also work for 300S, 250S, MightyS, and IconS, since the API is shared.

## Read these in order before writing code
1. `HANDOFF.md` (root of this repo) — full plan, file structure, starter code, porting steps, gotchas. Treat as the spec.
2. `../cowayaio/cowayaio/coway_client.py` — current Python implementation of the IoCare+ API (RobertD502, v0.2.4 Oct 2025). Source of truth for endpoints, request/response shapes, and command codes.
3. `../homebridge-coway/homebridge/coway/` (TypeScript) — OrigamiDream's plugin. Lift the auth flow directly; the device logic is for a different model and is not relevant.
4. `../home-assistant-iocare/custom_components/coway/` — HA integration that consumes cowayaio. Useful for seeing how raw API state maps to user-facing labels (modes, AQI levels, etc.).

If those sibling repos aren't present, clone them first. They are read-only references — never modify them.

## Architectural decisions (do not relitigate)
- **Three mutually exclusive Switch services** for Sleep/Eco/Smart presets, bundled on the same AirPurifier accessory (sub-tiles in the Home app). Not slider positions. Not a TV service hack. Not a single fake mode characteristic.
- **No timer support in v1.** HomeKit has no clean primitive for it and the Coway timer is a convenience, not a core control.
- **Polling only**, 60s default, configurable, minimum 30s. Coway's API has no push mechanism.
- **Strict layer separation:** `src/api/` owns the Coway protocol; `src/accessories/` owns HomeKit. A future Coway API break should only require touching `src/api/`. Don't leak Coway field names or magic strings into the accessory layer.
- **Dynamic platform plugin**, not accessory plugin. Discover all devices on the user's IoCare+ account from one config block.
- **HAP services bundled on one accessory**, not split across multiple. The user sees one Airmega tile with sub-controls.

## Conventions
- TypeScript strict mode. No `any` without a `// eslint-disable-next-line` and a comment explaining why.
- Async/await throughout. No callbacks, no `.then()` chains.
- All Coway magic strings (endpoint URLs, command codes, mode names) live in `src/api/endpoints.ts` and `src/accessories/deviceCodes.ts`. Nothing hardcoded inline.
- One HomeKit service type per file in `src/accessories/`.
- Log levels: `info` for lifecycle (login success, device discovered, registered N accessories), `debug` for poll cycles and command sends, `warn` for recoverable API failures, `error` only when something is genuinely broken and user-visible.
- Confident language in comments and logs ("we think" not "we believe", per Jake's preference).
- **Defensive networking from day one.** Exponential backoff on 5xx and 429 responses. Never retry tighter than the polling interval. Coway's API isn't documented and they could rate-limit aggressively during debugging — getting locked out of the account mid-development is a real risk to design against, not retrofit later.
- **Run as a child bridge by default.** When Jake installs the plugin on his Pi, recommend (in the README) enabling the child-bridge option in the Homebridge UI for this plugin. It isolates plugin failures from the rest of HomeKit so a Coway API outage doesn't restart-loop the whole bridge and take down unrelated accessories. This is a config choice the user makes, not something the plugin enforces, but it's worth calling out.

## Phases

This project ships in two phases, with a checkpoint between them.

### Phase 1: Prototype (works for Jake)

The bar is "Jake can use it personally." No npm publish, no public-facing polish, no exhaustive cross-version testing.

1. **Validate the API against Jake's account.** Before writing a single line of plugin code, confirm Coway's IoCare+ API still works as `cowayaio` expects. Set up a temporary Python venv on the Mac, install `cowayaio`, and run a small script that logs in and lists devices. If it 401s or returns unexpected shapes, stop and tell Jake — Coway may have shifted the API again and we'd be building on sand. If it returns his 400S cleanly, proceed. Steps:
   ```
   python3 -m venv /tmp/coway-test
   source /tmp/coway-test/bin/activate
   pip install cowayaio
   ```
   Then write a small async script that uses `COWAY_USERNAME` and `COWAY_PASSWORD` env vars Jake exports for the duration of the test. The script should print device count, model name, and a single state poll. Delete the venv and script when done; don't commit either, don't store credentials.
2. Verify the three reference repos exist as siblings of this project. Clone any that don't (URLs in this file).
3. Bootstrap from `homebridge/homebridge-plugin-template`. Replace `package.json`, `tsconfig.json`, `config.schema.json` with the versions in `HANDOFF.md`.
4. Create the `src/` skeleton from `HANDOFF.md`. Get `npm install && npm run build` to compile cleanly before writing any business logic.
5. Port `auth.ts` from `../homebridge-coway/homebridge/coway/`. Verify a successful login against Jake's IoCare+ account. Log access token receipt and device list.
6. Port device listing, state fetching, and command sending from `cowayaio`.
7. Wire HomeKit — AirPurifier service, AirQualitySensor, two FilterMaintenance services, three preset Switches with mutual exclusion, optional LED switch.
8. Install on Jake's Pi via the GitHub-URL workflow. Confirm in his Apple Home app: power, fan speed, modes, presets, AQI, filter life, light. **Phase 1 is done when Jake says "this works for daily use." Stop and confirm before starting Phase 2.**

### Phase 2: Public release (v1.0)

The bar is "strangers on the internet can install this and have it work."

9. Harden the runtime: exponential backoff on 5xx and 429, debounced characteristic setters (Home app spams them), graceful degradation when Coway is down (keep last known state, don't crash), structured warning on the 60-day password rotation.
10. Cross-version test: bounce the Pi to Homebridge 2.0-beta via "Install Alternate Version," confirm clean load, then drop back to 1.8.x. No code changes should be needed if we followed the v2-readiness rules — this is the verification.
11. README with install instructions, config example, screenshot of the HomeKit tile, supported models list, and credit to `RobertD502/cowayaio`, `RobertD502/home-assistant-iocare`, and `OrigamiDream/homebridge-coway`.
12. GitHub: issue templates (bug report + feature request), a CONTRIBUTING note, MIT LICENSE file, semantic-version tags.
13. `npm publish` as `homebridge-airmega-iocare`. Verify it shows up in Homebridge UI plugin search within ~10 minutes of publish.
14. Optional, post-release: apply for Homebridge Verified status by opening an issue at `homebridge/verified` after the plugin has settled and accumulated some real-world use.

## Definition of done

### Phase 1 (prototype) is done when:
- Plugin installs on Jake's Pi via the GitHub-URL flow.
- Jake's 400S appears in Apple Home as one tile.
- Tile controls work: power, fan speed (3 steps), Auto/Manual, three preset switches (Sleep/Eco/Smart, mutually exclusive), LED display switch.
- Air quality sub-tile reports AQI plus PM2.5 and PM10.
- Both filters expose life-remaining and change indication.
- State refreshes every 60s; HomeKit reflects out-of-band changes (made via the unit or the IoCare+ app).
- Plugin survives the 60-day password rotation prompt by deferring (warns, continues).
- Coway 5xx doesn't crash the plugin — log warn, keep last known state.
- **Jake confirms it works for daily use.** Stop here.

### Phase 2 (public release v1.0) is done when:
- All Phase 1 criteria hold.
- **Homebridge 2.0 ready.** Plugin loads and runs cleanly on both Homebridge 1.8.x and 2.0-beta. `engines.homebridge` declares `^1.8.0 || ^2.0.0-beta.0`. No use of removed HAP-NodeJS v0 patterns (`Characteristic.Units/Formats/Perms` enums, `getValue()`, `getServiceByUUIDAndSubType()`, `setPrimaryService(svc)`, `BatteryService`, `updateReachability()`). See "Homebridge 2.0 readiness" in HANDOFF.md.
- Exponential backoff on 5xx and 429; debounced characteristic setters.
- README with install + config instructions, HomeKit tile screenshot, supported-models list, credits.
- GitHub: issue templates, CONTRIBUTING note, MIT LICENSE, semver tags.
- Published to npm as `homebridge-airmega-iocare`. Visible in Homebridge UI plugin search.

## Testing
Jake's Homebridge runs on a Raspberry Pi he doesn't develop on directly. Workflow:

1. Develop on the Mac, commit, push to GitHub.
2. On the Pi, open the Homebridge UI → top-right three-dot menu → Terminal.
3. Run `sudo npm install -g --unsafe-perm git+https://github.com/YOUR_USERNAME/homebridge-airmega-iocare.git` to install or update.
4. Restart Homebridge from the UI. Tail logs in the Logs tab.
5. The Apple Home app on Jake's phone is the integration test.

The `prepare` script in `package.json` compiles TypeScript on the Pi at install time, so committing `dist/` is unnecessary (and `dist/` should be in `.gitignore`).

There are no unit tests in v1 — the integration is so coupled to Coway's live API that mocking is more work than it's worth.

## Credentials
Jake's IoCare+ username and password go in his local Homebridge `config.json` under the platform block. Never commit credentials. No `.env` pattern needed because Homebridge is the credential store.

## Out of scope for v1
- Timer.
- Pre-filter wash frequency configuration.
- Smart mode sensitivity configuration.
- Apple Home automations (those are configured in the Home app once the accessory is exposed; nothing for the plugin to do).
- CarPlay or any non-HomeKit surface.
- Models other than the 400S — code should be model-agnostic where reasonable but only the 400S is actively tested in v1.
