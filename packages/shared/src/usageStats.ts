/**
 * Local response-cache hits are audit events, never usage-stat events.
 *
 * Discriminator: request_logs.usageStatus === "cached" (and matching chat-log
 * status === "cached"). Provider prefix-cache fields (cachedTokens /
 * cacheReadTokens) belong to real billed requests and stay eligible.
 */
export const LOCAL_RESPONSE_CACHE_HIT_STATUS = "cached" as const;

export function isLocalResponseCacheHit(
  status: string | null | undefined,
): boolean {
  return status === LOCAL_RESPONSE_CACHE_HIT_STATUS;
}

/** True when a request/chat log row may change usage statistics. */
export function isUsageStatEligible(
  status: string | null | undefined,
): boolean {
  return !isLocalResponseCacheHit(status);
}

/**
 * Live logUpdate request-count delta. Token/cost deltas of 0 are not enough:
 * a cache hit must not bump request counts, rankings, or latency averages.
 */
export function liveUsageRequestDelta(params: {
  usageStatus?: string | null;
  isNewRequest: boolean;
}): number {
  if (!params.isNewRequest) return 0;
  return isUsageStatEligible(params.usageStatus) ? 1 : 0;
}
