import { AxiosRequestConfig, AxiosResponse } from 'axios';
import { Logger } from 'homebridge';
export declare const MAX_RESPONSE_BYTES: number;
/**
 * The axios request options shared by every Coway call: timeout, response
 * size caps, and validateStatus disabled so HTTP status mapping happens in
 * exactly one place per caller. With validateStatus always true, axios never
 * rejects on HTTP status — a rejected request is always a network-level
 * failure.
 */
export declare function baseRequestConfig(): AxiosRequestConfig;
/**
 * Run an axios call with exponential backoff on transient failures: 5xx
 * responses and network-level errors. Stops after RETRY_MAX_ATTEMPTS or as
 * soon as the response looks final (2xx, or any 4xx including 429 — see the
 * constants comment). The caller still gets the last response if every
 * attempt failed on status — they decide whether to propagate that as an
 * exception. If every attempt failed at the network level, the last error is
 * rethrown after the backoff is exhausted.
 */
export declare function withRetry<T = unknown>(attempt: () => Promise<AxiosResponse<T>>, log: Logger, context: string): Promise<AxiosResponse<T>>;
