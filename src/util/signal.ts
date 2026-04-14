/**
 * Shared AbortSignal utility — combines an optional caller signal with a timeout.
 * Replaces the ad-hoc AbortSignal.any([...]) patterns scattered across fetchers.
 */

const DEFAULT_TIMEOUT_MS = 30_000;

export function combinedSignal(signal?: AbortSignal, timeoutMs?: number): AbortSignal {
  const signals: AbortSignal[] = [];
  if (timeoutMs) signals.push(AbortSignal.timeout(timeoutMs));
  if (signal) signals.push(signal);
  return signals.length > 0 ? AbortSignal.any(signals) : AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
}
