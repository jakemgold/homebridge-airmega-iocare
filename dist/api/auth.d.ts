import { Logger } from 'homebridge';
export interface AuthTokens {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
}
export interface LoginParams {
    username: string;
    password: string;
    skipPasswordChange: boolean;
    log: Logger;
}
export declare class AuthError extends Error {
}
export declare class PasswordExpiredError extends Error {
}
export declare class RateLimitedError extends Error {
}
export declare const RATE_LIMIT_BACKOFF_MS: number;
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
export declare function performLogin(params: LoginParams): Promise<AuthTokens>;
export declare function refreshAccessToken(refreshToken: string, log: Logger): Promise<AuthTokens>;
