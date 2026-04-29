"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CowayClient = void 0;
const axios_1 = __importDefault(require("axios"));
const auth_1 = require("./auth");
const endpoints_1 = require("./endpoints");
// Refresh proactively when the token has under 5 minutes of life left,
// matching cowayaio's behavior.
const REFRESH_LEAD_MS = 5 * 60 * 1000;
class CowayClient {
    opts;
    tokens;
    countryCode;
    places = [];
    constructor(opts) {
        this.opts = opts;
    }
    /**
     * Run the full IoCare+ login flow, then prime the country code and places
     * cache so `listDevices()` can iterate without further auth-related round
     * trips.
     */
    async login() {
        this.tokens = await (0, auth_1.performLogin)({
            username: this.opts.username,
            password: this.opts.password,
            skipPasswordChange: this.opts.skipPasswordChange,
            log: this.opts.log,
        });
        this.opts.log.info('Logged in to Coway IoCare+.');
        this.countryCode = await this.fetchCountryCode();
        this.places = await this.fetchPlaces();
        this.opts.log.debug(`Coway: countryCode=${this.countryCode}, places=${this.places.length}`);
    }
    async listDevices() {
        if (!this.tokens || !this.countryCode) {
            throw new Error('CowayClient.listDevices() called before login()');
        }
        const result = [];
        for (const place of this.places) {
            if (!place.deviceCnt || place.deviceCnt <= 0) {
                this.opts.log.debug(`Coway: skipping empty place ${place.placeId} (${place.placeName ?? 'unnamed'})`);
                continue;
            }
            const rows = await this.fetchPlaceDevices(place.placeId);
            for (const row of rows) {
                if (row.categoryName !== endpoints_1.CATEGORY_NAME) {
                    this.opts.log.debug(`Coway: skipping non-purifier device ${row.dvcNick} (categoryName=${row.categoryName})`);
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
    async getDeviceState(device) {
        if (!this.tokens) {
            throw new Error('CowayClient.getDeviceState() called before login()');
        }
        const [purifierJson, supplies] = await Promise.all([
            this.fetchPurifierJson(device),
            this.fetchSupplies(device),
        ]);
        const purifierInfo = findFirstObject(purifierJson?.children) ?? {};
        const status = readPath(purifierInfo, 'deviceStatusData.data.statusInfo.attributes') ?? {};
        const sensors = findSensorAttributes(purifierInfo);
        const aqGrade = readPath(purifierInfo, 'deviceModule.data.content.deviceModuleDetailInfo.airStatusInfo');
        return assembleDeviceState(status, sensors, aqGrade, supplies);
    }
    /**
     * Send a single Coway control attribute write to the device.
     * `attribute` is a hex-string from `Attribute.*` in deviceCodes.ts; `value`
     * is the value Coway expects for that attribute (almost always a string).
     */
    async sendCommand(device, attribute, value) {
        if (!this.tokens) {
            throw new Error('CowayClient.sendCommand() called before login()');
        }
        await this.ensureFreshToken();
        const url = `${endpoints_1.Endpoint.BASE_URI}${endpoints_1.Endpoint.PLACES}/${device.placeId}/devices/${device.deviceId}/control-status`;
        const payload = {
            attributes: { [attribute]: String(value) },
            isMultiControl: false,
            refreshFlag: false,
        };
        const resp = await axios_1.default.post(url, payload, {
            headers: this.authHeaders(),
            timeout: 15000,
            validateStatus: () => true,
        });
        const body = resp.data;
        if (body && typeof body === 'object' && body.header?.error_code) {
            throw new Error(`Coway command failed (${attribute}=${value}): ` +
                `${body.header.error_code} ${body.header.error_text ?? ''}`.trim());
        }
        this.opts.log.debug(`Coway: ${device.name} command sent (${attribute}=${value}); status=${resp.status}`);
    }
    // --- internals ---
    async fetchPurifierJson(device) {
        await this.ensureFreshToken();
        const url = `${endpoints_1.Endpoint.PURIFIER_HTML_BASE}/${device.placeId}/product/${device.modelCode}`;
        const resp = await axios_1.default.get(url, {
            headers: {
                'theme': endpoints_1.Header.THEME,
                'callingpage': endpoints_1.Header.CALLING_PAGE,
                'accept': endpoints_1.Header.ACCEPT,
                'dvcnick': device.name,
                'timezoneid': endpoints_1.Parameter.TIMEZONE,
                'appversion': endpoints_1.Parameter.APP_VERSION,
                // The HTML scrape endpoint uses a custom 'accesstoken' header, NOT
                // the standard Authorization Bearer. Verified against cowayaio.
                'accesstoken': this.tokens.accessToken,
                'accept-language': endpoints_1.Header.COWAY_LANGUAGE,
                'region': 'NUS',
                'user-agent': endpoints_1.Header.HTML_USER_AGENT,
                'srcpath': endpoints_1.Header.SOURCE_PATH,
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
            validateStatus: () => true,
            // The endpoint returns HTML; axios shouldn't try to parse JSON.
            responseType: 'text',
            transformResponse: [d => d],
        });
        if (resp.status !== 200 || typeof resp.data !== 'string') {
            throw new Error(`Coway purifier HTML fetch failed for ${device.name}: HTTP ${resp.status}`);
        }
        return extractPurifierJsonFromHtml(resp.data);
    }
    async fetchSupplies(device) {
        const url = `${endpoints_1.Endpoint.SECONDARY_BASE}${endpoints_1.Endpoint.PLACES}/${device.placeId}/devices/${device.deviceId}/supplies`;
        await this.ensureFreshToken();
        const resp = await axios_1.default.get(url, {
            headers: {
                'region': 'NUS',
                'accept': 'application/json, text/plain, */*',
                'authorization': `Bearer ${this.tokens.accessToken}`,
                'accept-language': endpoints_1.Header.COWAY_LANGUAGE,
                'user-agent': endpoints_1.Header.HTML_USER_AGENT,
            },
            params: {
                membershipYn: 'N',
                membershipType: '',
                langCd: endpoints_1.Header.ACCEPT_LANG,
            },
            timeout: 15000,
            validateStatus: () => true,
        });
        const list = resp.data?.data?.suppliesList;
        return Array.isArray(list) ? list : [];
    }
    mapDevice(row) {
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
    async fetchCountryCode() {
        const url = `${endpoints_1.Endpoint.BASE_URI}${endpoints_1.Endpoint.USER_INFO}`;
        const body = await this.authedJsonGet(url);
        const code = body?.data?.memberInfo?.countryCode;
        if (!code || typeof code !== 'string') {
            throw new Error(`Coway /com/my-info returned no countryCode (body=${JSON.stringify(body)})`);
        }
        return code;
    }
    async fetchPlaces() {
        const url = `${endpoints_1.Endpoint.BASE_URI}${endpoints_1.Endpoint.PLACES}`;
        const body = await this.authedJsonGet(url, {
            countryCode: this.countryCode,
            langCd: endpoints_1.Header.ACCEPT_LANG,
            pageIndex: '1',
            pageSize: '20',
            timezoneId: endpoints_1.Parameter.TIMEZONE,
        });
        const places = body?.data?.content;
        if (!Array.isArray(places)) {
            throw new Error(`Coway /com/places returned no content (body=${JSON.stringify(body)})`);
        }
        return places;
    }
    async fetchPlaceDevices(placeId) {
        const url = `${endpoints_1.Endpoint.BASE_URI}${endpoints_1.Endpoint.PLACES}/${placeId}/devices`;
        const body = await this.authedJsonGet(url, {
            pageIndex: '0',
            pageSize: '100',
        });
        const devices = body?.data?.content;
        return Array.isArray(devices) ? devices : [];
    }
    /**
     * GET a JSON endpoint with the standard authorized headers, refreshing the
     * access token first if it's close to expiry. On a 401 we attempt one
     * refresh-and-retry before giving up.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async authedJsonGet(url, params) {
        await this.ensureFreshToken();
        const cfg = {
            headers: this.authHeaders(),
            params,
            timeout: 15000,
            validateStatus: () => true,
        };
        let resp = await axios_1.default.get(url, cfg);
        if (resp.status === 401) {
            await this.forceRefresh();
            cfg.headers = this.authHeaders();
            resp = await axios_1.default.get(url, cfg);
        }
        return this.parseJsonBody(resp.data, url);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    parseJsonBody(body, url) {
        if (!body || typeof body !== 'object') {
            throw new Error(`Coway returned non-JSON for ${url}`);
        }
        if (body.error) {
            const message = body.error?.message ?? JSON.stringify(body.error);
            if (message === endpoints_1.ErrorMessage.INVALID_REFRESH_TOKEN || message === endpoints_1.ErrorMessage.BAD_TOKEN) {
                throw new auth_1.AuthError(`Coway auth error on ${url}: ${message}`);
            }
            throw new Error(`Coway error on ${url}: ${message}`);
        }
        return body;
    }
    authHeaders() {
        if (!this.tokens?.accessToken) {
            throw new Error('CowayClient: missing access token');
        }
        return {
            'region': 'NUS',
            'content-type': endpoints_1.Header.CONTENT_JSON,
            'accept': '*/*',
            'authorization': `Bearer ${this.tokens.accessToken}`,
            'accept-language': endpoints_1.Header.COWAY_LANGUAGE,
            'user-agent': endpoints_1.Header.COWAY_USER_AGENT,
        };
    }
    async ensureFreshToken() {
        if (!this.tokens) {
            throw new Error('CowayClient: not logged in');
        }
        if (this.tokens.expiresAt - Date.now() <= REFRESH_LEAD_MS) {
            await this.forceRefresh();
        }
    }
    async forceRefresh() {
        if (!this.tokens?.refreshToken) {
            throw new Error('CowayClient: cannot refresh without a refresh token');
        }
        this.opts.log.debug('Coway: refreshing access token');
        try {
            this.tokens = await (0, auth_1.refreshAccessToken)(this.tokens.refreshToken);
        }
        catch (err) {
            if (err instanceof auth_1.AuthError) {
                this.opts.log.warn('Coway refresh token rejected; performing full re-login.');
                this.tokens = await (0, auth_1.performLogin)({
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
exports.CowayClient = CowayClient;
/**
 * The Airmega state HTML has a single <script> tag whose body contains the
 * product page's full JSON state model. cowayaio targets it via
 * `script:-soup-contains("sensorInfo")` and slices from first `{` to last `}`,
 * stripping backslashes (the JSON arrives backslash-escaped). We mirror that
 * exactly — anything more clever risks drifting from the live shape.
 */
function extractPurifierJsonFromHtml(html) {
    const scriptRe = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
    let match;
    while ((match = scriptRe.exec(html)) !== null) {
        const body = match[1];
        if (!body.includes('sensorInfo'))
            continue;
        const start = body.indexOf('{');
        const end = body.lastIndexOf('}');
        if (start < 0 || end <= start)
            continue;
        const slice = body.slice(start, end + 1).replace(/\\/g, '');
        try {
            return JSON.parse(slice);
        }
        catch {
            // Try the next matching script tag in case there's a non-JSON candidate.
            continue;
        }
    }
    return null;
}
function findFirstObject(arr) {
    if (!Array.isArray(arr))
        return null;
    for (const item of arr) {
        if (item && typeof item === 'object' && !Array.isArray(item)) {
            return item;
        }
    }
    return null;
}
function readPath(obj, path) {
    if (!obj)
        return undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let cur = obj;
    for (const key of path.split('.')) {
        if (cur == null || typeof cur !== 'object')
            return undefined;
        cur = cur[key];
    }
    return cur;
}
/**
 * Walk purifier_info.coreData[*] and find the entry whose `data` carries a
 * `sensorInfo` block, then return its `attributes`. cowayaio does the same.
 */
function findSensorAttributes(purifierInfo) {
    const coreData = purifierInfo?.coreData;
    if (!Array.isArray(coreData))
        return {};
    for (const entry of coreData) {
        const sensorInfo = entry?.data?.sensorInfo;
        if (sensorInfo?.attributes && typeof sensorInfo.attributes === 'object') {
            return sensorInfo.attributes;
        }
    }
    return {};
}
function modeFromRegister(value) {
    switch (value) {
        case 1: return 'auto';
        case 2: return 'night';
        case 5: return 'rapid';
        case 6: return 'eco';
        default: return 'manual';
    }
}
function aqLevelFromGrade(grade) {
    if (grade === 1 || grade === 2 || grade === 3 || grade === 4)
        return grade;
    return 1;
}
function clampFanSpeed(v) {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 1 && n <= 6)
        return Math.trunc(n);
    return 1;
}
function pickNumber(...vals) {
    for (const v of vals) {
        const n = Number(v);
        if (Number.isFinite(n))
            return n;
    }
    return undefined;
}
function assembleDeviceState(status, sensors, aqGrade, supplies) {
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
    };
}
function sensorDerivedFilterPct(sensors, key) {
    const used = pickNumber(sensors[key]);
    if (used === undefined)
        return undefined;
    return Math.max(0, Math.min(100, 100 - used));
}
//# sourceMappingURL=cowayClient.js.map