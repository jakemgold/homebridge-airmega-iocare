/**
 * Redaction helpers for log/exception messages. We log error messages at warn
 * and error levels, which means anything embedded in those messages travels
 * with bug reports the user shares publicly. Coway response bodies routinely
 * include access tokens, refresh tokens, email addresses, phone numbers,
 * device serials, and place names — none of which belongs in shared logs.
 *
 * The approach is conservative: redact a fixed set of known-sensitive keys
 * to `[redacted]` while preserving the rest of the shape so the message
 * remains useful for debugging. We also cap the serialized output so a
 * surprise large body can't fill the log buffer.
 */

const SENSITIVE_KEYS = new Set<string>([
  // Auth material
  'accessToken', 'refreshToken', 'access_token', 'refresh_token',
  'password', 'new_password', 'current_password', 'new_password_confirm',
  'authorization', 'cookie',
  'authCode', 'auth_code', 'code', 'session_code',
  // Personally identifying
  'email', 'mobileNo', 'phoneNumber', 'phone', 'mobile',
  'firstName', 'lastName', 'fullName', 'memberName', 'userName',
  // Account / device identifiers
  'memberId', 'userId', 'user_id', 'memberNo',
  'deviceSerial', 'serial', 'serialNumber',
  // Location identifiers
  'placeName', 'address',
]);

const MAX_REDACTED_BODY_LENGTH = 500;

function redactValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(redactValue);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEYS.has(k) ? '[redacted]' : redactValue(v);
    }
    return out;
  }
  return value;
}

/**
 * Stringify a response body with sensitive keys redacted and the total length
 * capped. Safe to embed in thrown Error messages. `maxLength` defaults to the
 * conservative cap used for warn/error messages; diagnostic debug logs can pass
 * a larger value when they need to show a fuller (still redacted) shape.
 */
export function redactBody(body: unknown, maxLength: number = MAX_REDACTED_BODY_LENGTH): string {
  let json: string;
  try {
    json = JSON.stringify(redactValue(body));
  } catch {
    return '[unserializable body]';
  }
  if (json === undefined) return 'undefined';
  if (json.length > maxLength) {
    return json.slice(0, maxLength) + '...[truncated]';
  }
  return json;
}

/**
 * Mask the local part of an email-shaped string while preserving the first
 * character and the domain. Used for debug logs that include the IoCare+
 * username so a shared log doesn't fully expose the account email.
 */
export function maskEmail(value: string): string {
  const at = value.indexOf('@');
  if (at <= 0) return '***';
  return value[0] + '***' + value.slice(at);
}
