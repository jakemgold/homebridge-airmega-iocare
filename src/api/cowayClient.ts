import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';
import { Logger } from 'homebridge';

import {
  AuthTokens, AuthError, RATE_LIMIT_BACKOFF_MS, RateLimitedError, performLogin, refreshAccessToken,
} from './auth';
import {
  Attribute, CATEGORY_NAME, Endpoint, ErrorMessage, Header,
  LightMode, ModeValue, Parameter, PowerValue, SensorKey,
} from './endpoints';
import { baseRequestConfig, withRetry } from './http';
import { CowayDevice, DeviceState } from './types';
import { redactBody } from './redact';

export interface CowayClientOptions {
  username: string;
  password: string;
  skipPasswordChange: boolean;
  log: Logger;
}

// Coway returns place rows with at least these fields. Other fields exist but
// we don't depend on them.
interface CowayPlaceRow {
  placeId: number | string;
  placeName?: string;
  deviceCnt: number;
}

// The /places/{id}/devices response items, with the fields we care about.
// Verified against a live 400S response — see Phase 1 task 1 notes in HANDOFF.md.
interface CowayDeviceRow {
  deviceSerial: string;
  dvcNick: string;
  modelCode: string;     // e.g. '02EUZ'
  productModel: string;  // e.g. 'AP-2015E'
  placeId: number | string;
  categoryName: string;  // e.g. '청정기' for purifiers
  categoryCode?: string;
}

// Refresh proactively when the token has under 5 minutes of life left,
// matching cowayaio's behavior.
const REFRESH_LEAD_MS = 5 * 60 * 1000;

// Filter life changes on a scale of days; fetching /supplies on every poll
// doubled the plugin's steady-state request volume against a rate-limit-
// sensitive API. Cache per device and refetch on this cadence instead. Error
// results are cached too — a persistent supplies outage should not revert to
// per-poll hammering.
const SUPPLIES_TTL_MS = 30 * 60 * 1000;

export class CowayClient {
  private tokens?: AuthTokens;
  private countryCode?: string;
  private places: CowayPlaceRow[] = [];
  // In-flight token refresh, shared by every concurrent caller — see forceRefresh.
  private refreshInFlight?: Promise<void>;
  private readonly suppliesCache = new Map<string, { fetchedAt: number; entries: SuppliesEntry[] }>();
  // Epoch ms until which status polling stays paused after Coway rate-limited
  // the account. Rate limits are account-wide, so one pause covers every
  // purifier sharing this client.
  private rateLimitedUntil = 0;

  constructor(private readonly opts: CowayClientOptions) {}

  /** True while polling should stay away from Coway after a rate limit. */
  isRateLimited(): boolean {
    return Date.now() < this.rateLimitedUntil;
  }

  /**
   * Run the full IoCare+ login flow, then prime the country code and places
   * cache so `listDevices()` can iterate without further auth-related round
   * trips.
   */
  async login(): Promise<void> {
    this.tokens = await performLogin({
      username: this.opts.username,
      password: this.opts.password,
      skipPasswordChange: this.opts.skipPasswordChange,
      log: this.opts.log,
    });
    this.opts.log.info('Logged in to Coway IoCare+.');

    this.countryCode = await this.fetchCountryCode();
    this.places = await this.fetchPlaces();
    this.opts.log.debug(
      `Coway: countryCode=${this.countryCode}, places=${this.places.length}`,
    );
  }

  async listDevices(): Promise<CowayDevice[]> {
    if (!this.tokens || !this.countryCode) {
      throw new Error('CowayClient.listDevices() called before login()');
    }
    const result: CowayDevice[] = [];
    for (const place of this.places) {
      // We used to skip any place whose `deviceCnt` was 0, mirroring cowayaio.
      // But Coway reports deviceCnt=0 for some accounts that nonetheless own a
      // controllable purifier — shared/guest devices, or simply a stale count
      // (issue #6). deviceCnt is advisory only now: we always fetch the place's
      // device list and let the actual rows decide. This is discovery-only, so
      // the extra fetch per empty place costs one request at startup.
      const rows = await this.fetchPlaceDevices(place.placeId);
      this.opts.log.debug(
        `Coway: place ${place.placeId} (${place.placeName ?? 'unnamed'}) ` +
        `reports deviceCnt=${place.deviceCnt ?? 'n/a'}, device list returned ${rows.length} row(s).`,
      );
      for (const row of rows) {
        if (row.categoryName !== CATEGORY_NAME) {
          this.opts.log.debug(
            `Coway: skipping non-purifier device ${row.dvcNick} ` +
            `(categoryName=${row.categoryName}, categoryCode=${row.categoryCode ?? 'n/a'}).`,
          );
          continue;
        }
        result.push(this.mapDevice(row));
      }
    }
    this.opts.log.info(`Coway: discovered ${result.length} purifier(s).`);
    return result;
  }

  /**
   * Fetch the full state of one purifier: an HTML scrape for the bulk of the
   * state, plus the filter-life JSON call (cached, see SUPPLIES_TTL_MS).
   * Mirrors cowayaio's `async_get_purifiers_data`.
   */
  async getDeviceState(device: CowayDevice): Promise<DeviceState> {
    if (!this.tokens) {
      throw new Error('CowayClient.getDeviceState() called before login()');
    }
    const [purifierInfo, supplies] = await this.watchRateLimit(() => Promise.all([
      this.fetchPurifierInfo(device),
      this.getSupplies(device),
    ]));

    // If we couldn't extract anything from the HTML, fail the poll instead of
    // assembling state from empty objects. The caller catches and HomeKit
    // keeps the last known value, which is much safer than reporting healthy
    // defaults (e.g. "Pre-Filter 100%") that would mislead the user.
    if (!purifierInfo) {
      throw new Error(`Coway: could not extract purifier state from HTML for ${device.name}`);
    }

    const status = readPath<Record<string, unknown>>(
      purifierInfo, 'deviceStatusData.data.statusInfo.attributes',
    );
    // A page that parses but whose inner structure moved would otherwise
    // fall through to an all-defaults state — power off, manual, speed 1 —
    // that pushUpdates would present as authoritative. Fail the poll instead:
    // same keep-last-known-state behavior as the unparseable case above,
    // and loud in the logs instead of silently lying about the device.
    if (!status || Object.keys(status).length === 0) {
      throw new Error(
        `Coway: purifier page for ${device.name} is missing statusInfo attributes`,
      );
    }
    const sensors = findSensorAttributes(purifierInfo);
    const aqGrade = readPath<Record<string, unknown>>(
      purifierInfo, 'deviceModule.data.content.deviceModuleDetailInfo.airStatusInfo',
    );
    const mcuVersion = findMcuVersion(purifierInfo);

    return assembleDeviceState(status, sensors, aqGrade, supplies, mcuVersion, this.opts.log);
  }

  /**
   * Send a single Coway control attribute write to the device.
   * `attribute` is a hex-string from `Attribute.*` in deviceCodes.ts; `value`
   * is the value Coway expects for that attribute (almost always a string).
   */
  async sendCommand(
    device: CowayDevice,
    attribute: string,
    value: string | number,
  ): Promise<void> {
    if (!this.tokens) {
      throw new Error('CowayClient.sendCommand() called before login()');
    }
    const url = `${Endpoint.BASE_URI}${Endpoint.PLACES}/${device.placeId}/devices/${device.deviceId}/control-status`;
    const payload = {
      attributes: { [attribute]: String(value) },
      isMultiControl: false,
      refreshFlag: false,
    };
    // Pass a context label instead of the URL: the control-status URL embeds
    // the device serial, and retry/error messages surface in warn-level logs
    // that users paste into GitHub issues. redact.ts strips serials from
    // logged bodies; the label keeps them out of logged URLs too.
    const body = await this.watchRateLimit(
      () => this.authedJsonPost(url, payload, `control-status for ${device.name}`),
    );
    // control-status uses a `header.error_code` envelope for app-level failures
    // (e.g. device offline). HTTP-level failures are already mapped to thrown
    // errors inside authedJsonPost.
    if (body && typeof body === 'object' && body.header?.error_code) {
      throw new Error(
        `Coway command failed (${attribute}=${value}): ` +
        `${body.header.error_code} ${body.header.error_text ?? ''}`.trim(),
      );
    }
    this.opts.log.debug(`Coway: ${device.name} command sent (${attribute}=${value})`);
  }

  // --- internals ---

  /**
   * Run `work`, and if Coway answers with a rate limit, pause status polling
   * for RATE_LIMIT_BACKOFF_MS: per Coway's own error message, requests made
   * during the block extend it. Commands still go through, since they're
   * user-initiated; one that hits the limit just extends the pause.
   */
  private async watchRateLimit<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (err) {
      if (err instanceof RateLimitedError) {
        const alreadyPaused = this.isRateLimited();
        this.rateLimitedUntil = Date.now() + RATE_LIMIT_BACKOFF_MS;
        if (!alreadyPaused) {
          this.opts.log.warn(
            `Coway is rate-limiting this account; pausing status updates for ` +
            `${RATE_LIMIT_BACKOFF_MS / 60000} minutes.`,
          );
        }
      }
      throw err;
    }
  }

  private async fetchPurifierInfo(device: CowayDevice): Promise<PurifierInfo | null> {
    await this.ensureFreshToken();
    const url = `${Endpoint.PURIFIER_HTML_BASE}/${device.placeId}/product/${device.modelCode}`;
    const context = `purifier HTML for ${device.name}`;
    const doFetch = (): Promise<AxiosResponse<string>> => withRetry<string>(
      () => axios.get(url, {
        headers: {
          'theme': Header.THEME,
          'callingpage': Header.CALLING_PAGE,
          'accept': Header.ACCEPT,
          'dvcnick': device.name,
          'timezoneid': Parameter.TIMEZONE,
          'appversion': Parameter.APP_VERSION,
          // The HTML scrape endpoint uses a custom 'accesstoken' header, NOT
          // the standard Authorization Bearer. Verified against cowayaio.
          'accesstoken': this.tokens!.accessToken,
          'accept-language': Header.COWAY_LANGUAGE,
          'region': Header.REGION,
          'user-agent': Header.USER_AGENT,
          'srcpath': Header.SOURCE_PATH,
          'deviceserial': device.deviceId,
        },
        params: {
          bottomSlide: 'false',
          tab: '0',
          temperatureUnit: 'F',
          weightUnit: 'oz',
          gravityUnit: 'lb',
        },
        ...baseRequestConfig(),
        // The endpoint returns HTML; axios shouldn't try to parse JSON.
        responseType: 'text',
        transformResponse: [d => d],
      }),
      this.opts.log,
      context,
    );
    let resp = await doFetch();
    if (resp.status === 401) {
      // Coway can revoke tokens server-side ahead of our locally computed
      // expiry (IoCare+ login elsewhere, session purge). Without this
      // one-shot refresh-and-retry — the same recovery authedJsonGet has —
      // every poll would fail for up to ~55 minutes until the proactive
      // refresh window opens, while commands kept working and masked it.
      await this.forceRefresh();
      resp = await doFetch();
    }
    this.assertResponseOk(resp, context);
    if (typeof resp.data !== 'string') {
      throw new Error(`Coway purifier HTML fetch failed for ${device.name}: non-text response`);
    }
    return extractPurifierInfoFromHtml(resp.data);
  }

  /**
   * Supplies (filter life), served from a per-device cache with a 30-minute
   * TTL — see SUPPLIES_TTL_MS. Polls between refreshes reuse the cached
   * entries; the HTML scrape still runs every poll for live state.
   */
  private async getSupplies(device: CowayDevice): Promise<SuppliesEntry[]> {
    const cached = this.suppliesCache.get(device.deviceId);
    if (cached && Date.now() - cached.fetchedAt < SUPPLIES_TTL_MS) {
      return cached.entries;
    }
    const entries = await this.fetchSupplies(device);
    this.suppliesCache.set(device.deviceId, { fetchedAt: Date.now(), entries });
    return entries;
  }

  private async fetchSupplies(device: CowayDevice): Promise<SuppliesEntry[]> {
    const url = `${Endpoint.SECONDARY_BASE}${Endpoint.PLACES}/${device.placeId}/devices/${device.deviceId}/supplies`;
    const context = `supplies for ${device.name}`;
    await this.ensureFreshToken();
    const doFetch = (): Promise<AxiosResponse> => withRetry(
      () => axios.get(url, {
        headers: {
          'region': Header.REGION,
          'accept': 'application/json, text/plain, */*',
          'authorization': `Bearer ${this.tokens!.accessToken}`,
          'accept-language': Header.COWAY_LANGUAGE,
          'user-agent': Header.USER_AGENT,
        },
        params: {
          membershipYn: 'N',
          membershipType: '',
          langCd: Header.ACCEPT_LANG,
        },
        ...baseRequestConfig(),
      }),
      this.opts.log,
      context,
    );
    let resp = await doFetch();
    if (resp.status === 401) {
      // Same one-shot refresh-and-retry as fetchPurifierInfo: don't let a
      // server-side token revocation silently blank the filter data.
      await this.forceRefresh();
      resp = await doFetch();
    }
    if (resp.status === 429) {
      // Rate limiting is account-wide, not endpoint-specific: surface the
      // typed error instead of degrading quietly.
      this.assertResponseOk(resp, context);
    }
    if (resp.status < 200 || resp.status >= 300) {
      // Filter life is the least critical part of a poll and changes over
      // days: degrade to the sensor-derived fallback (and HomeKit's last
      // known values) rather than failing the whole poll — but say so.
      // Silently coercing errors to an empty list hid real outages before.
      this.opts.log.warn(`Coway ${context}: HTTP ${resp.status}; keeping last known filter state.`);
      return [];
    }
    const list = resp.data?.data?.suppliesList;
    return Array.isArray(list) ? (list as SuppliesEntry[]) : [];
  }

  private mapDevice(row: CowayDeviceRow): CowayDevice {
    return {
      deviceId: row.deviceSerial,
      name: row.dvcNick,
      // The user-visible "model" is the friendly nickname Coway sets per device
      // family (e.g. 'Airmega 400S'); the actual product code (AP-2015E) and
      // the API's modelCode (02EUZ) are exposed separately for downstream use.
      model: row.dvcNick,
      modelCode: row.modelCode,
      productModel: row.productModel,
      placeId: row.placeId,
      serial: row.deviceSerial,
    };
  }

  private async fetchCountryCode(): Promise<string> {
    const url = `${Endpoint.BASE_URI}${Endpoint.USER_INFO}`;
    const body = await this.authedJsonGet(url);
    const code = body?.data?.memberInfo?.countryCode;
    if (!code || typeof code !== 'string') {
      throw new Error(`Coway /com/my-info returned no countryCode (body=${redactBody(body)})`);
    }
    return code;
  }

  private async fetchPlaces(): Promise<CowayPlaceRow[]> {
    const url = `${Endpoint.BASE_URI}${Endpoint.PLACES}`;
    const body = await this.authedJsonGet(url, {
      countryCode: this.countryCode,
      langCd: Header.ACCEPT_LANG,
      pageIndex: '1',
      pageSize: '20',
      timezoneId: Parameter.TIMEZONE,
    });
    const places = body?.data?.content;
    if (!Array.isArray(places)) {
      throw new Error(`Coway /com/places returned no content (body=${redactBody(body)})`);
    }
    return places as CowayPlaceRow[];
  }

  private async fetchPlaceDevices(placeId: number | string): Promise<CowayDeviceRow[]> {
    const url = `${Endpoint.BASE_URI}${Endpoint.PLACES}/${placeId}/devices`;
    const body = await this.authedJsonGet(url, {
      pageIndex: '0',
      pageSize: '100',
    });
    const devices = body?.data?.content;
    // Throw on a malformed shape rather than coercing to an empty list, the
    // same way fetchPlaces does. The downstream consumer is destructive: a
    // devices list that comes back empty because of an envelope change would
    // make platform.ts unregister the user's cached accessories, taking their
    // room assignments and automations with it.
    if (!Array.isArray(devices)) {
      throw new Error(
        `Coway /com/places/${placeId}/devices returned no content (body=${redactBody(body)})`,
      );
    }
    const rows = devices as CowayDeviceRow[];
    // Diagnostic dump of the raw rows so accounts where discovery comes up empty
    // can show us exactly what Coway returns (issue #6). Serials, place names,
    // and other sensitive keys are stripped by redactBody before logging.
    this.opts.log.debug(
      `Coway: /places/${placeId}/devices raw rows: ${redactBody(rows, 4000)}`,
    );
    return rows;
  }

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
  // `any` because Coway's response envelopes differ per endpoint and carry no
  // schema; callers destructure what they need behind optional chaining.
  private async authedJsonRequest(
    method: 'get' | 'post',
    url: string,
    opts: { params?: Record<string, unknown>; payload?: unknown; context?: string } = {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    const context = opts.context ?? url;
    await this.ensureFreshToken();
    const buildCfg = (): AxiosRequestConfig => ({
      headers: this.authHeaders(),
      params: opts.params,
      ...baseRequestConfig(),
    });
    const doRequest = (): Promise<AxiosResponse> => withRetry(
      () => (method === 'get'
        ? axios.get(url, buildCfg())
        : axios.post(url, opts.payload, buildCfg())),
      this.opts.log,
      context,
    );
    let resp = await doRequest();
    if (resp.status === 401) {
      await this.forceRefresh();
      resp = await doRequest();
    }
    this.assertResponseOk(resp, context);
    const body = resp.data;
    if (!body || typeof body !== 'object') {
      return undefined;
    }
    this.assertNoErrorEnvelope(body, context);
    return body;
  }

  /**
   * GET a JSON endpoint. Coway's GET endpoints always return a JSON object,
   * so unlike POST, a missing or non-object body is an error here.
   */
  // `any` for the same reason as authedJsonRequest.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async authedJsonGet(url: string, params?: Record<string, any>): Promise<any> {
    const body = await this.authedJsonRequest('get', url, { params });
    if (body === undefined) {
      throw new Error(`Coway returned non-JSON for ${url}`);
    }
    return body;
  }

  /**
   * POST a JSON body. Tolerates an empty response body. Retrying inside the
   * pipeline is safe for control writes: they're idempotent at the value
   * level (setting fan_speed=2 twice is a no-op).
   */
  // `any` for the same reason as authedJsonRequest.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async authedJsonPost(url: string, payload: unknown, context = url): Promise<any> {
    return this.authedJsonRequest('post', url, { payload, context });
  }

  /**
   * Map HTTP status codes to thrown exceptions. Status-based mapping comes
   * before any body parsing so we don't depend on matching Coway's localized
   * message strings to recognize a 401 or 429. `context` is a URL or a
   * descriptive label — callers pass a label when the URL embeds a serial.
   */
  private assertResponseOk(resp: AxiosResponse, context: string): void {
    if (resp.status === 401) {
      throw new AuthError(`Coway auth error on ${context}: HTTP 401`);
    }
    if (resp.status === 429) {
      throw new RateLimitedError(
        `Coway rate-limited on ${context}: HTTP 429. Wait at least an hour before retrying.`,
      );
    }
    if (resp.status >= 500) {
      throw new Error(`Coway server error on ${context}: HTTP ${resp.status}`);
    }
    if (resp.status < 200 || resp.status >= 300) {
      throw new Error(`Coway unexpected status on ${context}: HTTP ${resp.status}`);
    }
  }

  /**
   * Coway wraps application-level failures in a body.error envelope, even on
   * HTTP 200. Map the token-related messages to AuthError so the refresh and
   * re-login machinery reacts; anything else is a plain error.
   */
  private assertNoErrorEnvelope(body: AnyObj, context: string): void {
    if (!body.error) {
      return;
    }
    const message = body.error?.message ?? redactBody(body.error);
    if (message === ErrorMessage.INVALID_REFRESH_TOKEN || message === ErrorMessage.BAD_TOKEN) {
      throw new AuthError(`Coway auth error on ${context}: ${message}`);
    }
    throw new Error(`Coway error on ${context}: ${message}`);
  }

  private authHeaders(): Record<string, string> {
    if (!this.tokens?.accessToken) {
      throw new Error('CowayClient: missing access token');
    }
    return {
      'region': Header.REGION,
      'content-type': Header.CONTENT_JSON,
      'accept': '*/*',
      'authorization': `Bearer ${this.tokens.accessToken}`,
      'accept-language': Header.COWAY_LANGUAGE,
      'user-agent': Header.USER_AGENT,
    };
  }

  private async ensureFreshToken(): Promise<void> {
    if (!this.tokens) {
      throw new Error('CowayClient: not logged in');
    }
    if (this.tokens.expiresAt - Date.now() <= REFRESH_LEAD_MS) {
      await this.forceRefresh();
    }
  }

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
  private forceRefresh(): Promise<void> {
    if (!this.refreshInFlight) {
      this.refreshInFlight = this.doRefresh().finally(() => {
        this.refreshInFlight = undefined;
      });
    }
    return this.refreshInFlight;
  }

  private async doRefresh(): Promise<void> {
    if (!this.tokens?.refreshToken) {
      throw new Error('CowayClient: cannot refresh without a refresh token');
    }
    this.opts.log.debug('Coway: refreshing access token');
    try {
      this.tokens = await refreshAccessToken(this.tokens.refreshToken, this.opts.log);
    } catch (err) {
      if (err instanceof AuthError) {
        this.opts.log.warn('Coway refresh token rejected; performing full re-login.');
        this.tokens = await performLogin({
          username: this.opts.username,
          password: this.opts.password,
          skipPasswordChange: this.opts.skipPasswordChange,
          log: this.opts.log,
        });
        return;
      }
      throw err;
    }
  }
}

// --- HTML scrape and state-assembly helpers (module-private) ---

// `any` because these model the scraped page's embedded JSON, whose shape is
// Coway's to change without notice — every read goes through optional
// chaining or the readPath/find* helpers, which tolerate any shape.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObj = Record<string, any>;
type PurifierInfo = AnyObj;

interface SuppliesEntry {
  supplyNm?: string;
  filterRemain?: number;
  replaceCycle?: number;
}

// The purifier page is a Next.js app. Its state rides in the React Server
// Components "flight" stream, which the page embeds as a series of
// `self.__next_f.push([1, "<chunk>"])` scripts. Chunks tagged 1 carry flight
// data (other tags carry bootstrap and form state), and joining them in order
// rebuilds the stream, since one row can straddle two chunks.
const FLIGHT_PUSH_CALL = 'self.__next_f.push(';
const FLIGHT_DATA_CHUNK = 1;

/**
 * Pull the purifier's page-props object out of the product page: the object
 * that carries the `coreData` array and the `deviceStatusData` block every
 * state read starts from. Returns null when the page doesn't contain it.
 */
function extractPurifierInfoFromHtml(html: string): PurifierInfo | null {
  return findPurifierInfo(readFlightStream(html));
}

function readFlightStream(html: string): string {
  const chunks: string[] = [];
  const scriptRe = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = scriptRe.exec(html)) !== null) {
    const body = match[1];
    const call = body.indexOf(FLIGHT_PUSH_CALL);
    if (call < 0) continue;
    const start = body.indexOf('[', call + FLIGHT_PUSH_CALL.length);
    const end = body.lastIndexOf(']');
    if (start < 0 || end <= start) continue;
    // The chunk is a JSON string literal; decoding it as JSON (rather than
    // stripping backslashes) keeps legitimately escaped characters intact.
    const args = safeJsonParse(body.slice(start, end + 1));
    if (Array.isArray(args) && args[0] === FLIGHT_DATA_CHUNK && typeof args[1] === 'string') {
      chunks.push(args[1]);
    }
  }
  return chunks.join('');
}

const PURIFIER_INFO_KEY = '"deviceStatusData"';

/**
 * Find the first object, in document order, that looks like the purifier's
 * page props. The stream is a series of rows separated by newlines: mostly
 * JSON, which never contains a raw newline, mixed with row prefixes and raw
 * text. So the object sits on the same line as its `deviceStatusData` key,
 * and only those lines need searching. Scoping the search matters: decoding
 * the whole ~400 KB stream costs over 100 ms per poll on a Raspberry Pi, all
 * of it blocking Homebridge's event loop.
 */
function findPurifierInfo(stream: string): PurifierInfo | null {
  let key = stream.indexOf(PURIFIER_INFO_KEY);
  while (key >= 0) {
    const lineStart = stream.lastIndexOf('\n', key) + 1;
    const newline = stream.indexOf('\n', key);
    const lineEnd = newline < 0 ? stream.length : newline;
    const hit = searchSpan(stream, lineStart, lineEnd);
    if (hit) return hit;
    key = stream.indexOf(PURIFIER_INFO_KEY, lineEnd);
  }
  return null;
}

/**
 * Try to decode a JSON value at each `{` in `text[from, to)`. When one
 * decodes, search inside it, then jump past its span instead of rescanning
 * the braces it contained.
 */
function searchSpan(text: string, from: number, to: number): PurifierInfo | null {
  let i = text.indexOf('{', from);
  while (i >= 0 && i < to) {
    const end = jsonValueEnd(text, i, to);
    const value = end < 0 ? null : safeJsonParse(text.slice(i, end));
    if (value === null) {
      i = text.indexOf('{', i + 1);
      continue;
    }
    const hit = findInTree(value, isPurifierInfo);
    if (hit) return hit;
    i = text.indexOf('{', end);
  }
  return null;
}

function isPurifierInfo(obj: AnyObj): boolean {
  return Array.isArray(obj.coreData)
    && !!obj.deviceStatusData && typeof obj.deviceStatusData === 'object';
}

/** Pre-order (document-order) search of a decoded JSON tree. */
function findInTree(root: unknown, match: (obj: AnyObj) => boolean): AnyObj | null {
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (!Array.isArray(node) && match(node as AnyObj)) return node as AnyObj;
    const children = Object.values(node as AnyObj);
    for (let k = children.length - 1; k >= 0; k--) stack.push(children[k]);
  }
  return null;
}

/**
 * Index just past the JSON object or array that opens at `start`, or -1 if
 * it doesn't close before `limit`. Brackets inside string literals don't
 * count; whether the span is valid JSON is left to the parser.
 */
function jsonValueEnd(text: string, start: number, limit: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < limit; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === '{' || ch === '[') {
      depth++;
    } else if (ch === '}' || ch === ']') {
      if (--depth === 0) return i + 1;
    }
  }
  return -1;
}

const DANGEROUS_JSON_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * `JSON.parse` with a reviver that strips keys commonly used in
 * prototype-pollution exploits, in case the page is tampered with despite
 * our TLS + host-validation defenses. Returns null if the input doesn't
 * parse.
 */
function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text, (key, value) => {
      if (DANGEROUS_JSON_KEYS.has(key)) return undefined;
      return value;
    });
  } catch {
    return null;
  }
}

function readPath<T>(obj: AnyObj | null | undefined, path: string): T | undefined {
  if (!obj) return undefined;
  // `any` because the walk crosses untyped scraped JSON; the guard below
  // re-checks the shape at every step.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let cur: any = obj;
  for (const key of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[key];
  }
  return cur as T | undefined;
}

/**
 * Walk purifier_info.coreData[*] and find the entry whose `data` carries a
 * `sensorInfo` block, then return its `attributes`. cowayaio does the same.
 */
function findSensorAttributes(purifierInfo: AnyObj): AnyObj {
  const coreData = purifierInfo?.coreData;
  if (!Array.isArray(coreData)) return {};
  for (const entry of coreData) {
    const sensorInfo = entry?.data?.sensorInfo;
    if (sensorInfo?.attributes && typeof sensorInfo.attributes === 'object') {
      return sensorInfo.attributes as AnyObj;
    }
  }
  return {};
}

/**
 * Walk purifier_info.coreData[*] for the entry whose `data` carries
 * `currentMcuVer`. cowayaio reports this as the device's firmware version.
 * Coway's current page omits it; the accessory then keeps its cached
 * firmware revision.
 */
function findMcuVersion(purifierInfo: AnyObj): string | undefined {
  const coreData = purifierInfo?.coreData;
  if (!Array.isArray(coreData)) return undefined;
  for (const entry of coreData) {
    const ver = entry?.data?.currentMcuVer;
    if (typeof ver === 'string' && ver.length > 0) return ver;
  }
  return undefined;
}

// The status block reports the mode register numerically; compare via
// String() against the shared command-value table so read and write can't
// disagree about what each register value means.
function modeFromRegister(value: unknown): DeviceState['mode'] {
  switch (String(value)) {
    case ModeValue.AUTO: return 'auto';
    case ModeValue.NIGHT: return 'night';
    case ModeValue.RAPID: return 'rapid';
    case ModeValue.ECO: return 'eco';
    default: return 'manual';
  }
}

// Coway's four grades onto HomeKit's five levels, keeping both endpoints
// reachable and skipping HomeKit "Good". The old 1:1 mapping ran one notch
// optimistic everywhere — Coway "Unhealthy" rendered as "Fair" and "Poor"
// was unreachable, so worst-case automations could never fire. See the
// AirQualityLevel comment in types.ts for the full rationale.
function aqLevelFromGrade(grade: unknown): DeviceState['airQuality'] {
  switch (grade) {
    case 1: return 1; // Coway "Good" (its cleanest grade) → Excellent
    case 2: return 3; // Coway "Moderate" → Fair
    case 3: return 4; // Coway "Unhealthy" → Inferior
    case 4: return 5; // Coway "Very Unhealthy" → Poor
    default:
      // 0 = HomeKit "Unknown". Don't default to Excellent on missing data —
      // that lies about state in exactly the way the filter-default fix avoids.
      return 0;
  }
}

function clampFanSpeed(v: unknown): DeviceState['fanSpeed'] {
  const n = Number(v);
  if (Number.isFinite(n) && n >= 1 && n <= 6) return Math.trunc(n) as DeviceState['fanSpeed'];
  return 1;
}

function pickNumber(...vals: unknown[]): number | undefined {
  for (const v of vals) {
    // Number(null) and Number('') are both 0 — an absent reading must stay
    // undefined, not read as a legitimate zero. A synthesized 0 here becomes
    // "pristine air" for PM values and a fake 100% for the sensor-derived
    // filter percentage.
    if (v == null || v === '') continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function assembleDeviceState(
  status: AnyObj,
  sensors: AnyObj,
  aqGrade: AnyObj | undefined,
  supplies: SuppliesEntry[],
  mcuVersion: string | undefined,
  log: Logger,
): DeviceState {
  const power = String(status[Attribute.POWER]) === PowerValue.ON;
  const mode = modeFromRegister(status[Attribute.MODE]);
  const fanSpeed = clampFanSpeed(status[Attribute.FAN_SPEED]);
  // 400S-family binary light semantics; models with the inverted multi-mode
  // register (250S/IconS) don't expose the switch — see LIGHT_SWITCH_MODELS.
  const lightOn = String(status[Attribute.LIGHT]) === LightMode.ON;
  const timerMinutesRemaining = pickNumber(status[Attribute.TIMER]);

  // Filter percentages: prefer the /supplies endpoint (canonical), fall back to
  // a sensor-derived "100 - usedPct" if Coway hasn't populated supplies yet
  // (the 250S endpoint is still under development per cowayaio comments).
  //
  // Row matching: 'Pre-Filter' is the literal the live API returns (cowayaio
  // matches the same string). The Max2 row is matched positively on its name
  // when possible, with "any other row" as the fallback — the fallback
  // reproduces the reference behavior exactly, while the positive match
  // protects against a localized pre-filter name or an extra supply row
  // cross-labeling the two filters.
  const preFilterEntry = supplies.find(s => s.supplyNm === 'Pre-Filter');
  const max2Entry = supplies.find(s => /max2/i.test(s.supplyNm ?? ''))
    ?? supplies.find(s => s !== preFilterEntry);
  if (supplies.length > 0 && !preFilterEntry) {
    // A populated list with no recognizable pre-filter row means Coway is
    // returning names we don't know (likely localized). Log them — filter
    // display names aren't sensitive — so an affected user's debug log hands
    // us the exact strings to match.
    log.debug(
      'Coway: no \'Pre-Filter\' row among supplies names: ' +
      supplies.map(s => JSON.stringify(s.supplyNm ?? '?')).join(', '),
    );
  }

  const preFilterPct = preFilterEntry?.filterRemain
    ?? sensorDerivedFilterPct(sensors, SensorKey.PRE_FILTER_USED_PCT);
  const max2FilterPct = max2Entry?.filterRemain
    ?? sensorDerivedFilterPct(sensors, SensorKey.MAX2_FILTER_USED_PCT);

  const pm25 = pickNumber(sensors[SensorKey.PM25], sensors[SensorKey.PM25_IDX]);
  const pm10 = pickNumber(sensors[SensorKey.PM10], sensors[SensorKey.PM10_IDX]);
  const airQuality = aqLevelFromGrade(aqGrade?.iaqGrade);

  return {
    power,
    mode,
    fanSpeed,
    lightOn,
    airQuality,
    pm25,
    pm10,
    preFilterPct,
    max2FilterPct,
    timerMinutesRemaining,
    mcuVersion,
  };
}

function sensorDerivedFilterPct(sensors: AnyObj, key: string): number | undefined {
  const used = pickNumber(sensors[key]);
  if (used === undefined) return undefined;
  return Math.max(0, Math.min(100, 100 - used));
}
