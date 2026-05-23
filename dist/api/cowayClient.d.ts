import { Logger } from 'homebridge';
import { CowayDevice, DeviceState } from './types';
export interface CowayClientOptions {
    username: string;
    password: string;
    skipPasswordChange: boolean;
    log: Logger;
}
export declare class CowayClient {
    private readonly opts;
    private tokens?;
    private countryCode?;
    private places;
    constructor(opts: CowayClientOptions);
    /**
     * Run the full IoCare+ login flow, then prime the country code and places
     * cache so `listDevices()` can iterate without further auth-related round
     * trips.
     */
    login(): Promise<void>;
    listDevices(): Promise<CowayDevice[]>;
    /**
     * Fetch the full state of one purifier. Three round-trips: an HTML scrape
     * for the bulk of the state, plus separate JSON calls for filters and timer.
     * Mirrors cowayaio's `async_get_purifiers_data`.
     */
    getDeviceState(device: CowayDevice): Promise<DeviceState>;
    /**
     * Send a single Coway control attribute write to the device.
     * `attribute` is a hex-string from `Attribute.*` in deviceCodes.ts; `value`
     * is the value Coway expects for that attribute (almost always a string).
     */
    sendCommand(device: CowayDevice, attribute: string, value: string | number): Promise<void>;
    private fetchPurifierJson;
    private fetchSupplies;
    private mapDevice;
    private fetchCountryCode;
    private fetchPlaces;
    private fetchPlaceDevices;
    /**
     * GET a JSON endpoint with the standard authorized headers, refreshing the
     * access token first if it's close to expiry. On a 401 we attempt one
     * refresh-and-retry before giving up. 5xx and 429 responses get the
     * standard exponential-backoff retry loop.
     */
    private authedJsonGet;
    /**
     * POST a JSON body with the standard authorized headers. Mirrors
     * `authedJsonGet`: token freshness check, exponential backoff on 5xx/429,
     * one-shot 401 retry after refresh, and HTTP-status-to-exception mapping.
     * Returns the parsed body if it's a JSON object, or undefined if the
     * endpoint responded with no body (control-status sometimes does). Control
     * writes are idempotent at the value level (setting fan_speed=2 twice is a
     * no-op), so retrying is safe.
     */
    private authedJsonPost;
    /**
     * Map HTTP status codes to thrown exceptions. Status-based mapping comes
     * before any body parsing so we don't depend on matching Coway's localized
     * message strings to recognize a 401 or 429.
     */
    private assertResponseOk;
    private parseJsonResponse;
    private authHeaders;
    private ensureFreshToken;
    private forceRefresh;
}
