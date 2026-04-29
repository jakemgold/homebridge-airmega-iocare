// All Coway URL and parameter literals live here.
// Source: ported from RobertD502/cowayaio v0.2.4 (Oct 2025) — the more recently
// updated reference. OrigamiDream/homebridge-coway is on older endpoints
// (iocareapi.iot.coway.com vs cowayaio's iocare.iotsvc.coway.com) and was
// not used as the URL source.

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

export const Header = {
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
  // cowayaio reuses its own UA across all three; we do the same. The literal
  // matters less than that it's stable across calls in a session.
  USER_AGENT: 'CowayAIO/0.2.4',
  COWAY_USER_AGENT: 'CowayAIO/0.2.4',
  HTML_USER_AGENT: 'CowayAIO/0.2.4',
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
