export declare const Endpoint: {
    readonly BASE_URI: "https://iocare.iotsvc.coway.com/api/v1";
    readonly GET_TOKEN: "/com/token";
    readonly TOKEN_REFRESH: "/com/refresh-token";
    readonly USER_INFO: "/com/my-info";
    readonly PLACES: "/com/places";
    readonly AIR: "/air/devices";
    readonly NOTICES: "/com/notices";
    readonly OAUTH_URL: "https://id.coway.com/auth/realms/cw-account/protocol/openid-connect/auth";
    readonly REDIRECT_URL: "https://iocare-redirect.iotsvc.coway.com/redirect_bridge_empty.html";
    readonly PURIFIER_HTML_BASE: "https://iocare2.coway.com/en";
    readonly SECONDARY_BASE: "https://iocare2.coway.com/api/proxy/api/v1";
};
export declare const Parameter: {
    readonly CLIENT_ID: "cwid-prd-iocare-plus-25MJGcYX";
    readonly CLIENT_NAME: "IOCARE";
    readonly APP_VERSION: "2.15.0";
    readonly TIMEZONE: "America/Kentucky/Louisville";
};
export declare const Header: {
    readonly ACCEPT: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
    readonly ACCEPT_LANG: "en";
    readonly COWAY_LANGUAGE: "en-US,en;q=0.9";
    readonly CONTENT_JSON: "application/json";
    readonly THEME: "light";
    readonly CALLING_PAGE: "product";
    readonly SOURCE_PATH: "iOS";
    readonly USER_AGENT: "CowayAIO/0.2.4";
    readonly COWAY_USER_AGENT: "CowayAIO/0.2.4";
    readonly HTML_USER_AGENT: "CowayAIO/0.2.4";
};
export declare const CATEGORY_NAME = "\uCCAD\uC815\uAE30";
export declare const ErrorMessage: {
    readonly BAD_TOKEN: "Unauthenticated (crypto/rsa: verification error)";
    readonly EXPIRED_TOKEN: "Unauthenticated (Token is expired)";
    readonly INVALID_REFRESH_TOKEN: "통합회원 토큰 갱신 오류 (error: invalid_grant)(error_desc: Invalid refresh token)";
    readonly INVALID_GRANT: "통합회원 토큰 발급 오류 (error: invalid_grant)(error_desc: Code not valid)";
};
