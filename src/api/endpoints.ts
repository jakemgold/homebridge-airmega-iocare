// All Coway URL, parameter, and protocol literals live here — including the
// control-register vocabulary (Attribute/ModeValue/etc.), which serves BOTH
// directions: the write path sends these codes as commands, and the read path
// looks the same keys up in the scraped status block. One table, so the two
// sides can't drift.
// Source: RobertD502/cowayaio, kept in step through v0.2.8 (Oct 2026).
// OrigamiDream/homebridge-coway is on older endpoints
// (iocareapi.iot.coway.com vs cowayaio's iocare.iotsvc.coway.com) and was
// not used as the URL source.

import { PLUGIN_NAME, PLUGIN_VERSION } from '../settings';

export const Endpoint = {
  // Token + JSON-API host
  BASE_URI: 'https://iocare.iotsvc.coway.com/api/v1',
  GET_TOKEN: '/com/token',
  TOKEN_REFRESH: '/com/refresh-token',
  USER_INFO: '/com/my-info',
  PLACES: '/com/places',
  AIR: '/air/devices',
  NOTICES: '/com/notices',

  // OAuth / OIDC
  OAUTH_URL: 'https://id.coway.com/auth/realms/cw-account/protocol/openid-connect/auth',
  REDIRECT_URL: 'https://iocare-redirect.iotsvc.coway.com/redirect_bridge_empty.html',
  // r2 login, used by accounts Coway isn't prompting for a password change
  R2_OAUTH_URL: 'https://id.coway.com/r2/authorization/oidc/auth',
  R2_AUTHENTICATE_URL: 'https://id.coway.com/r2/authorization/authenticate-rest',

  // Per-device HTML page (state poll) + secondary JSON proxy (filters / timer)
  PURIFIER_HTML_BASE: 'https://iocare2.coway.com/en',
  SECONDARY_BASE: 'https://iocare2.coway.com/api/proxy/api/v1',
} as const;

export const Parameter = {
  CLIENT_ID: 'cwid-prd-iocare-plus-25MJGcYX',
  CLIENT_NAME: 'IOCARE',
  APP_VERSION: '2.15.0',
  TIMEZONE: 'America/Kentucky/Louisville',
} as const;

// CSRF cookie set when an r2 login session starts; its value goes back as the
// x-xsrf-token header on the credentials POST.
export const R2_XSRF_COOKIE = 'cwxsrf';

export const Header = {
  // Region header sent on JSON-API and scrape calls. Fixed to NUS (North
  // America) for now, matching cowayaio; the client fetches the account's
  // countryCode at login, so regionalization would derive this from that
  // instead — one constant to change when that day comes.
  REGION: 'NUS',
  // Used for the OAuth GET (mimics a browser hitting the keycloak login page).
  ACCEPT: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  ACCEPT_LANG: 'en',
  // Used on JSON API calls.
  COWAY_LANGUAGE: 'en-US,en;q=0.9',
  CONTENT_JSON: 'application/json',
  // Used on per-device HTML scrape requests.
  THEME: 'light',
  CALLING_PAGE: 'product',
  SOURCE_PATH: 'iOS',
  // Sent on every request. Coway tells IoCare+ clients apart by User-Agent
  // (cowayaio's maintainer arranged this with Coway for Home Assistant
  // traffic), so identify this plugin by name and version rather than
  // borrowing another client's.
  USER_AGENT: `${PLUGIN_NAME}/${PLUGIN_VERSION}`,
} as const;

// --- Control registers ---
// Coway addresses each control via a hex-string "attribute" key. The control
// endpoint accepts {attributes: {<key>: <value>}, ...}; command values are
// strings. The scraped status block reports state under the SAME keys but
// with numeric values, so readers compare via String(value) against the
// command-value constants below.

export const Attribute = {
  POWER: '0001',          // PowerValue below
  MODE: '0002',           // ModeValue below
  FAN_SPEED: '0003',      // '1' | '2' | '3' (device may REPORT higher values in special modes)
  LIGHT: '0007',          // LightMode below (400S-family binary semantics)
  TIMER: '0008',          // minutes: 0 | 60 | 120 | 240 | 480
  BUTTON_LOCK: '0024',    // 0=off, 1=on
  SMART_SENSITIVITY: '000A', // 1=sensitive, 2=moderate, 3=insensitive
} as const;

// Power register (0x0001) values.
export const PowerValue = {
  OFF: '0',
  ON: '1',
} as const;

// Mode register (0x0002) values, keyed by cowayaio's naming.
export const ModeValue = {
  AUTO: '1',
  NIGHT: '2',   // surfaced as the "Sleep" preset switch in HomeKit
  RAPID: '5',   // 250S only — surfaced as the "Smart" preset switch where supported
  ECO: '6',     // surfaced as the "Eco" preset switch in HomeKit
} as const;

// Light register (0x0007) values — 400S-family binary semantics (0=off, 2=on).
// The 250S and IconS use the SAME register with inverted, multi-mode values
// (cowayaio: ON='0', AQI_OFF='1', OFF='2', HALF_OFF='3'), which is why the
// light switch is gated per model in deviceCodes.ts rather than exposed
// universally.
export const LightMode = {
  OFF: '0',
  ON: '2',
} as const;

// Keys inside the scraped sensorInfo attributes block. NOTE: a different
// namespace from the control registers above, despite the identical-looking
// keys — sensor '0001' is PM2.5 while control '0001' is power.
export const SensorKey = {
  PM25: '0001',
  PM10: '0002',
  PM25_IDX: 'PM25_IDX',   // placeholder on models without a real PM2.5 sensor
  PM10_IDX: 'PM10_IDX',
  PRE_FILTER_USED_PCT: '0011',   // sensor-derived fallback when /supplies is empty
  MAX2_FILTER_USED_PCT: '0012',
} as const;

// Coway returns this localized string for air-purifier devices in the place-listing
// response. Verified live against the 400S — value is Korean even on a US-region
// account, so do not translate; match the literal.
export const CATEGORY_NAME = '청정기';

// Error message strings Coway returns on the token endpoint.
// We match these to surface specific exceptions instead of a generic failure.
export const ErrorMessage = {
  BAD_TOKEN: 'Unauthenticated (crypto/rsa: verification error)',
  EXPIRED_TOKEN: 'Unauthenticated (Token is expired)',
  INVALID_REFRESH_TOKEN: '통합회원 토큰 갱신 오류 (error: invalid_grant)(error_desc: Invalid refresh token)',
  INVALID_GRANT: '통합회원 토큰 발급 오류 (error: invalid_grant)(error_desc: Code not valid)',
} as const;
