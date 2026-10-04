import { AxiosRequestConfig, AxiosResponse } from 'axios';
import { Logger } from 'homebridge';

// Cap any single response we accept from Coway. The purifier status page is
// the largest legitimate response (~470 KB decompressed), so 8 MB leaves room
// for the page to keep growing while still preventing a misbehaving or
// hostile response from OOM-ing the Homebridge process via axios's response
// buffer.
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

// Retry parameters for transient failures: 5xx responses and network-level
// errors (timeout, connection reset, DNS — the same outage often surfaces
// both ways). Cap at 5 attempts per HANDOFF.md; beyond that, surface a
// warn-level log and let the next polling cycle naturally retry.
//
// 429 is deliberately NOT retried here. Re-hitting an endpoint that is
// actively rate-limiting us within seconds deepens the throttle (Coway's own
// guidance is to wait an hour), and the project rule is to never retry
// tighter than the polling interval. Callers map 429 to RateLimitedError and
// the next poll is the retry.
const RETRY_MAX_ATTEMPTS = 5;
const RETRY_INITIAL_DELAY_MS = 1000;
const RETRY_MAX_DELAY_MS = 16000;

/**
 * The axios request options shared by every Coway call: timeout, response
 * size caps, and validateStatus disabled so HTTP status mapping happens in
 * exactly one place per caller. With validateStatus always true, axios never
 * rejects on HTTP status — a rejected request is always a network-level
 * failure.
 */
export function baseRequestConfig(): AxiosRequestConfig {
  return {
    timeout: 15000,
    maxContentLength: MAX_RESPONSE_BYTES,
    maxBodyLength: MAX_RESPONSE_BYTES,
    validateStatus: () => true,
  };
}

/**
 * Run an axios call with exponential backoff on transient failures: 5xx
 * responses and network-level errors. Stops after RETRY_MAX_ATTEMPTS or as
 * soon as the response looks final (2xx, or any 4xx including 429 — see the
 * constants comment). The caller still gets the last response if every
 * attempt failed on status — they decide whether to propagate that as an
 * exception. If every attempt failed at the network level, the last error is
 * rethrown after the backoff is exhausted.
 */
export async function withRetry<T = unknown>(
  attempt: () => Promise<AxiosResponse<T>>,
  log: Logger,
  context: string,
): Promise<AxiosResponse<T>> {
  let delay = RETRY_INITIAL_DELAY_MS;
  let last: AxiosResponse<T> | undefined;
  let lastErr: unknown;
  for (let i = 1; i <= RETRY_MAX_ATTEMPTS; i++) {
    let failure: string;
    try {
      last = await attempt();
      lastErr = undefined;
      if (!isRetryableStatus(last.status)) {
        if (i > 1) {
          log.debug(`Coway ${context}: succeeded after ${i} attempt(s).`);
        }
        return last;
      }
      failure = `HTTP ${last.status}`;
    } catch (err) {
      last = undefined;
      lastErr = err;
      // Log only the message — bare axios errors carry config and request
      // properties whose stringified form can include the Authorization
      // header or a form body.
      failure = err instanceof Error ? err.message : String(err);
    }
    if (i === RETRY_MAX_ATTEMPTS) break;
    // Add jitter so multiple devices polling on the same interval don't all
    // re-hit Coway in lockstep when it returns a 5xx wave.
    const jitter = Math.random() * 500;
    log.debug(
      `Coway ${context}: ${failure}, retrying in ${Math.round((delay + jitter) / 100) / 10}s ` +
      `(attempt ${i + 1}/${RETRY_MAX_ATTEMPTS}).`,
    );
    await sleep(delay + jitter);
    delay = Math.min(delay * 2, RETRY_MAX_DELAY_MS);
  }
  if (last === undefined) {
    log.warn(`Coway ${context}: gave up after ${RETRY_MAX_ATTEMPTS} attempts (network errors).`);
    throw lastErr;
  }
  log.warn(`Coway ${context}: gave up after ${RETRY_MAX_ATTEMPTS} attempts (last status ${last.status}).`);
  return last;
}

function isRetryableStatus(status: number): boolean {
  // 5xx only. 429 fails fast — see the constants comment above.
  return status >= 500 && status <= 599;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
