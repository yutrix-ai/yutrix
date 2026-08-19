import { gte, lt, lte, sql, type SQL } from "drizzle-orm";
import {
  LOCAL_RESPONSE_CACHE_HIT_STATUS,
  isUsageStatEligible,
} from "@promptgate/shared";
import { requestLogs } from "../db/schema";

export { LOCAL_RESPONSE_CACHE_HIT_STATUS, isUsageStatEligible };

/**
 * SQL predicate for usage aggregations over request_logs.
 * NULL usageStatus (legacy rows) remains eligible; only local cache hits are excluded.
 */
export function usageStatEligibleSql(
  column: typeof requestLogs.usageStatus = requestLogs.usageStatus,
): SQL {
  return sql`(${column} IS NULL OR ${column} <> ${LOCAL_RESPONSE_CACHE_HIT_STATUS})`;
}

/** Radar / chat_logs join: exclude local cache-hit turns from usage scores. */
export function chatLogUsageStatEligibleSql(): SQL {
  return sql`(c.status IS NULL OR c.status <> ${LOCAL_RESPONSE_CACHE_HIT_STATUS}) AND (r.usageStatus IS NULL OR r.usageStatus <> ${LOCAL_RESPONSE_CACHE_HIT_STATUS})`;
}

export function withUsageStatEligibility(conditions: SQL[]): SQL[] {
  return [...conditions, usageStatEligibleSql()];
}

/**
 * Default time window for request_logs usage aggregations.
 * New stats queries should start here instead of inventing COUNT(*).
 */
export function requestLogUsageWindow(
  startDate: Date,
  endDate?: Date | null,
  options?: { endInclusive?: boolean },
): SQL[] {
  const conditions: SQL[] = [
    gte(requestLogs.createdAt, startDate),
    usageStatEligibleSql(),
  ];
  if (endDate) {
    conditions.push(
      options?.endInclusive
        ? lte(requestLogs.createdAt, endDate)
        : lt(requestLogs.createdAt, endDate),
    );
  }
  return conditions;
}
