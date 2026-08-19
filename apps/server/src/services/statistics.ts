import { db } from "../db";
import { requestLogs, users, providerModels } from "../db/schema";
import { eq, sql, and } from "drizzle-orm";
import { getRadarMetrics } from "./analyticsQueryBuilder";
import { publicModelSql } from "../utils/modelAlias";
import {
  isUsageStatEligible,
  requestLogUsageWindow,
} from "../utils/usageStatEligibility";

export async function getStatisticsData(startTime: Date, endTime: Date, excludedUsers: string[] = []) {
  const usageRows = await db
    .select({
      userId: requestLogs.userId,
      username: users.username,
      model: publicModelSql(),
      providerId: requestLogs.providerId,
      usageStatus: requestLogs.usageStatus,
      totalTokens: sql<number>`COALESCE(${requestLogs.inputTokens}, 0) + COALESCE(${requestLogs.outputTokens}, 0)`,
      inputTokens: requestLogs.inputTokens,
      outputTokens: requestLogs.outputTokens,
      storedCost: requestLogs.cost,
      inputPricePerM: providerModels.inputTokenPricePerM,
      outputPricePerM: providerModels.outputTokenPricePerM,
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
    .where(and(...requestLogUsageWindow(startTime, endTime, { endInclusive: true })));

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

  const allUsers = await db.select().from(users).where(eq(users.status, "active"));
  for (const u of allUsers) {
    if (excludedUsers.includes(u.id)) continue;
    userUsage.set(u.id, {
      userId: u.id,
      username: u.username,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalRequests: 0,
      totalCost: 0,
    });
  }

  const modelUsage = new Map<
    string,
    {
      modelId: string;
      totalTokens: number;
      inputTokens: number;
      outputTokens: number;
      totalRequests: number;
      totalCost: number;
    }
  >();

  let totalCostVal = 0;
  let totalRequestsVal = 0;
  let totalTokensVal = 0;
  let totalInputTokensVal = 0;
  let totalOutputTokensVal = 0;

  for (const row of usageRows) {
    if (!isUsageStatEligible(row.usageStatus)) continue;

    const userKey = row.userId || "unknown";
    if (excludedUsers.includes(userKey)) continue;

    const t = Number(row.totalTokens || 0);
    const inputT = Number(row.inputTokens || 0);
    const outputT = Number(row.outputTokens || 0);

    const inputPrice = row.inputPricePerM !== null ? Number(row.inputPricePerM) : 0;
    const outputPrice = row.outputPricePerM !== null ? Number(row.outputPricePerM) : 0;
    const fallbackCost = (inputT * inputPrice / 1000000.0) + (outputT * outputPrice / 1000000.0);
    const cost = row.storedCost !== null && row.storedCost !== undefined
      ? Number(row.storedCost)
      : fallbackCost;

    totalCostVal += cost;
    totalRequestsVal += 1;
    totalTokensVal += t;
    totalInputTokensVal += inputT;
    totalOutputTokensVal += outputT;

    const currentU = userUsage.get(userKey) || {
      userId: userKey,
      username: row.username || "Unknown User",
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalRequests: 0,
      totalCost: 0,
    };
    currentU.totalTokens += t;
    currentU.inputTokens += inputT;
    currentU.outputTokens += outputT;
    currentU.totalRequests += 1;
    currentU.totalCost += cost;
    userUsage.set(userKey, currentU);

    const modelKey = row.model || "unknown";
    const currentM = modelUsage.get(modelKey) || {
      modelId: modelKey,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalRequests: 0,
      totalCost: 0,
    };
    currentM.totalTokens += t;
    currentM.inputTokens += inputT;
    currentM.outputTokens += outputT;
    currentM.totalRequests += 1;
    currentM.totalCost += cost;
    modelUsage.set(modelKey, currentM);
  }

  const userRanking = Array.from(userUsage.values())
    .sort((a, b) => {
      if (b.totalTokens !== a.totalTokens) return b.totalTokens - a.totalTokens;
      return b.totalRequests - a.totalRequests;
    })
    .filter((u) => u.totalTokens > 0 || u.totalRequests > 0);

  const modelRanking = Array.from(modelUsage.values())
    .sort((a, b) => {
      if (b.totalRequests !== a.totalRequests) return b.totalRequests - a.totalRequests;
      return b.totalTokens - a.totalTokens;
    })
    .filter((m) => m.totalTokens > 0 || m.totalRequests > 0);

  let validTokenCount = 0;
  for (const u of userUsage.values()) {
    validTokenCount += u.totalTokens;
  }

  const userRankingWithMetrics = await Promise.all(
    userRanking.map(async (u) => {
      try {
        const radarMetrics = await getRadarMetrics("user", u.userId, startTime, endTime);
        return {
          ...u,
          radarMetrics,
        };
      } catch (err) {
        return {
          ...u,
          radarMetrics: null,
        };
      }
    })
  );

  return {
    timeRange: {
      start: startTime.toISOString(),
      end: endTime.toISOString(),
    },
    systemSummary: {
      totalRequests: totalRequestsVal,
      totalTokens: totalTokensVal,
      totalInputTokens: totalInputTokensVal,
      totalOutputTokens: totalOutputTokensVal,
      totalCost: totalCostVal,
      validTokenCount: validTokenCount,
    },
    userRanking: userRankingWithMetrics,
    modelRanking,
  };
}
