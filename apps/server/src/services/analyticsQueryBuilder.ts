import { db } from "../db";
import { requestLogs, users, providers, endpoints, subdomains, apiKeys, providerModels, providerApiKeys } from "../db/schema";
import { eq, and, sql, gte, lt } from "drizzle-orm";
import { summedRequestCostSql } from "../utils/requestCostSql";
import { publicModelSql } from "../utils/modelAlias";
import { decryptText } from "../utils/crypto";
import { maskApiKey } from "./analyticsFormatter";

export async function getOverallStats(startDate: Date, endDate?: Date) {
  const conditions = [gte(requestLogs.createdAt, startDate)];
  if (endDate) {
    conditions.push(lt(requestLogs.createdAt, endDate));
  }

  const stats = await db
    .select({
      totalRequests: sql<number>`COUNT(*)`,
      totalTokens: sql<number>`COALESCE(SUM(${requestLogs.inputTokens} + ${requestLogs.outputTokens}), 0)`,
      totalInputTokens: sql<number>`COALESCE(SUM(${requestLogs.inputTokens}), 0)`,
      totalOutputTokens: sql<number>`COALESCE(SUM(${requestLogs.outputTokens}), 0)`,
      totalCost: summedRequestCostSql,
      avgLatencyMs: sql<number>`AVG(${requestLogs.latencyMs})`,
      successCount: sql<number>`SUM(CASE WHEN ${requestLogs.statusCode} >= 200 AND ${requestLogs.statusCode} < 300 THEN 1 ELSE 0 END)`,
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

  const total = stats[0]?.totalRequests || 0;
  const success = stats[0]?.successCount || 0;

  return {
    totalRequests: total,
    totalTokens: stats[0]?.totalTokens || 0,
    totalInputTokens: stats[0]?.totalInputTokens || 0,
    totalOutputTokens: stats[0]?.totalOutputTokens || 0,
    totalCost: stats[0]?.totalCost || 0,
    avgLatencyMs: Math.round(stats[0]?.avgLatencyMs || 0),
    successRate: total > 0 ? Math.round((success / total) * 10000) / 100 : 100,
  };
}

export async function getUsageByUser(startDate: Date, endDate?: Date) {
  const conditions = [gte(requestLogs.createdAt, startDate)];
  if (endDate) {
    conditions.push(lt(requestLogs.createdAt, endDate));
  }

  const stats = await db
    .select({
      userId: requestLogs.userId,
      username: users.username,
      totalRequests: sql<number>`COUNT(*)`,
      totalTokens: sql<number>`COALESCE(SUM(${requestLogs.inputTokens} + ${requestLogs.outputTokens}), 0)`,
      totalInputTokens: sql<number>`COALESCE(SUM(${requestLogs.inputTokens}), 0)`,
      totalOutputTokens: sql<number>`COALESCE(SUM(${requestLogs.outputTokens}), 0)`,
      totalCost: summedRequestCostSql,
      avgLatencyMs: sql<number>`AVG(${requestLogs.latencyMs})`,
      successRate: sql<number>`(SUM(CASE WHEN ${requestLogs.statusCode} >= 200 AND ${requestLogs.statusCode} < 300 THEN 1 ELSE 0 END) * 100.0 / COUNT(*))`,
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
    .where(and(...conditions))
    .groupBy(requestLogs.userId, users.username)
    .orderBy(sql`COUNT(*) DESC`);

  return stats;
}

export async function getUsageByProvider(startDate: Date, endDate?: Date) {
  const conditions = [gte(requestLogs.createdAt, startDate)];
  if (endDate) {
    conditions.push(lt(requestLogs.createdAt, endDate));
  }

  const stats = await db
    .select({
      providerId: requestLogs.providerId,
      providerName: providers.name,
      totalRequests: sql<number>`COUNT(*)`,
      totalTokens: sql<number>`COALESCE(SUM(${requestLogs.inputTokens} + ${requestLogs.outputTokens}), 0)`,
      totalInputTokens: sql<number>`COALESCE(SUM(${requestLogs.inputTokens}), 0)`,
      totalOutputTokens: sql<number>`COALESCE(SUM(${requestLogs.outputTokens}), 0)`,
      totalCost: summedRequestCostSql,
      avgLatencyMs: sql<number>`AVG(${requestLogs.latencyMs})`,
      successRate: sql<number>`(SUM(CASE WHEN ${requestLogs.statusCode} >= 200 AND ${requestLogs.statusCode} < 300 THEN 1 ELSE 0 END) * 100.0 / COUNT(*))`,
    })
    .from(requestLogs)
    .leftJoin(providers, eq(requestLogs.providerId, providers.id))
    .leftJoin(
      providerModels,
      and(
        eq(requestLogs.providerId, providerModels.providerId),
        eq(requestLogs.model, providerModels.modelId)
      )
    )
    .where(and(...conditions))
    .groupBy(requestLogs.providerId, providers.name)
    .orderBy(sql`COUNT(*) DESC`);

  // Get keys grouped by provider id AND name
  const keysByProvider = new Map<string, string[]>();
  try {
    const allKeys = await db.select().from(providerApiKeys);
    const allProviders = await db.select().from(providers);

    // Build a quick lookup for provider names
    const providerNameMap = new Map<string, string>();
    for (const p of allProviders) {
      providerNameMap.set(p.id, p.name);
    }

    for (const k of allKeys) {
      const decrypted = decryptText(k.keyEncrypted);
      const masked = maskApiKey(decrypted);
      const list = keysByProvider.get(k.providerId) || [];
      if (!list.includes(masked)) list.push(masked);
      keysByProvider.set(k.providerId, list);

      // Map by name as well for legacy logs
      const pName = providerNameMap.get(k.providerId);
      if (pName) {
        const nameList = keysByProvider.get(pName) || [];
        if (!nameList.includes(masked)) nameList.push(masked);
        keysByProvider.set(pName, nameList);
      }
    }

  } catch (err) {
    console.error("Failed to fetch provider keys for analytics:", err);
  }

  return stats.map((item: any) => ({
    ...item,
    apiKeys: keysByProvider.get(item.providerId || "") || [],
  }));
}

export async function getUsageByProviderKey(startDate: Date, endDate?: Date) {
  const conditions = [gte(requestLogs.createdAt, startDate)];
  if (endDate) {
    conditions.push(lt(requestLogs.createdAt, endDate));
  }

  const stats = await db
    .select({
      providerId: requestLogs.providerId,
      providerName: providers.name,
      providerApiKeyId: requestLogs.providerApiKeyId,
      apiKeyEncrypted: providerApiKeys.keyEncrypted,
      totalRequests: sql<number>`COUNT(*)`,
      totalTokens: sql<number>`COALESCE(SUM(${requestLogs.inputTokens} + ${requestLogs.outputTokens}), 0)`,
      totalInputTokens: sql<number>`COALESCE(SUM(${requestLogs.inputTokens}), 0)`,
      totalOutputTokens: sql<number>`COALESCE(SUM(${requestLogs.outputTokens}), 0)`,
      totalCost: summedRequestCostSql,
      avgLatencyMs: sql<number>`AVG(${requestLogs.latencyMs})`,
      successRate: sql<number>`(SUM(CASE WHEN ${requestLogs.statusCode} >= 200 AND ${requestLogs.statusCode} < 300 THEN 1 ELSE 0 END) * 100.0 / COUNT(*))`,
    })
    .from(requestLogs)
    .leftJoin(providers, eq(requestLogs.providerId, providers.id))
    .leftJoin(providerApiKeys, eq(requestLogs.providerApiKeyId, providerApiKeys.id))
    .leftJoin(
      providerModels,
      and(
        eq(requestLogs.providerId, providerModels.providerId),
        eq(requestLogs.model, providerModels.modelId)
      )
    )
    .where(and(...conditions))
    .groupBy(requestLogs.providerId, providers.name, requestLogs.providerApiKeyId, providerApiKeys.keyEncrypted)
    .orderBy(sql`COUNT(*) DESC`);

  return stats.map((item: any) => ({
    ...item,
    apiKey: item.apiKeyEncrypted ? maskApiKey(decryptText(item.apiKeyEncrypted)) : null,
    apiKeyEncrypted: undefined // Don't leak encrypted key
  }));
}

export async function getUsageByModel(startDate: Date, endDate?: Date) {
  const conditions = [gte(requestLogs.createdAt, startDate)];
  if (endDate) {
    conditions.push(lt(requestLogs.createdAt, endDate));
  }

  const stats = await db
    .select({
      model: publicModelSql(),
      totalRequests: sql<number>`COUNT(*)`,
      totalTokens: sql<number>`COALESCE(SUM(${requestLogs.inputTokens} + ${requestLogs.outputTokens}), 0)`,
      totalInputTokens: sql<number>`COALESCE(SUM(${requestLogs.inputTokens}), 0)`,
      totalOutputTokens: sql<number>`COALESCE(SUM(${requestLogs.outputTokens}), 0)`,
      totalCost: summedRequestCostSql,
      avgLatencyMs: sql<number>`AVG(${requestLogs.latencyMs})`,
      successRate: sql<number>`(SUM(CASE WHEN ${requestLogs.statusCode} >= 200 AND ${requestLogs.statusCode} < 300 THEN 1 ELSE 0 END) * 100.0 / COUNT(*))`,
    })
    .from(requestLogs)
    .leftJoin(
      providerModels,
      and(
        eq(requestLogs.providerId, providerModels.providerId),
        eq(requestLogs.model, providerModels.modelId)
      )
    )
    .where(and(...conditions))
    .groupBy(publicModelSql())
    .orderBy(sql`COUNT(*) DESC`);

  return stats;
}

export async function getUsageByEndpoint(startDate: Date, endDate?: Date) {
  const conditions = [gte(requestLogs.createdAt, startDate)];
  if (endDate) {
    conditions.push(lt(requestLogs.createdAt, endDate));
  }

  const stats = await db
    .select({
      endpointId: requestLogs.endpointId,
      endpointName: endpoints.name,
      endpointPath: endpoints.path,
      totalRequests: sql<number>`COUNT(*)`,
      totalTokens: sql<number>`COALESCE(SUM(${requestLogs.inputTokens} + ${requestLogs.outputTokens}), 0)`,
      totalInputTokens: sql<number>`COALESCE(SUM(${requestLogs.inputTokens}), 0)`,
      totalOutputTokens: sql<number>`COALESCE(SUM(${requestLogs.outputTokens}), 0)`,
      totalCost: summedRequestCostSql,
      avgLatencyMs: sql<number>`AVG(${requestLogs.latencyMs})`,
      successRate: sql<number>`(SUM(CASE WHEN ${requestLogs.statusCode} >= 200 AND ${requestLogs.statusCode} < 300 THEN 1 ELSE 0 END) * 100.0 / COUNT(*))`,
    })
    .from(requestLogs)
    .leftJoin(endpoints, eq(requestLogs.endpointId, endpoints.id))
    .leftJoin(
      providerModels,
      and(
        eq(requestLogs.providerId, providerModels.providerId),
        eq(requestLogs.model, providerModels.modelId)
      )
    )
    .where(and(...conditions))
    .groupBy(requestLogs.endpointId, endpoints.name, endpoints.path)
    .orderBy(sql`COUNT(*) DESC`);

  return stats;
}

export async function getUsageBySubdomain(startDate: Date, endDate?: Date) {
  const conditions = [gte(requestLogs.createdAt, startDate)];
  if (endDate) {
    conditions.push(lt(requestLogs.createdAt, endDate));
  }

  const stats = await db
    .select({
      subdomainId: requestLogs.subdomainId,
      subdomainName: subdomains.name,
      subdomainHostname: subdomains.hostname,
      totalRequests: sql<number>`COUNT(*)`,
      totalTokens: sql<number>`COALESCE(SUM(${requestLogs.inputTokens} + ${requestLogs.outputTokens}), 0)`,
      totalInputTokens: sql<number>`COALESCE(SUM(${requestLogs.inputTokens}), 0)`,
      totalOutputTokens: sql<number>`COALESCE(SUM(${requestLogs.outputTokens}), 0)`,
      totalCost: summedRequestCostSql,
      avgLatencyMs: sql<number>`AVG(${requestLogs.latencyMs})`,
      successRate: sql<number>`(SUM(CASE WHEN ${requestLogs.statusCode} >= 200 AND ${requestLogs.statusCode} < 300 THEN 1 ELSE 0 END) * 100.0 / COUNT(*))`,
    })
    .from(requestLogs)
    .leftJoin(subdomains, eq(requestLogs.subdomainId, subdomains.id))
    .leftJoin(
      providerModels,
      and(
        eq(requestLogs.providerId, providerModels.providerId),
        eq(requestLogs.model, providerModels.modelId)
      )
    )
    .where(and(...conditions))
    .groupBy(requestLogs.subdomainId, subdomains.name, subdomains.hostname)
    .orderBy(sql`COUNT(*) DESC`);

  return stats;
}

export async function getUsageByApiKey(startDate: Date, endDate?: Date) {
  const conditions = [gte(requestLogs.createdAt, startDate)];
  if (endDate) {
    conditions.push(lt(requestLogs.createdAt, endDate));
  }

  const stats = await db
    .select({
      apiKeyId: requestLogs.apiKeyId,
      apiKeyName: apiKeys.keyPrefix,
      totalRequests: sql<number>`COUNT(*)`,
      totalTokens: sql<number>`COALESCE(SUM(${requestLogs.inputTokens} + ${requestLogs.outputTokens}), 0)`,
      totalInputTokens: sql<number>`COALESCE(SUM(${requestLogs.inputTokens}), 0)`,
      totalOutputTokens: sql<number>`COALESCE(SUM(${requestLogs.outputTokens}), 0)`,
      totalCost: summedRequestCostSql,
      avgLatencyMs: sql<number>`AVG(${requestLogs.latencyMs})`,
      successRate: sql<number>`(SUM(CASE WHEN ${requestLogs.statusCode} >= 200 AND ${requestLogs.statusCode} < 300 THEN 1 ELSE 0 END) * 100.0 / COUNT(*))`,
    })
    .from(requestLogs)
    .leftJoin(apiKeys, eq(requestLogs.apiKeyId, apiKeys.id))
    .leftJoin(
      providerModels,
      and(
        eq(requestLogs.providerId, providerModels.providerId),
        eq(requestLogs.model, providerModels.modelId)
      )
    )
    .where(and(...conditions))
    .groupBy(requestLogs.apiKeyId, apiKeys.keyPrefix)
    .orderBy(sql`COUNT(*) DESC`);

  return stats;
}

export async function getTimeSeries(startDate: Date, endDate?: Date) {
  const conditions = [gte(requestLogs.createdAt, startDate)];
  if (endDate) {
    conditions.push(lt(requestLogs.createdAt, endDate));
  }

  const stats = await db
    .select({
      date: sql<string>`date(${requestLogs.createdAt})`,
      requests: sql<number>`COUNT(*)`,
      tokens: sql<number>`COALESCE(SUM(${requestLogs.inputTokens} + ${requestLogs.outputTokens}), 0)`,
      inputTokens: sql<number>`COALESCE(SUM(${requestLogs.inputTokens}), 0)`,
      outputTokens: sql<number>`COALESCE(SUM(${requestLogs.outputTokens}), 0)`,
      cost: summedRequestCostSql,
      successCount: sql<number>`SUM(CASE WHEN ${requestLogs.statusCode} >= 200 AND ${requestLogs.statusCode} < 300 THEN 1 ELSE 0 END)`,
      avgLatencyMs: sql<number>`AVG(${requestLogs.latencyMs})`,
    })
    .from(requestLogs)
    .leftJoin(
      providerModels,
      and(
        eq(requestLogs.providerId, providerModels.providerId),
        eq(requestLogs.model, providerModels.modelId)
      )
    )
    .where(and(...conditions))
    .groupBy(sql`date(${requestLogs.createdAt})`)
    .orderBy(sql`date(${requestLogs.createdAt})`);

  return stats.map((s: any) => ({
    ...s,
    successRate: s.requests > 0 ? Math.round((s.successCount / s.requests) * 10000) / 100 : 100,
  }));
}

export async function getRadarMetrics(type: string, value: string, startDate: Date, endDate?: Date) {
  // Convert Date objects to unix seconds for raw SQL comparisons against integer createdAt
  const startSec = Math.floor(startDate.getTime() / 1000);
  const endSec = endDate ? Math.floor(endDate.getTime() / 1000) : undefined;

  let conditionsSql = sql`c.createdAt >= ${startSec}`;
  const radarPublicModelSql = sql`COALESCE(NULLIF((
    SELECT pm.alias
    FROM provider_models pm
    WHERE pm.providerId = r.providerId AND pm.modelId = r.model
    LIMIT 1
  ), ''), c.model)`;
  if (endSec) {
    conditionsSql = sql`${conditionsSql} AND c.createdAt < ${endSec}`;
  }

  if (type === "user") {
    conditionsSql = sql`${conditionsSql} AND c.userId = ${value}`;
  } else if (type === "provider") {
    if (!value || value === "null") {
      conditionsSql = sql`${conditionsSql} AND r.providerId IS NULL`;
    } else {
      conditionsSql = sql`${conditionsSql} AND r.providerId = ${value}`;
    }
  } else if (type === "model") {
    if (!value || value === "null") {
      conditionsSql = sql`${conditionsSql} AND ${radarPublicModelSql} IS NULL`;
    } else {
      conditionsSql = sql`${conditionsSql} AND ${radarPublicModelSql} = ${value}`;
    }
  } else if (type === "endpoint") {
    if (!value || value === "null") {
      conditionsSql = sql`${conditionsSql} AND r.endpointId IS NULL`;
    } else {
      conditionsSql = sql`${conditionsSql} AND r.endpointId = ${value}`;
    }
  } else if (type === "subdomain") {
    if (!value || value === "null") {
      conditionsSql = sql`${conditionsSql} AND r.subdomainId IS NULL`;
    } else {
      conditionsSql = sql`${conditionsSql} AND r.subdomainId = ${value}`;
    }
  } else if (type === "apiKey") {
    if (!value || value === "null") {
      conditionsSql = sql`${conditionsSql} AND r.apiKeyId IS NULL`;
    } else {
      conditionsSql = sql`${conditionsSql} AND r.apiKeyId = ${value}`;
    }
  }

  // 1. Context Spike — plain subquery (no CTE; SQLite forbids WITH inside FROM(...))
  const contextSpikeP = db.select({
    score: sql<number>`COALESCE(MAX(0, 100 - (SUM(CASE WHEN inputTokens > prevTokens * 5 AND outputTokens < 200 THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0))), 100)`
  }).from(sql`(
    SELECT c.inputTokens, c.outputTokens, LAG(c.inputTokens) OVER (PARTITION BY c.serverSessionId ORDER BY c.createdAt) as prevTokens
    FROM chat_logs c
    LEFT JOIN request_logs r ON c.requestId = r.id
    WHERE ${conditionsSql}
  ) AS t`);

  // 2. Stream Abort
  const streamAbortP = db.select({
    score: sql<number>`COALESCE(MAX(0, 100 - (SUM(CASE WHEN c.is_aborted = 1 THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0))), 100)`
  }).from(sql`chat_logs c LEFT JOIN request_logs r ON c.requestId = r.id`).where(conditionsSql);

  // 3. Cache Efficiency
  const cacheEfficiencyP = db.select({
    score: sql<number>`COALESCE(MIN(100, SUM(c.cached_tokens) * 100.0 / NULLIF(SUM(c.inputTokens), 0)), 0)`
  }).from(sql`chat_logs c LEFT JOIN request_logs r ON c.requestId = r.id`).where(conditionsSql);

  // 4. Thrashing — plain subquery (no CTE), divisor = 300 (seconds, not 300000)
  const thrashingP = db.select({
    score: sql<number>`COALESCE(MAX(0, 100 - (SUM(CASE WHEN req_count > 4 AND avg_output < 100 THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0))), 100)`
  }).from(sql`(
    SELECT
      c.serverSessionId,
      CAST(c.createdAt / 300 AS INTEGER) as time_window,
      COUNT(*) as req_count,
      AVG(c.outputTokens) as avg_output
    FROM chat_logs c
    LEFT JOIN request_logs r ON c.requestId = r.id
    WHERE ${conditionsSql}
    GROUP BY c.serverSessionId, CAST(c.createdAt / 300 AS INTEGER)
  ) AS t`);

  // 5. TTFT Penalty
  const ttftP = db.select({
    teamAvg: sql<number>`(SELECT AVG(ttft_ms) FROM chat_logs WHERE ttft_ms > 0)`,
    userAvg: sql<number>`AVG(c.ttft_ms)`
  }).from(sql`chat_logs c LEFT JOIN request_logs r ON c.requestId = r.id`).where(sql`${conditionsSql} AND c.ttft_ms > 0`);

  const [spikeRes, abortRes, cacheRes, thrashRes, ttftRes] = await Promise.all([
    contextSpikeP, streamAbortP, cacheEfficiencyP, thrashingP, ttftP
  ]);

  const ttft = ttftRes[0] || { teamAvg: 0, userAvg: 0 };
  let ttftPenaltyScore = 100;
  if (ttft.teamAvg > 0 && ttft.userAvg > ttft.teamAvg) {
    ttftPenaltyScore = Math.max(0, 100 - ((ttft.userAvg - ttft.teamAvg) / ttft.teamAvg) * 50);
  }

  return {
    contextSpike: Math.round(spikeRes[0]?.score ?? 100),
    streamAbort: Math.round(abortRes[0]?.score ?? 100),
    cacheEfficiency: Math.round(cacheRes[0]?.score ?? 0),
    thrashing: Math.round(thrashRes[0]?.score ?? 100),
    ttftPenalty: Math.round(ttftPenaltyScore),
  };
}
