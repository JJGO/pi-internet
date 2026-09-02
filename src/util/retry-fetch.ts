import { fetchWithProxy } from "./proxy.js";

const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const DEFAULT_RETRY_DELAY_MS = 250;

export interface RetryFetchOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  socksProxy?: string | null;
  retries?: number;
}

export async function fetchWithTransientRetry(
  url: string,
  init: RequestInit,
  options: RetryFetchOptions,
): Promise<Response> {
  const deadline = Date.now() + options.timeoutMs;
  const retries = options.retries ?? 0;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    options.signal?.throwIfAborted();
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw timeoutError(options.timeoutMs);

    const signal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(remainingMs)])
      : AbortSignal.timeout(remainingMs);

    try {
      const response = await fetchWithProxy(url, { ...init, signal }, {
        socksProxy: options.socksProxy,
      });
      if (attempt === retries || !RETRYABLE_STATUSES.has(response.status)) return response;

      const delayMs = retryDelayMs(response.headers.get("retry-after"));
      if (delayMs >= deadline - Date.now()) return response;
      await response.body?.cancel();
      await abortableDelay(delayMs, options.signal);
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason ?? error;
      lastError = error;
      if (attempt === retries) throw error;

      const delayMs = DEFAULT_RETRY_DELAY_MS;
      if (delayMs >= deadline - Date.now()) throw timeoutError(options.timeoutMs);
      await abortableDelay(delayMs, options.signal);
    }
  }

  throw lastError ?? new Error(`Request failed: ${url}`);
}

function retryDelayMs(value: string | null): number {
  if (!value) return DEFAULT_RETRY_DELAY_MS;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : DEFAULT_RETRY_DELAY_MS;
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(signal?.reason);
    };
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function timeoutError(timeoutMs: number): Error {
  return new Error(`Request timed out (${timeoutMs}ms)`);
}
