"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_POLL_SECONDS = exports.PLUGIN_VERSION = exports.PLUGIN_NAME = exports.PLATFORM_NAME = void 0;
exports.PLATFORM_NAME = 'AirmegaPlatform';
exports.PLUGIN_NAME = 'homebridge-airmega-iocare';
// package.json sits outside rootDir, so it can't be imported; read it at
// runtime instead (dist/settings.js resolves it from the package root).
// eslint-disable-next-line @typescript-eslint/no-require-imports
exports.PLUGIN_VERSION = require('../package.json').version;
exports.DEFAULT_POLL_SECONDS = 60;
//# sourceMappingURL=settings.js.map