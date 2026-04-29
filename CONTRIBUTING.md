# Contributing

Thanks for your interest in `homebridge-airmega-iocare`. This is a small plugin maintained part-time, so please bear with the response times.

## Reporting bugs

[Open an issue](https://github.com/jakemgold/homebridge-airmega-iocare/issues) using the bug-report template. Please include:

- Your purifier's model and firmware version (visible in the IoCare+ app).
- A snippet of the Homebridge log around the failure.
- Whether the IoCare+ app itself works at the time the plugin doesn't — this distinguishes a Coway-side outage from a plugin bug.

If a feature works in the IoCare+ app but not in HomeKit, that's the most actionable kind of bug to file.

## Suggesting features

Use the feature-request issue template. The plugin is intentionally focused on what HomeKit can express well — see "Out of scope" below.

## Out of scope

These are intentional v1 limitations:

- **Timer support.** HomeKit has no clean primitive for arbitrary-duration timers; the IoCare+ app's off-timer is a convenience, not a core control. Use HomeKit Automations instead.
- **Pre-filter wash-frequency configuration.** Configurable in the IoCare+ app, but not via HomeKit.
- **Smart-mode sensitivity configuration.** Same as above.
- **Models other than the Airmega 400S** — code paths are written model-agnostically where reasonable, but only the 400S is verified live. Other models in the IoCare+ family (300S / 250S / MightyS / IconS) should work; please open an issue with results if you test one.

## Sending changes

1. Fork the repo and create a topic branch from `main`.
2. Run `npm install`.
3. Make your changes in `src/`.
4. Run `npm run build` and `npm run lint` — both must be clean.
5. Verify against your live purifier if your change touches `src/api/` or `src/accessories/`.
6. Commit with a message that explains the **why**, not just the what.
7. Open a PR.

`dist/` is committed to the repo so users installing from a git URL don't need to compile TypeScript on the Pi at install time. **Always run `npm run build` and commit the regenerated `dist/` along with your `src/` changes.** Out-of-sync `dist/` and `src/` will silently break installs.

## Style

- TypeScript strict mode. No `any` without an `eslint-disable` comment explaining why.
- Async/await throughout. No callbacks, no `.then()` chains.
- All Coway protocol literals (URLs, command codes, mode names) live in `src/api/endpoints.ts` and `src/accessories/deviceCodes.ts`. Don't hardcode them inline.
- One HomeKit service type per file in `src/accessories/`.
- The `src/api/` and `src/accessories/` layers must stay separated. The API layer owns the Coway protocol; the accessory layer owns HomeKit. A future Coway API break should only require touching `src/api/`.

## Releasing (maintainer only)

1. Bump `version` in `package.json`.
2. Run `npm run build`, commit `src/` + `dist/` + `package.json`.
3. `git tag v<version>` and `git push --tags`.
4. `npm publish` (or `npm publish --tag beta` for pre-releases).
5. Verify the package shows up in the Homebridge UI plugin search within ~10 minutes.

## Credits

This plugin builds on prior reverse-engineering of the IoCare+ API by [RobertD502](https://github.com/RobertD502) (cowayaio + home-assistant-iocare) and [OrigamiDream](https://github.com/OrigamiDream) (homebridge-coway). Star their projects.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
