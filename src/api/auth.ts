import axios, { AxiosResponse } from 'axios';
import { Logger } from 'homebridge';
import { URL, URLSearchParams } from 'url';

import { Endpoint, Parameter, Header, ErrorMessage } from './endpoints';

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
}

export interface LoginParams {
  username: string;
  password: string;
  skipPasswordChange: boolean;
  log: Logger;
}

// cowayaio reports the access token lifetime is 1 hour; we mirror that and
// refresh proactively when the expiration is within 5 minutes.
const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;

// Cap any single response we accept from Coway. The HTML scrape is the largest
// legitimate response and runs ~50 KB; 2 MB gives a comfortable margin while
// preventing a misbehaving or hostile response from OOM-ing the Homebridge
// process via response-buffering inside axios.
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

// We extract URLs from HTML at two points in the login flow and then send
// either the user's password (form action URL) or read an auth code (final
// redirect URL) against them. Both URLs must live on a Coway host — anything
// else is either a Coway HTML change we should fail on or a hostile response.
const COWAY_AUTH_HOST = 'id.coway.com';
const COWAY_BRIDGE_HOST = 'iocare-redirect.iotsvc.coway.com';

export class AuthError extends Error {}
export class PasswordExpiredError extends Error {}
export class RateLimitedError extends Error {}

/**
 * Run the IoCare+ OAuth-style login flow:
 *  1. GET the keycloak login page; capture cookies and the form action URL
 *     (which contains a session_code).
 *  2. POST username + password to that action URL.
 *     - If Coway responds with a "Password change message" page and the caller
 *       opted in to skipping, POST the skip-form once and continue.
 *  3. axios follows the redirect to .../redirect_bridge_empty.html?code=<auth_code>;
 *     we read the auth code off the final request path.
 *  4. POST the auth code to /com/token to exchange for access + refresh tokens.
 */
export async function performLogin(params: LoginParams): Promise<AuthTokens> {
  const { username, log } = params;
  log.debug(`Coway: starting login for ${username}`);

  const { loginActionUrl, cookies } = await fetchLoginPage();
  const authCode = await submitCredentials(loginActionUrl, cookies, params);
  const tokens = await exchangeCodeForTokens(authCode);

  log.debug(`Coway: login complete for ${username}`);
  return tokens;
}

export async function refreshAccessToken(refreshToken: string): Promise<AuthTokens> {
  const url = `${Endpoint.BASE_URI}${Endpoint.TOKEN_REFRESH}`;
  const resp = await axios.post(
    url,
    { refreshToken },
    {
      headers: {
        'content-type': Header.CONTENT_JSON,
        'accept': '*/*',
        'accept-language': Header.COWAY_LANGUAGE,
        'user-agent': Header.COWAY_USER_AGENT,
      },
      timeout: 15000,
      maxContentLength: MAX_RESPONSE_BYTES,
      maxBodyLength: MAX_RESPONSE_BYTES,
      validateStatus: () => true,
    },
  );

  const body = resp.data;
  if (body?.error?.message === ErrorMessage.INVALID_REFRESH_TOKEN) {
    throw new AuthError('Coway refresh token is no longer valid; need to re-login.');
  }
  const accessToken = body?.data?.accessToken;
  const newRefresh = body?.data?.refreshToken;
  if (!accessToken || !newRefresh) {
    throw new AuthError(`Coway token refresh failed: ${JSON.stringify(body)}`);
  }
  return {
    accessToken,
    refreshToken: newRefresh,
    expiresAt: Date.now() + ACCESS_TOKEN_TTL_MS,
  };
}

// --- helpers below ---

async function fetchLoginPage(): Promise<{ loginActionUrl: string; cookies: string }> {
  const params = {
    auth_type: '0',
    response_type: 'code',
    client_id: Parameter.CLIENT_ID,
    redirect_uri: Endpoint.REDIRECT_URL,
    ui_locales: 'en',
  };
  const resp = await axios.get(Endpoint.OAUTH_URL, {
    params,
    headers: {
      'user-agent': Header.USER_AGENT,
      'accept': Header.ACCEPT,
      'accept-language': Header.ACCEPT_LANG,
    },
    timeout: 15000,
    maxContentLength: MAX_RESPONSE_BYTES,
    maxBodyLength: MAX_RESPONSE_BYTES,
    validateStatus: () => true,
  });

  if (resp.status === 503) {
    throw new Error('Coway servers are undergoing maintenance.');
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

async function submitCredentials(
  actionUrl: string,
  cookies: string,
  params: LoginParams,
): Promise<string> {
  // Defense in depth: the action URL came out of HTML, so validate it points
  // at Coway's auth host before we send the password to it.
  assertCowayHost(actionUrl, COWAY_AUTH_HOST, 'login form action');

  const formBody = new URLSearchParams({
    clientName: Parameter.CLIENT_NAME,
    termAgreementStatus: '',
    idp: '',
    username: params.username,
    password: params.password,
    rememberMe: 'on',
  }).toString();

  const resp = await axios.post(actionUrl, formBody, {
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': Header.USER_AGENT,
      'cookie': cookies,
    },
    timeout: 15000,
    maxRedirects: 5,
    maxContentLength: MAX_RESPONSE_BYTES,
    maxBodyLength: MAX_RESPONSE_BYTES,
    validateStatus: () => true,
  });

  return await handleAuthResponse(resp, cookies, params);
}

async function handleAuthResponse(
  resp: AxiosResponse,
  cookies: string,
  params: LoginParams,
): Promise<string> {
  const finalPath = readFinalPath(resp);
  if (finalPath?.includes('redirect_bridge_empty.html')) {
    // Defense in depth: confirm we actually landed on Coway's bridge host
    // before extracting an auth code from its query string.
    assertCowayHost(finalPath, COWAY_BRIDGE_HOST, 'final redirect');
    const code = extractAuthCodeFromPath(finalPath);
    if (!code) {
      throw new AuthError('Coway redirected to bridge URL but no auth code was found.');
    }
    return code;
  }

  // No bridge redirect — must be either the password-change page or an error page.
  const html = String(resp.data ?? '');
  const title = extractTitle(html);

  if (title === 'Coway - Password change message') {
    if (!params.skipPasswordChange) {
      throw new PasswordExpiredError(
        "Coway is requesting a password change (the password hasn't been changed for 60 days or more).",
      );
    }
    params.log.warn(
      'Coway requested a password change for this account; skipping for now. ' +
      'Eventually rotate the password in the IoCare+ app.',
    );
    return await submitPasswordSkip(html, cookies, params);
  }

  // Otherwise this is a generic failure — usually bad credentials.
  if (html.includes('Your ID or password is incorrect.')) {
    throw new AuthError('Coway login failed: invalid username or password.');
  }
  throw new AuthError(`Coway login failed; unexpected page (title=${title ?? 'unknown'}).`);
}

async function submitPasswordSkip(
  passwordChangeHtml: string,
  cookies: string,
  params: LoginParams,
): Promise<string> {
  const skipActionUrl = extractFormAction(passwordChangeHtml, 'kc-password-change-form');
  if (!skipActionUrl) {
    throw new AuthError('Coway password-change page did not contain a kc-password-change-form action URL.');
  }
  // Same host check as the login form action URL.
  assertCowayHost(skipActionUrl, COWAY_AUTH_HOST, 'password-skip form action');

  const formBody = new URLSearchParams({
    cmd: 'change_next_time',
    checkPasswordNeededYn: 'Y',
    current_password: '',
    new_password: '',
    new_password_confirm: '',
  }).toString();

  const resp = await axios.post(skipActionUrl, formBody, {
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': Header.USER_AGENT,
      'cookie': cookies,
    },
    timeout: 15000,
    maxRedirects: 5,
    maxContentLength: MAX_RESPONSE_BYTES,
    maxBodyLength: MAX_RESPONSE_BYTES,
    validateStatus: () => true,
  });

  // After skipping we expect the bridge redirect with a code.
  return await handleAuthResponse(resp, cookies, { ...params, skipPasswordChange: false });
}

async function exchangeCodeForTokens(authCode: string): Promise<AuthTokens> {
  const url = `${Endpoint.BASE_URI}${Endpoint.GET_TOKEN}`;
  const resp = await axios.post(
    url,
    { authCode, redirectUrl: Endpoint.REDIRECT_URL },
    {
      headers: {
        'content-type': Header.CONTENT_JSON,
        'user-agent': Header.COWAY_USER_AGENT,
        'accept-language': Header.COWAY_LANGUAGE,
      },
      timeout: 15000,
      maxContentLength: MAX_RESPONSE_BYTES,
      maxBodyLength: MAX_RESPONSE_BYTES,
      validateStatus: () => true,
    },
  );

  const body = resp.data;
  if (body?.error?.message === ErrorMessage.INVALID_GRANT) {
    throw new RateLimitedError(
      'Coway token endpoint returned invalid_grant. The account may be temporarily ' +
      'rate-limited; wait before retrying. If you also cannot log in via the IoCare+ app, ' +
      'contact Coway support.',
    );
  }
  if (body?.error) {
    throw new AuthError(`Coway token exchange failed: ${body.error.message ?? JSON.stringify(body.error)}`);
  }
  const accessToken = body?.data?.accessToken;
  const refreshToken = body?.data?.refreshToken;
  if (!accessToken || !refreshToken) {
    throw new AuthError(`Coway token exchange returned no tokens: ${JSON.stringify(body)}`);
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
function assertCowayHost(rawUrl: string, expectedHost: string, context: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new AuthError(`Coway returned an invalid URL for ${context}.`);
  }
  if (parsed.hostname !== expectedHost) {
    throw new AuthError(
      `Coway ${context} URL host mismatch: expected ${expectedHost}, got ${parsed.hostname}.`,
    );
  }
  if (parsed.protocol !== 'https:') {
    throw new AuthError(
      `Coway ${context} URL is not HTTPS: got ${parsed.protocol}.`,
    );
  }
}

// --- HTML parsing helpers ---

// Find <form id="<formId>" action="..."> and return the action attribute value,
// regardless of attribute ordering. Coway returns valid Keycloak HTML so the
// regex covers double-quoted attributes only — matches what cowayaio's
// BeautifulSoup query (.find('form', id=...)) extracts.
function extractFormAction(html: string, formId: string): string | null {
  const pattern = new RegExp(
    `<form\\b[^>]*\\bid\\s*=\\s*"${escapeRegex(formId)}"[^>]*\\baction\\s*=\\s*"([^"]+)"|` +
    `<form\\b[^>]*\\baction\\s*=\\s*"([^"]+)"[^>]*\\bid\\s*=\\s*"${escapeRegex(formId)}"`,
    'i',
  );
  const m = html.match(pattern);
  if (!m) return null;
  // HTML entities like &amp; show up in action URLs from keycloak.
  const raw = m[1] ?? m[2];
  return decodeHtmlEntities(raw);
}

function extractTitle(html: string): string | null {
  const m = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return m ? m[1].trim() : null;
}

function extractAuthCodeFromPath(path: string): string | null {
  const queryIndex = path.indexOf('?');
  if (queryIndex < 0) return null;
  const query = path.slice(queryIndex + 1);
  const params = new URLSearchParams(query);
  return params.get('code');
}

// After axios follows redirects, the final request's path tells us where we ended
// up. Both `responseUrl` (set by follow-redirects on the underlying http request)
// and `request.path` are populated; we prefer the full URL when available.
function readFinalPath(resp: AxiosResponse): string | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const req: any = resp.request;
  if (req?.res?.responseUrl) return req.res.responseUrl as string;
  if (typeof req?.path === 'string') return req.path as string;
  return null;
}

function collectCookies(resp: AxiosResponse): string {
  const setCookie = resp.headers?.['set-cookie'];
  if (!setCookie) return '';
  const list = Array.isArray(setCookie) ? setCookie : [setCookie];
  // We only want the name=value portion of each Set-Cookie, joined by '; '.
  return list
    .map(line => String(line).split(';')[0].trim())
    .filter(s => s.length > 0)
    .join('; ');
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
