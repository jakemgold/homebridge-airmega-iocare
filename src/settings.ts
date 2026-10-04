export const PLATFORM_NAME = 'AirmegaPlatform';
export const PLUGIN_NAME = 'homebridge-airmega-iocare';

// package.json sits outside rootDir, so it can't be imported; read it at
// runtime instead (dist/settings.js resolves it from the package root).
// eslint-disable-next-line @typescript-eslint/no-require-imports
export const PLUGIN_VERSION: string = require('../package.json').version;

export const DEFAULT_POLL_SECONDS = 60;
