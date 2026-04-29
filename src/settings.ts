export const PLATFORM_NAME = 'AirmegaPlatform';
export const PLUGIN_NAME = 'homebridge-airmega-iocare';

// Models confirmed by RobertD502/home-assistant-iocare
export const SUPPORTED_MODELS = ['400S', '300S', '250S', 'MightyS', 'IconS'] as const;
export type ModelCode = typeof SUPPORTED_MODELS[number];

export const DEFAULT_POLL_SECONDS = 60;

// Coway forces password rotation every 60 days; the API returns a flag to defer.
export const SKIP_PASSWORD_CHANGE_DEFAULT = true;
