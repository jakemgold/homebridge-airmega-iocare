"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RATE_LIMIT_BACKOFF_MS = exports.RateLimitedError = exports.PasswordExpiredError = exports.AuthError = void 0;
exports.performLogin = performLogin;
exports.refreshAccessToken = refreshAccessToken;
const axios_1 = __importDefault(require("axios"));
const url_1 = require("url");
const endpoints_1 = require("./endpoints");
const http_1 = require("./http");
const redact_1 = require("./redact");
// cowayaio reports the access token lifetime is 1 hour; we mirror that and
// refresh proactively when the expiration is within 5 minutes.
const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
// We extract URLs from HTML at two points in the login flow and then send
// either the user's password (form action URL) or read an auth code (final
// redirect URL) against them. Both URLs must live on a Coway host — anything
// else is either a Coway HTML change we should fail on or a hostile response.
const COWAY_AUTH_HOST = 'id.coway.com';
const COWAY_BRIDGE_HOST = 'iocare-redirect.iotsvc.coway.com';
class AuthError extends Error {
}
exports.AuthError = AuthError;
class PasswordExpiredError extends Error {
}
exports.PasswordExpiredError = PasswordExpiredError;
class RateLimitedError extends Error {
}
exports.RateLimitedError = RateLimitedError;
// How long to stay away after a RateLimitedError: the full hour Coway's own
// error message asks for. Retrying sooner deepens the block.
exports.RATE_LIMIT_BACKOFF_MS = 60 * 60 * 1000;
/**
 * Run the IoCare+ OAuth-style login flow:
 *  1. GET the keycloak login page; capture cookies and the form action URL
 *     (which contains a session_code).
 *  2. POST username + password to that action URL. Then either:
 *     - Coway responds with a "Password change message" page: if the caller
 *       opted in to skipping, POST the skip-form once; axios follows the
 *       redirect to .../redirect_bridge_empty.html?code=<auth_code> and we
 *       read the auth code off the final request path.
 *     - Otherwise, get the auth code from the r2 login (see authenticateViaR2).
 *  3. POST the auth code to /com/token to exchange for access + refresh tokens.
 */
async function performLogin(params) {
    const { username, log } = params;
    // Mask the local part of the username in debug logs so a shared bug-report
    // log doesn't leak the full account email/phone.
    const maskedUser = (0, redact_1.maskEmail)(username);
    log.debug(`Coway: starting login for ${maskedUser}`);
    const { loginActionUrl, cookies } = await fetchLoginPage(log);
    const authCode = await submitCredentials(loginActionUrl, cookies, params);
    const tokens = await exchangeCodeForTokens(authCode, log);
    log.debug(`Coway: login complete for ${maskedUser}`);
    return tokens;
}
async function refreshAccessToken(refreshToken, log) {
    const url = `${endpoints_1.Endpoint.BASE_URI}${endpoints_1.Endpoint.TOKEN_REFRESH}`;
    const resp = await (0, http_1.withRetry)(() => axios_1.default.post(url, { refreshToken }, {
        headers: {
            'content-type': endpoints_1.Header.CONTENT_JSON,
            'accept': '*/*',
            'accept-language': endpoints_1.Header.COWAY_LANGUAGE,
            'user-agent': endpoints_1.Header.USER_AGENT,
        },
        ...(0, http_1.baseRequestConfig)(),
    }), log, 'token refresh');
    // Status-based mapping comes first. Without this, a 429 or 5xx falls through
    // to "no tokens in body" → AuthError → full username+password re-login in
    // forceRefresh, which hammers Coway exactly when it's already unhappy.
    // A plain Error here lets the calling poll cycle log and try again next tick.
    if (resp.status === 429) {
        throw new RateLimitedError(`Coway rate-limited on token refresh: HTTP 429. Wait at least an hour before retrying.`);
    }
    if (resp.status >= 500) {
        throw new Error(`Coway server error on token refresh: HTTP ${resp.status}`);
    }
    const body = resp.data;
    if (body?.error?.message === endpoints_1.ErrorMessage.INVALID_REFRESH_TOKEN) {
        throw new AuthError('Coway refresh token is no longer valid; need to re-login.');
    }
    const accessToken = body?.data?.accessToken;
    const newRefresh = body?.data?.refreshToken;
    if (!accessToken || !newRefresh) {
        throw new AuthError(`Coway token refresh failed: ${(0, redact_1.redactBody)(body)}`);
    }
    return {
        accessToken,
        refreshToken: newRefresh,
        expiresAt: Date.now() + ACCESS_TOKEN_TTL_MS,
    };
}
// --- helpers below ---
async function fetchLoginPage(log) {
    const params = {
        auth_type: '0',
        response_type: 'code',
        client_id: endpoints_1.Parameter.CLIENT_ID,
        redirect_uri: endpoints_1.Endpoint.REDIRECT_URL,
        ui_locales: 'en',
    };
    const resp = await (0, http_1.withRetry)(() => axios_1.default.get(endpoints_1.Endpoint.OAUTH_URL, {
        params,
        headers: {
            'user-agent': endpoints_1.Header.USER_AGENT,
            'accept': endpoints_1.Header.ACCEPT,
            'accept-language': endpoints_1.Header.ACCEPT_LANG,
        },
        ...(0, http_1.baseRequestConfig)(),
    }), log, 'login page');
    if (resp.status === 503) {
        throw new Error('Coway servers are undergoing maintenance.');
    }
    if (resp.status === 429) {
        // Typed so discovery's retry loop backs off the full hour instead of
        // its normal cadence.
        throw new RateLimitedError('Coway rate-limited on login page: HTTP 429. Wait at least an hour before retrying.');
    }
    if (resp.status !== 200) {
        throw new Error(`Coway login page fetch failed: HTTP ${resp.status}`);
    }
    const html = String(resp.data ?? '');
    const loginActionUrl = extractFormAction(html, 'kc-form-login');
    if (!loginActionUrl) {
        throw new Error('Coway login page did not contain a kc-form-login action URL.');
    }
    const cookies = collectCookies(resp);
    return { loginActionUrl, cookies };
}
async function submitCredentials(actionUrl, cookies, params) {
    // Defense in depth: the action URL came out of HTML, so validate it points
    // at Coway's auth host before we send the password to it.
    assertCowayHost(actionUrl, COWAY_AUTH_HOST, 'login form action');
    const formBody = new url_1.URLSearchParams({
        clientName: endpoints_1.Parameter.CLIENT_NAME,
        termAgreementStatus: '',
        idp: '',
        username: params.username,
        password: params.password,
        rememberMe: 'on',
    }).toString();
    const resp = await (0, http_1.withRetry)(() => axios_1.default.post(actionUrl, formBody, {
        headers: {
            'content-type': 'application/x-www-form-urlencoded',
            'user-agent': endpoints_1.Header.USER_AGENT,
            'cookie': cookies,
        },
        maxRedirects: 5,
        ...(0, http_1.baseRequestConfig)(),
    }), params.log, 'credentials submit');
    // Map only rate-limit and server errors here; 4xx pages still carry HTML
    // that the checks below turn into friendlier errors (bad credentials,
    // password-change prompt).
    if (resp.status === 429) {
        throw new RateLimitedError('Coway rate-limited on credentials submit: HTTP 429. Wait at least an hour before retrying.');
    }
    if (resp.status >= 500) {
        throw new Error(`Coway credentials submit failed: HTTP ${resp.status}`);
    }
    const html = String(resp.data ?? '');
    if (extractTitle(html) === 'Coway - Password change message') {
        if (!params.skipPasswordChange) {
            throw new PasswordExpiredError("Coway is requesting a password change (the password hasn't been changed for 60 days or more).");
        }
        params.log.warn('Coway requested a password change for this account; skipping for now. ' +
            'Eventually rotate the password in the IoCare+ app.');
        // Merge Set-Cookie from this response over the login-page cookies before
        // the skip POST. Keycloak can rotate its session cookies between login
        // steps; replaying only the original cookie string on the password-skip
        // form gets an expired-page response instead of the bridge redirect. The
        // reference implementation gets this for free from its session cookie jar.
        return await submitPasswordSkip(html, mergeCookies(cookies, resp), params);
    }
    if (html.includes('Your ID or password is incorrect.')) {
        throw new AuthError('Coway login failed: invalid username or password.');
    }
    // For accounts Coway isn't prompting for a password change, this form no
    // longer yields a usable auth code (the token endpoint rejects it as an
    // invalid authorization code). Those accounts log in through r2, matching
    // cowayaio.
    return await authenticateViaR2(params);
}
async function submitPasswordSkip(passwordChangeHtml, cookies, params) {
    const skipActionUrl = extractFormAction(passwordChangeHtml, 'kc-password-change-form');
    if (!skipActionUrl) {
        throw new AuthError('Coway password-change page did not contain a kc-password-change-form action URL.');
    }
    // Same host check as the login form action URL.
    assertCowayHost(skipActionUrl, COWAY_AUTH_HOST, 'password-skip form action');
    const formBody = new url_1.URLSearchParams({
        cmd: 'change_next_time',
        checkPasswordNeededYn: 'Y',
        current_password: '',
        new_password: '',
        new_password_confirm: '',
    }).toString();
    const resp = await (0, http_1.withRetry)(() => axios_1.default.post(skipActionUrl, formBody, {
        headers: {
            'content-type': 'application/x-www-form-urlencoded',
            'user-agent': endpoints_1.Header.USER_AGENT,
            'cookie': cookies,
        },
        maxRedirects: 5,
        ...(0, http_1.baseRequestConfig)(),
    }), params.log, 'password-skip submit');
    // After skipping we expect the bridge redirect with a code.
    const finalPath = readFinalPath(resp);
    if (!finalPath?.includes('redirect_bridge_empty.html')) {
        const title = extractTitle(String(resp.data ?? ''));
        throw new AuthError(`Coway login failed; unexpected page after password-change skip (title=${title ?? 'unknown'}).`);
    }
    // Defense in depth: confirm we actually landed on Coway's bridge host
    // before extracting an auth code from its query string.
    assertCowayHost(finalPath, COWAY_BRIDGE_HOST, 'final redirect');
    const code = extractAuthCodeFromPath(finalPath);
    if (!code) {
        throw new AuthError('Coway redirected to bridge URL but no auth code was found.');
    }
    return code;
}
/**
 * Log in through Coway's r2 authorization service: start a session to pick up
 * its CSRF cookie, POST the credentials as JSON, and read the auth code off
 * the redirect URI in the JSON response.
 */
async function authenticateViaR2(params) {
    const { cookies, xsrfToken } = await startR2Session(params.log);
    const cookieHeader = cookies.headerFor(endpoints_1.Endpoint.R2_AUTHENTICATE_URL);
    const resp = await (0, http_1.withRetry)(() => axios_1.default.post(endpoints_1.Endpoint.R2_AUTHENTICATE_URL, {
        username: params.username,
        password: params.password,
        is_remember_me: true,
        client_id: endpoints_1.Parameter.CLIENT_ID,
        redirect_uri: endpoints_1.Endpoint.REDIRECT_URL,
    }, {
        headers: {
            'content-type': endpoints_1.Header.CONTENT_JSON,
            'user-agent': endpoints_1.Header.USER_AGENT,
            'x-xsrf-token': xsrfToken,
            ...(cookieHeader ? { cookie: cookieHeader } : {}),
        },
        ...(0, http_1.baseRequestConfig)(),
    }), params.log, 'r2 credentials submit');
    if (resp.status === 429) {
        throw new RateLimitedError('Coway rate-limited on r2 credentials submit: HTTP 429. Wait at least an hour before retrying.');
    }
    if (resp.status >= 500) {
        throw new Error(`Coway r2 credentials submit failed: HTTP ${resp.status}`);
    }
    if (resp.data?.error === 'invalid_credential') {
        throw new AuthError('Coway login failed: invalid username or password.');
    }
    if (resp.status !== 200) {
        throw new AuthError(`Coway r2 login failed: HTTP ${resp.status} (body=${(0, redact_1.redactBody)(resp.data)})`);
    }
    const redirectUri = resp.data?.redirect_uri;
    if (typeof redirectUri !== 'string') {
        throw new AuthError(`Coway r2 login returned no redirect URI (body=${(0, redact_1.redactBody)(resp.data)})`);
    }
    assertCowayHost(redirectUri, COWAY_BRIDGE_HOST, 'r2 redirect');
    const code = extractAuthCodeFromPath(redirectUri);
    if (!code) {
        throw new AuthError('Coway r2 login redirect carried no auth code.');
    }
    return code;
}
// The r2 session start bounces through Keycloak and back over several
// redirects and sets its CSRF cookie on an intermediate hop. axios only
// exposes the final response's headers, so we follow the hops ourselves and
// collect cookies along the way.
const R2_MAX_REDIRECTS = 8;
async function startR2Session(log) {
    const cookies = new CookieJar();
    const start = new url_1.URL(endpoints_1.Endpoint.R2_OAUTH_URL);
    start.search = new url_1.URLSearchParams({
        response_type: 'code',
        client_id: endpoints_1.Parameter.CLIENT_ID,
        redirect_uri: endpoints_1.Endpoint.REDIRECT_URL,
        ui_locales: 'en',
        scope: 'openid profile email',
    }).toString();
    let url = start.toString();
    for (let hop = 0; hop <= R2_MAX_REDIRECTS; hop++) {
        assertCowayHost(url, COWAY_AUTH_HOST, 'r2 session redirect');
        const target = url;
        const cookieHeader = cookies.headerFor(target);
        const resp = await (0, http_1.withRetry)(() => axios_1.default.get(target, {
            headers: {
                'content-type': 'application/x-www-form-urlencoded',
                'user-agent': endpoints_1.Header.USER_AGENT,
                ...(cookieHeader ? { cookie: cookieHeader } : {}),
            },
            maxRedirects: 0,
            ...(0, http_1.baseRequestConfig)(),
        }), log, 'r2 session start');
        cookies.absorb(resp);
        if (resp.status === 429) {
            throw new RateLimitedError('Coway rate-limited on r2 session start: HTTP 429. Wait at least an hour before retrying.');
        }
        if (resp.status >= 300 && resp.status < 400) {
            const location = resp.headers?.location;
            if (typeof location !== 'string') {
                throw new AuthError(`Coway r2 session start: HTTP ${resp.status} without a location.`);
            }
            url = new url_1.URL(location, target).toString();
            continue;
        }
        if (resp.status !== 200) {
            throw new Error(`Coway r2 session start failed: HTTP ${resp.status}`);
        }
        const xsrfToken = cookies.get(endpoints_1.R2_XSRF_COOKIE);
        if (!xsrfToken) {
            throw new AuthError('Coway r2 session start did not set a CSRF token.');
        }
        return { cookies, xsrfToken };
    }
    throw new AuthError('Coway r2 session start redirected too many times.');
}
/**
 * Just enough of a cookie jar for the r2 login: remembers cookies across
 * redirect hops and sends each one only to paths under its Path attribute,
 * so Keycloak's realm-scoped session cookies stay with Keycloak.
 */
class CookieJar {
    cookies = new Map();
    absorb(resp) {
        const setCookie = resp.headers?.['set-cookie'];
        if (!setCookie)
            return;
        for (const line of Array.isArray(setCookie) ? setCookie : [setCookie]) {
            const [pair, ...attrs] = String(line).split(';');
            const eq = pair.indexOf('=');
            if (eq <= 0)
                continue;
            const name = pair.slice(0, eq).trim();
            let path = '/';
            let expired = false;
            for (const attr of attrs) {
                const [rawKey, rawValue = ''] = attr.split('=');
                const key = rawKey.trim().toLowerCase();
                const value = rawValue.trim();
                if (key === 'path' && value)
                    path = value;
                if (key === 'max-age' && value !== '' && Number(value) <= 0)
                    expired = true;
            }
            if (expired) {
                this.cookies.delete(name);
            }
            else {
                this.cookies.set(name, { value: pair.slice(eq + 1).trim(), path });
            }
        }
    }
    get(name) {
        return this.cookies.get(name)?.value;
    }
    headerFor(url) {
        const path = new url_1.URL(url).pathname;
        return [...this.cookies.entries()]
            .filter(([, cookie]) => path.startsWith(cookie.path))
            .map(([name, cookie]) => `${name}=${cookie.value}`)
            .join('; ');
    }
}
async function exchangeCodeForTokens(authCode, log) {
    const url = `${endpoints_1.Endpoint.BASE_URI}${endpoints_1.Endpoint.GET_TOKEN}`;
    const resp = await (0, http_1.withRetry)(() => axios_1.default.post(url, { authCode, redirectUrl: endpoints_1.Endpoint.REDIRECT_URL }, {
        headers: {
            'content-type': endpoints_1.Header.CONTENT_JSON,
            'user-agent': endpoints_1.Header.USER_AGENT,
            'accept-language': endpoints_1.Header.COWAY_LANGUAGE,
        },
        ...(0, http_1.baseRequestConfig)(),
    }), log, 'token exchange');
    // Status-based mapping before body parsing, same rationale as the refresh
    // endpoint above: a 429/5xx must not fall through to a generic AuthError.
    if (resp.status === 429) {
        throw new RateLimitedError('Coway rate-limited on token exchange: HTTP 429. Wait at least an hour before retrying.');
    }
    if (resp.status >= 500) {
        throw new Error(`Coway server error on token exchange: HTTP ${resp.status}`);
    }
    const body = resp.data;
    if (body?.error?.message === endpoints_1.ErrorMessage.INVALID_GRANT) {
        throw new RateLimitedError('Coway token endpoint returned invalid_grant. The account may be temporarily ' +
            'rate-limited; wait before retrying. If you also cannot log in via the IoCare+ app, ' +
            'contact Coway support.');
    }
    if (body?.error) {
        throw new AuthError(`Coway token exchange failed: ${body.error.message ?? (0, redact_1.redactBody)(body.error)}`);
    }
    const accessToken = body?.data?.accessToken;
    const refreshToken = body?.data?.refreshToken;
    if (!accessToken || !refreshToken) {
        throw new AuthError(`Coway token exchange returned no tokens: ${(0, redact_1.redactBody)(body)}`);
    }
    return {
        accessToken,
        refreshToken,
        expiresAt: Date.now() + ACCESS_TOKEN_TTL_MS,
    };
}
// --- Host validation ---
/**
 * Throw an AuthError if `rawUrl` doesn't parse, or if its host isn't the one
 * we expect. We use this to check URLs we extracted from Coway's HTML before
 * we either send credentials to them or extract auth codes from them — closes
 * a defense-in-depth gap in case Coway's auth pages are ever compromised or
 * the response is tampered with at the TLS boundary.
 */
function assertCowayHost(rawUrl, expectedHost, context) {
    let parsed;
    try {
        parsed = new url_1.URL(rawUrl);
    }
    catch {
        throw new AuthError(`Coway returned an invalid URL for ${context}.`);
    }
    if (parsed.hostname !== expectedHost) {
        throw new AuthError(`Coway ${context} URL host mismatch: expected ${expectedHost}, got ${parsed.hostname}.`);
    }
    if (parsed.protocol !== 'https:') {
        throw new AuthError(`Coway ${context} URL is not HTTPS: got ${parsed.protocol}.`);
    }
}
// --- HTML parsing helpers ---
// Find <form id="<formId>" action="..."> and return the action attribute value,
// regardless of attribute ordering. Coway returns valid Keycloak HTML so the
// regex covers double-quoted attributes only — matches what cowayaio's
// BeautifulSoup query (.find('form', id=...)) extracts.
function extractFormAction(html, formId) {
    const pattern = new RegExp(`<form\\b[^>]*\\bid\\s*=\\s*"${escapeRegex(formId)}"[^>]*\\baction\\s*=\\s*"([^"]+)"|` +
        `<form\\b[^>]*\\baction\\s*=\\s*"([^"]+)"[^>]*\\bid\\s*=\\s*"${escapeRegex(formId)}"`, 'i');
    const m = html.match(pattern);
    if (!m)
        return null;
    // HTML entities like &amp; show up in action URLs from keycloak.
    const raw = m[1] ?? m[2];
    return decodeHtmlEntities(raw);
}
function extractTitle(html) {
    const m = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    return m ? m[1].trim() : null;
}
function extractAuthCodeFromPath(path) {
    const queryIndex = path.indexOf('?');
    if (queryIndex < 0)
        return null;
    const query = path.slice(queryIndex + 1);
    const params = new url_1.URLSearchParams(query);
    return params.get('code');
}
// After axios follows redirects, the final request's path tells us where we ended
// up. Both `responseUrl` (set by follow-redirects on the underlying http request)
// and `request.path` are populated; we prefer the full URL when available.
function readFinalPath(resp) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const req = resp.request;
    if (req?.res?.responseUrl)
        return req.res.responseUrl;
    if (typeof req?.path === 'string')
        return req.path;
    return null;
}
function collectCookies(resp) {
    const setCookie = resp.headers?.['set-cookie'];
    if (!setCookie)
        return '';
    const list = Array.isArray(setCookie) ? setCookie : [setCookie];
    // We only want the name=value portion of each Set-Cookie, joined by '; '.
    return list
        .map(line => String(line).split(';')[0].trim())
        .filter(s => s.length > 0)
        .join('; ');
}
/**
 * Merge Set-Cookie values from `resp` over an existing cookie string, with
 * the response's values winning on name collisions. This stands in for the
 * session cookie jar the reference implementation uses: without it, cookies
 * Keycloak rotates mid-flow (session IDs between the credentials POST and
 * the password-skip POST) would be replayed stale. Cookies set on
 * intermediate redirect hops are still invisible here — axios only exposes
 * the final response's headers — but the final hop is where Keycloak sets
 * the ones the next form POST needs.
 */
function mergeCookies(base, resp) {
    const fresh = collectCookies(resp);
    if (!fresh)
        return base;
    if (!base)
        return fresh;
    const jar = new Map();
    for (const part of `${base}; ${fresh}`.split(';')) {
        const eq = part.indexOf('=');
        if (eq <= 0)
            continue;
        jar.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
    }
    return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}
function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function decodeHtmlEntities(s) {
    return s
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
}
//# sourceMappingURL=auth.js.map