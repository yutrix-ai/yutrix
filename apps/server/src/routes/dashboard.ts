import { FastifyInstance } from "fastify";
import { db } from "../db";
import {
  requestLogs,
  apiKeys,
  providers,
  subdomains,
  endpoints,
  users,
  providerModels,
} from "../db/schema";
import { eq, and, sql, gte } from "drizzle-orm";
import { requireAdmin } from "../middleware/auth";
import { getQueryDateRange } from "../utils/timeRange";
import { requestCostSql, summedRequestCostSql } from "../utils/requestCostSql";
import {
  isUsageStatEligible,
  requestLogUsageWindow,
  usageStatEligibleSql,
} from "../utils/usageStatEligibility";

const ONE_HOUR_MS = 60 * 60 * 1000;

function toDate(value: Date | string | number | null | undefined): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function startOfHour(date: Date): Date {
  const next = new Date(date);
  next.setMinutes(0, 0, 0);
  return next;
}

function formatHourLabel(date: Date): string {
  return `${date.getHours().toString().padStart(2, "0")}:00`;
}

export default async function (fastify: FastifyInstance) {
  // Get dashboard statistics (admin only)
  fastify.get(
    "/api/admin/dashboard/stats",
    { onRequest: [requireAdmin] },
    async (request, reply) => {
      const { startDate, endDate } = await getQueryDateRange(request.query, "day");
      const conditions = requestLogUsageWindow(startDate, endDate);

      // Period requests
      const periodRequests = await db
        .select({ count: sql<number>`COUNT(*)` })
        .from(requestLogs)
        .where(and(...conditions));

      // Period tokens and cost
      const periodTokens = await db
        .select({
          total: sql<number>`COALESCE(SUM(${requestLogs.inputTokens} + ${requestLogs.outputTokens}), 0)`,
          input: sql<number>`COALESCE(SUM(${requestLogs.inputTokens}), 0)`,
          output: sql<number>`COALESCE(SUM(${requestLogs.outputTokens}), 0)`,
          cost: summedRequestCostSql,
        })
        .from(requestLogs)
        .leftJoin(
          providerModels,
          and(
            eq(requestLogs.providerId, providerModels.providerId),
            eq(requestLogs.model, providerModels.modelId)
          )
        )
        .where(and(...conditions));

      // Success rate
      const successStats = await db
        .select({
          total: sql<number>`COUNT(*)`,
          completed: sql<number>`SUM(CASE WHEN ${requestLogs.statusCode} IS NOT NULL THEN 1 ELSE 0 END)`,
          success: sql<number>`SUM(CASE WHEN ${requestLogs.statusCode} >= 200 AND ${requestLogs.statusCode} < 300 THEN 1 ELSE 0 END)`,
        })
        .from(requestLogs)
        .where(and(...conditions));

      const successRate =
        successStats[0]?.completed > 0
          ? (successStats[0].success / successStats[0].completed) * 100
          : 100;

      // Average latency
      const latencyStats = await db
        .select({ avg: sql<number>`AVG(${requestLogs.latencyMs})` })
        .from(requestLogs)
        .where(
          and(
            ...conditions,
            sql`${requestLogs.statusCode} IS NOT NULL`,
          ),
        );

      // Active API keys
      const activeApiKeys = await db
        .select({ count: sql<number>`COUNT(*)` })
        .from(apiKeys)
        .where(eq(apiKeys.status, "active"));

      // Enabled providers
      const enabledProviders = await db
        .select({ count: sql<number>`COUNT(*)` })
        .from(providers)
        .where(eq(providers.enabled, true));

      // Total subdomains
      const totalSubdomains = await db
        .select({ count: sql<number>`COUNT(*)` })
        .from(subdomains);

      // Total endpoints
      const totalEndpoints = await db
        .select({ count: sql<number>`COUNT(*)` })
        .from(endpoints);

      const now = new Date();
      const oneMinuteAgo = new Date(now.getTime() - 60000);

      const realTimeTokens = await db
        .select({
          total: sql<number>`COALESCE(SUM(${requestLogs.inputTokens} + ${requestLogs.outputTokens}), 0)`,
        })
        .from(requestLogs)
        .where(and(gte(requestLogs.createdAt, oneMinuteAgo), usageStatEligibleSql()));

      const tpm = Math.round(realTimeTokens[0]?.total || 0);

      return {
        todayRequests: periodRequests[0]?.count || 0,
        todayTokens: periodTokens[0]?.total || 0,
        todayInputTokens: periodTokens[0]?.input || 0,
        todayOutputTokens: periodTokens[0]?.output || 0,
        todayCost: periodTokens[0]?.cost || 0,
        successRate: Math.round(successRate * 100) / 100,
        avgLatencyMs: Math.round(latencyStats[0]?.avg || 0),
        activeApiKeys: activeApiKeys[0]?.count || 0,
        enabledProviders: enabledProviders[0]?.count || 0,
        totalSubdomains: totalSubdomains[0]?.count || 0,
        totalEndpoints: totalEndpoints[0]?.count || 0,
        tpm,
      };
    }
  );

  // Token usage charts for dashboard (admin only)
  fastify.get(
    "/api/admin/dashboard/token-usage",
    { onRequest: [requireAdmin] },
    async (request, reply) => {
      const { startDate, endDate } = await getQueryDateRange(request.query, "day");
      const endHour = startOfHour(endDate || new Date());
      const startHour = startDate;

      const hoursDiff = Math.ceil((endHour.getTime() - startHour.getTime()) / ONE_HOUR_MS) + 1;
      const bucketCount = hoursDiff > 0 && hoursDiff < 1000 ? hoursDiff : 24; // Limit buckets to avoid huge array if "all" or "year"

      const buckets = Array.from({ length: Math.min(bucketCount, 720) }, (_, index) => {
        const hour = new Date(startHour.getTime() + index * ONE_HOUR_MS);
        return {
          hour: hour.toISOString(),
          label: formatHourLabel(hour),
          tokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          requests: 0,
          cost: 0,
        };
      });

      const conditions = requestLogUsageWindow(startHour, endDate);

      const usageRows = await db
        .select({
          userId: requestLogs.userId,
          username: users.username,
          usageStatus: requestLogs.usageStatus,
          totalTokens: sql<number>`COALESCE(${requestLogs.inputTokens}, 0) + COALESCE(${requestLogs.outputTokens}, 0)`,
          inputTokens: requestLogs.inputTokens,
          outputTokens: requestLogs.outputTokens,
          cost: requestCostSql,
          createdAt: requestLogs.createdAt,
        })
        .from(requestLogs)
        .leftJoin(users, eq(requestLogs.userId, users.id))
        .leftJoin(
          providerModels,
          and(
            eq(requestLogs.providerId, providerModels.providerId),
            eq(requestLogs.model, providerModels.modelId)
          )
        )
        .where(and(...conditions));

      const userUsage = new Map<
        string,
        {
          userId: string;
          username: string;
          totalTokens: number;
          inputTokens: number;
          outputTokens: number;
          totalRequests: number;
          totalCost: number;
        }
      >();

      for (const row of usageRows) {
        if (!isUsageStatEligible(row.usageStatus)) continue;
        const createdAt = toDate(row.createdAt);
        if (!createdAt) continue;

        const bucketIndex = Math.floor((startOfHour(createdAt).getTime() - startHour.getTime()) / ONE_HOUR_MS);
        const tokens = Number(row.totalTokens || 0);
        const inputTokens = Number(row.inputTokens || 0);
        const outputTokens = Number(row.outputTokens || 0);
        const cost = Number(row.cost || 0);
        if (bucketIndex >= 0 && bucketIndex < buckets.length) {
          buckets[bucketIndex].tokens += tokens;
          buckets[bucketIndex].inputTokens += inputTokens;
          buckets[bucketIndex].outputTokens += outputTokens;
          buckets[bucketIndex].requests += 1;
          buckets[bucketIndex].cost += cost;
        }

        const userKey = row.userId || "unknown";
        const current = userUsage.get(userKey) || {
          userId: userKey,
          username: row.username || "未知用户",
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalRequests: 0,
          totalCost: 0,
        };
        current.totalTokens += tokens;
        current.inputTokens += inputTokens;
        current.outputTokens += outputTokens;
        current.totalRequests += 1;
        current.totalCost += cost;
        userUsage.set(userKey, current);
      }

      const userRanking = Array.from(userUsage.values())
        .filter((item) => item.totalTokens > 0)
        .sort((a, b) => {
          if (b.totalTokens !== a.totalTokens) return b.totalTokens - a.totalTokens;
          return b.totalRequests - a.totalRequests;
        });

      return {
        tokenSeries: buckets,
        userRanking,
      };
    },
  );

  // Get recent request logs (admin only)
  fastify.get(
    "/api/admin/dashboard/recent-logs",
    { onRequest: [requireAdmin] },
    async (request, reply) => {
      const { limit = "10" } = request.query as any;

      const logs = await db
        .select()
        .from(requestLogs)
        .orderBy(sql`${requestLogs.createdAt} DESC`)
        .limit(parseInt(limit));

      return logs;
    }
  );

  // Get request logs over time (for charts)
  fastify.get(
    "/api/admin/dashboard/logs-over-time",
    { onRequest: [requireAdmin] },
    async (request, reply) => {
      const { startDate, endDate } = await getQueryDateRange(request.query, "week");
      const conditions = requestLogUsageWindow(startDate, endDate);

      const logs = await db
        .select({
          date: sql<string>`date(${requestLogs.createdAt})`,
          count: sql<number>`COUNT(*)`,
        })
        .from(requestLogs)
        .where(and(...conditions))
        .groupBy(sql`date(${requestLogs.createdAt})`)
        .orderBy(sql`date(${requestLogs.createdAt})`);

      return logs;
    }
  );
}
