export declare const PLATFORM_NAME = "AirmegaPlatform";
export declare const PLUGIN_NAME = "homebridge-airmega-iocare";
export declare const SUPPORTED_MODELS: readonly ["400S", "300S", "250S", "MightyS", "IconS"];
export type ModelCode = typeof SUPPORTED_MODELS[number];
export declare const DEFAULT_POLL_SECONDS = 60;
export declare const SKIP_PASSWORD_CHANGE_DEFAULT = true;
