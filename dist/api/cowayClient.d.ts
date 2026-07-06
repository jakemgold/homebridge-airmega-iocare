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
    private refreshInFlight?;
    private readonly suppliesCache;
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
    /**
     * Supplies (filter life), served from a per-device cache with a 30-minute
     * TTL — see SUPPLIES_TTL_MS. Polls between refreshes reuse the cached
     * entries; the HTML scrape still runs every poll for live state.
     */
    private getSupplies;
    private fetchSupplies;
    private mapDevice;
    private fetchCountryCode;
    private fetchPlaces;
    private fetchPlaceDevices;
    /**
     * The shared pipeline for every authorized JSON call: token freshness
     * check, exponential backoff on 5xx and network errors (429 fails fast to
     * RateLimitedError — see http.ts), a one-shot 401 refresh-and-retry,
     * HTTP-status-to-exception mapping, and Coway's body.error envelope
     * mapping. GET and POST are thin wrappers over this one implementation so
     * their error handling can't drift — it previously did: POST passed
     * body.error envelopes through silently where GET threw.
     *
     * Returns the parsed body when it's a JSON object, undefined otherwise
     * (control-status sometimes responds with no body).
     *
     * `context` labels log and error messages; pass one when the URL embeds a
     * device serial so the serial stays out of shareable logs.
     */
    private authedJsonRequest;
    /**
     * GET a JSON endpoint. Coway's GET endpoints always return a JSON object,
     * so unlike POST, a missing or non-object body is an error here.
     */
    private authedJsonGet;
    /**
     * POST a JSON body. Tolerates an empty response body. Retrying inside the
     * pipeline is safe for control writes: they're idempotent at the value
     * level (setting fan_speed=2 twice is a no-op).
     */
    private authedJsonPost;
    /**
     * Map HTTP status codes to thrown exceptions. Status-based mapping comes
     * before any body parsing so we don't depend on matching Coway's localized
     * message strings to recognize a 401 or 429. `context` is a URL or a
     * descriptive label — callers pass a label when the URL embeds a serial.
     */
    private assertResponseOk;
    /**
     * Coway wraps application-level failures in a body.error envelope, even on
     * HTTP 200. Map the token-related messages to AuthError so the refresh and
     * re-login machinery reacts; anything else is a plain error.
     */
    private assertNoErrorEnvelope;
    private authHeaders;
    private ensureFreshToken;
    /**
     * Refresh the tokens, sharing one in-flight refresh among all concurrent
     * callers. getDeviceState fetches two endpoints in parallel and multiple
     * accessories poll one shared client, so without single-flight every
     * refresh window fired duplicate simultaneous refresh POSTs carrying the
     * SAME refresh token — and Coway rotates refresh tokens on use, so the
     * losing request got INVALID_REFRESH_TOKEN and escalated to a full
     * username+password re-login (and last-writer-wins on this.tokens could
     * store an already-invalidated pair).
     */
    private forceRefresh;
    private doRefresh;
}
