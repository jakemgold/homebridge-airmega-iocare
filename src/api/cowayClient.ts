import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';
import { Logger } from 'homebridge';

import {
  AuthTokens, AuthError, RateLimitedError, performLogin, refreshAccessToken,
} from './auth';
import {
  CATEGORY_NAME, Endpoint, ErrorMessage, Header, Parameter,
} from './endpoints';
import { CowayDevice, DeviceState } from './types';

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

// Cap any single response we accept from Coway. The HTML scrape is the largest
// legitimate response (~50 KB live), so 2 MB gives a comfortable margin while
// preventing a misbehaving or hostile response from OOM-ing the Homebridge
// process via axios's response buffer.
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

// Retry parameters for transient server-side failures (5xx) and rate-limit
// responses (429). Cap at 5 attempts per HANDOFF.md — beyond that, surface a
// warn-level log and let the next polling cycle naturally retry.
const RETRY_MAX_ATTEMPTS = 5;
const RETRY_INITIAL_DELAY_MS = 1000;
const RETRY_MAX_DELAY_MS = 16000;

export class CowayClient {
  private tokens?: AuthTokens;
  private countryCode?: string;
  private places: CowayPlaceRow[] = [];

  constructor(private readonly opts: CowayClientOptions) {}

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
      if (!place.deviceCnt || place.deviceCnt <= 0) {
        this.opts.log.debug(
          `Coway: skipping empty place ${place.placeId} (${place.placeName ?? 'unnamed'})`,
        );
        continue;
      }
      const rows = await this.fetchPlaceDevices(place.placeId);
      for (const row of rows) {
        if (row.categoryName !== CATEGORY_NAME) {
          this.opts.log.debug(
            `Coway: skipping non-purifier device ${row.dvcNick} (categoryName=${row.categoryName})`,
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
   * Fetch the full state of one purifier. Three round-trips: an HTML scrape
   * for the bulk of the state, plus separate JSON calls for filters and timer.
   * Mirrors cowayaio's `async_get_purifiers_data`.
   */
  async getDeviceState(device: CowayDevice): Promise<DeviceState> {
    if (!this.tokens) {
      throw new Error('CowayClient.getDeviceState() called before login()');
    }
    const [purifierJson, supplies] = await Promise.all([
      this.fetchPurifierJson(device),
      this.fetchSupplies(device),
    ]);

    const purifierInfo = findFirstObject(purifierJson?.children) ?? {};

    const status = readPath<Record<string, unknown>>(
      purifierInfo, 'deviceStatusData.data.statusInfo.attributes',
    ) ?? {};
    const sensors = findSensorAttributes(purifierInfo);
    const aqGrade = readPath<Record<string, unknown>>(
      purifierInfo, 'deviceModule.data.content.deviceModuleDetailInfo.airStatusInfo',
    );
    const mcuVersion = findMcuVersion(purifierInfo);

    return assembleDeviceState(status, sensors, aqGrade, supplies, mcuVersion);
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
    await this.ensureFreshToken();

    const url = `${Endpoint.BASE_URI}${Endpoint.PLACES}/${device.placeId}/devices/${device.deviceId}/control-status`;
    const payload = {
      attributes: { [attribute]: String(value) },
      isMultiControl: false,
      refreshFlag: false,
    };
    const resp = await axios.post(url, payload, {
      headers: this.authHeaders(),
      timeout: 15000,
      maxContentLength: MAX_RESPONSE_BYTES,
      maxBodyLength: MAX_RESPONSE_BYTES,
      validateStatus: () => true,
    });
    const body = resp.data;
    if (body && typeof body === 'object' && body.header?.error_code) {
      throw new Error(
        `Coway command failed (${attribute}=${value}): ` +
        `${body.header.error_code} ${body.header.error_text ?? ''}`.trim(),
      );
    }
    this.opts.log.debug(
      `Coway: ${device.name} command sent (${attribute}=${value}); status=${resp.status}`,
    );
  }

  // --- internals ---

  private async fetchPurifierJson(device: CowayDevice): Promise<PurifierScrape | null> {
    await this.ensureFreshToken();
    const url = `${Endpoint.PURIFIER_HTML_BASE}/${device.placeId}/product/${device.modelCode}`;
    const resp = await withRetry<string>(
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
          'region': 'NUS',
          'user-agent': Header.HTML_USER_AGENT,
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
        timeout: 15000,
        maxContentLength: MAX_RESPONSE_BYTES,
        maxBodyLength: MAX_RESPONSE_BYTES,
        validateStatus: () => true,
        // The endpoint returns HTML; axios shouldn't try to parse JSON.
        responseType: 'text',
        transformResponse: [d => d],
      }),
      this.opts.log,
      `purifier HTML for ${device.name}`,
    );
    if (resp.status !== 200 || typeof resp.data !== 'string') {
      throw new Error(`Coway purifier HTML fetch failed for ${device.name}: HTTP ${resp.status}`);
    }
    return extractPurifierJsonFromHtml(resp.data);
  }

  private async fetchSupplies(device: CowayDevice): Promise<SuppliesEntry[]> {
    const url = `${Endpoint.SECONDARY_BASE}${Endpoint.PLACES}/${device.placeId}/devices/${device.deviceId}/supplies`;
    await this.ensureFreshToken();
    const resp = await withRetry(
      () => axios.get(url, {
        headers: {
          'region': 'NUS',
          'accept': 'application/json, text/plain, */*',
          'authorization': `Bearer ${this.tokens!.accessToken}`,
          'accept-language': Header.COWAY_LANGUAGE,
          'user-agent': Header.HTML_USER_AGENT,
        },
        params: {
          membershipYn: 'N',
          membershipType: '',
          langCd: Header.ACCEPT_LANG,
        },
        timeout: 15000,
        maxContentLength: MAX_RESPONSE_BYTES,
        maxBodyLength: MAX_RESPONSE_BYTES,
        validateStatus: () => true,
      }),
      this.opts.log,
      `supplies for ${device.name}`,
    );
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
      throw new Error(`Coway /com/my-info returned no countryCode (body=${JSON.stringify(body)})`);
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
      throw new Error(`Coway /com/places returned no content (body=${JSON.stringify(body)})`);
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
    return Array.isArray(devices) ? (devices as CowayDeviceRow[]) : [];
  }

  /**
   * GET a JSON endpoint with the standard authorized headers, refreshing the
   * access token first if it's close to expiry. On a 401 we attempt one
   * refresh-and-retry before giving up. 5xx and 429 responses get the
   * standard exponential-backoff retry loop.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async authedJsonGet(url: string, params?: Record<string, any>): Promise<any> {
    await this.ensureFreshToken();
    const buildCfg = (): AxiosRequestConfig => ({
      headers: this.authHeaders(),
      params,
      timeout: 15000,
      maxContentLength: MAX_RESPONSE_BYTES,
      maxBodyLength: MAX_RESPONSE_BYTES,
      validateStatus: () => true,
    });
    let resp = await withRetry(() => axios.get(url, buildCfg()), this.opts.log, url);
    if (resp.status === 401) {
      await this.forceRefresh();
      resp = await withRetry(() => axios.get(url, buildCfg()), this.opts.log, url);
    }
    return this.parseJsonResponse(resp, url);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private parseJsonResponse(resp: AxiosResponse, url: string): any {
    // Status-code-based error mapping comes first so we don't depend on
    // matching Coway's localized message strings to recognize a 429 or 401.
    if (resp.status === 401) {
      throw new AuthError(`Coway auth error on ${url}: HTTP 401`);
    }
    if (resp.status === 429) {
      throw new RateLimitedError(
        `Coway rate-limited on ${url}: HTTP 429. Wait at least an hour before retrying.`,
      );
    }
    if (resp.status >= 500) {
      throw new Error(`Coway server error on ${url}: HTTP ${resp.status}`);
    }

    const body = resp.data;
    if (!body || typeof body !== 'object') {
      throw new Error(`Coway returned non-JSON for ${url}`);
    }
    if (body.error) {
      const message = body.error?.message ?? JSON.stringify(body.error);
      if (message === ErrorMessage.INVALID_REFRESH_TOKEN || message === ErrorMessage.BAD_TOKEN) {
        throw new AuthError(`Coway auth error on ${url}: ${message}`);
      }
      throw new Error(`Coway error on ${url}: ${message}`);
    }
    return body;
  }

  private authHeaders(): Record<string, string> {
    if (!this.tokens?.accessToken) {
      throw new Error('CowayClient: missing access token');
    }
    return {
      'region': 'NUS',
      'content-type': Header.CONTENT_JSON,
      'accept': '*/*',
      'authorization': `Bearer ${this.tokens.accessToken}`,
      'accept-language': Header.COWAY_LANGUAGE,
      'user-agent': Header.COWAY_USER_AGENT,
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

  private async forceRefresh(): Promise<void> {
    if (!this.tokens?.refreshToken) {
      throw new Error('CowayClient: cannot refresh without a refresh token');
    }
    this.opts.log.debug('Coway: refreshing access token');
    try {
      this.tokens = await refreshAccessToken(this.tokens.refreshToken);
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

// --- Retry helper ---

/**
 * Run an axios call with exponential backoff on transient failures
 * (5xx and 429). Stops after RETRY_MAX_ATTEMPTS or as soon as the response
 * looks final (anything else, including 4xx auth errors). The caller still
 * gets the last response if every attempt failed — they decide whether to
 * propagate that as an exception.
 */
async function withRetry<T = unknown>(
  attempt: () => Promise<AxiosResponse<T>>,
  log: Logger,
  context: string,
): Promise<AxiosResponse<T>> {
  let delay = RETRY_INITIAL_DELAY_MS;
  let last: AxiosResponse<T> | undefined;
  for (let i = 1; i <= RETRY_MAX_ATTEMPTS; i++) {
    last = await attempt();
    if (!isRetryableStatus(last.status)) {
      if (i > 1) {
        log.debug(`Coway ${context}: succeeded after ${i} attempt(s).`);
      }
      return last;
    }
    if (i === RETRY_MAX_ATTEMPTS) break;
    // Add jitter so multiple devices polling on the same interval don't all
    // re-hit Coway in lockstep when it returns a 5xx wave.
    const jitter = Math.random() * 500;
    log.debug(
      `Coway ${context}: HTTP ${last.status}, retrying in ${Math.round((delay + jitter) / 100) / 10}s ` +
      `(attempt ${i + 1}/${RETRY_MAX_ATTEMPTS}).`,
    );
    await sleep(delay + jitter);
    delay = Math.min(delay * 2, RETRY_MAX_DELAY_MS);
  }
  log.warn(`Coway ${context}: gave up after ${RETRY_MAX_ATTEMPTS} attempts (last status ${last!.status}).`);
  return last!;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// --- HTML scrape and state-assembly helpers (module-private) ---

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObj = Record<string, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PurifierScrape = AnyObj;

interface SuppliesEntry {
  supplyNm?: string;
  filterRemain?: number;
  replaceCycle?: number;
}

/**
 * The Airmega state HTML has a single <script> tag whose body contains the
 * product page's full JSON state model. cowayaio targets it via
 * `script:-soup-contains("sensorInfo")` and slices from first `{` to last `}`.
 *
 * Coway embeds the JSON with one round of string-escaping (so `"foo"` arrives
 * as `\"foo\"`, etc.). cowayaio handles this by stripping every backslash —
 * which works against the live API today but corrupts any string that
 * legitimately contains a backslash. We layer a safer approach on top:
 *
 *   1. Try parsing the slice as plain JSON. If Coway ever stops over-escaping
 *      this just works.
 *   2. Fall back to the cowayaio-style blanket strip and parse again.
 *
 * Both attempts run a reviver that drops `__proto__` / `constructor` /
 * `prototype` keys to block prototype-pollution gadgets in case the input is
 * tampered with despite our TLS + host-validation defenses.
 */
function extractPurifierJsonFromHtml(html: string): PurifierScrape | null {
  const scriptRe = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = scriptRe.exec(html)) !== null) {
    const body = match[1];
    if (!body.includes('sensorInfo')) continue;
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start < 0 || end <= start) continue;
    const raw = body.slice(start, end + 1);

    // Path 1: maybe Coway is already returning plain JSON.
    const direct = safeJsonParse(raw);
    if (direct) return direct as PurifierScrape;

    // Path 2: cowayaio's blanket-strip fallback for the current
    // double-escaped form. Lossy for fields with legitimate backslashes,
    // but matches the live shape today.
    const stripped = safeJsonParse(raw.replace(/\\/g, ''));
    if (stripped) return stripped as PurifierScrape;
  }
  return null;
}

const DANGEROUS_JSON_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * `JSON.parse` with a reviver that strips keys commonly used in
 * prototype-pollution exploits. Returns null if the input doesn't parse —
 * the caller decides whether to fall back to a different decoding strategy.
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

function findFirstObject(arr: unknown): AnyObj | null {
  if (!Array.isArray(arr)) return null;
  for (const item of arr) {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      return item as AnyObj;
    }
  }
  return null;
}

function readPath<T>(obj: AnyObj | null | undefined, path: string): T | undefined {
  if (!obj) return undefined;
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

function modeFromRegister(value: unknown): DeviceState['mode'] {
  switch (value) {
    case 1: return 'auto';
    case 2: return 'night';
    case 5: return 'rapid';
    case 6: return 'eco';
    default: return 'manual';
  }
}

function aqLevelFromGrade(grade: unknown): DeviceState['airQuality'] {
  if (grade === 1 || grade === 2 || grade === 3 || grade === 4) return grade;
  return 1;
}

function clampFanSpeed(v: unknown): DeviceState['fanSpeed'] {
  const n = Number(v);
  if (Number.isFinite(n) && n >= 1 && n <= 6) return Math.trunc(n) as DeviceState['fanSpeed'];
  return 1;
}

function pickNumber(...vals: unknown[]): number | undefined {
  for (const v of vals) {
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
): DeviceState {
  const power = status['0001'] === 1;
  const mode = modeFromRegister(status['0002']);
  const fanSpeed = clampFanSpeed(status['0003']);
  // 400S binary light: 0=off, 2=on. Other models use the same register but with
  // different value semantics; for v1 we only target the 400S.
  const lightOn = status['0007'] === 2;
  const timerMinutesRemaining = pickNumber(status['0008']);

  // Filter percentages: prefer the /supplies endpoint (canonical), fall back to
  // a sensor-derived "100 - usedPct" if Coway hasn't populated supplies yet
  // (the 250S endpoint is still under development per cowayaio comments).
  const preFilterEntry = supplies.find(s => s.supplyNm === 'Pre-Filter');
  const max2Entry = supplies.find(s => s.supplyNm !== 'Pre-Filter');

  const preFilterPct = preFilterEntry?.filterRemain
    ?? sensorDerivedFilterPct(sensors, '0011');
  const max2FilterPct = max2Entry?.filterRemain
    ?? sensorDerivedFilterPct(sensors, '0012');

  const pm25 = pickNumber(sensors['0001'], sensors.PM25_IDX);
  const pm10 = pickNumber(sensors['0002'], sensors.PM10_IDX);
  const airQuality = aqLevelFromGrade(aqGrade?.iaqGrade);

  return {
    power,
    mode,
    fanSpeed,
    lightOn,
    airQuality,
    pm25,
    pm10,
    preFilterPct: preFilterPct ?? 100,
    max2FilterPct: max2FilterPct ?? 100,
    timerMinutesRemaining,
    mcuVersion,
  };
}

function sensorDerivedFilterPct(sensors: AnyObj, key: string): number | undefined {
  const used = pickNumber(sensors[key]);
  if (used === undefined) return undefined;
  return Math.max(0, Math.min(100, 100 - used));
}
