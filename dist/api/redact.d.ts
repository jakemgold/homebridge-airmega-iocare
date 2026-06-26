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
/**
 * Stringify a response body with sensitive keys redacted and the total length
 * capped. Safe to embed in thrown Error messages. `maxLength` defaults to the
 * conservative cap used for warn/error messages; diagnostic debug logs can pass
 * a larger value when they need to show a fuller (still redacted) shape.
 */
export declare function redactBody(body: unknown, maxLength?: number): string;
/**
 * Mask the local part of an email-shaped string while preserving the first
 * character and the domain. Used for debug logs that include the IoCare+
 * username so a shared log doesn't fully expose the account email.
 */
export declare function maskEmail(value: string): string;
