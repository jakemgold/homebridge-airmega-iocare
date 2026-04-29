"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SKIP_PASSWORD_CHANGE_DEFAULT = exports.DEFAULT_POLL_SECONDS = exports.SUPPORTED_MODELS = exports.PLUGIN_NAME = exports.PLATFORM_NAME = void 0;
exports.PLATFORM_NAME = 'AirmegaPlatform';
exports.PLUGIN_NAME = 'homebridge-airmega-iocare';
// Models confirmed by RobertD502/home-assistant-iocare
exports.SUPPORTED_MODELS = ['400S', '300S', '250S', 'MightyS', 'IconS'];
exports.DEFAULT_POLL_SECONDS = 60;
// Coway forces password rotation every 60 days; the API returns a flag to defer.
exports.SKIP_PASSWORD_CHANGE_DEFAULT = true;
//# sourceMappingURL=settings.js.map