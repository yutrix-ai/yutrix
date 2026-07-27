import { FastifyInstance } from "fastify";
import { db } from "../db";
import { requestLogs, apiKeys, providerModels } from "../db/schema";
import { desc, eq, sql, and, gte, lt, gt } from "drizzle-orm";
import { requireAuth } from "../middleware/auth";
import { getQueryDateRange } from "../utils/timeRange";
import { requestCostSql, summedRequestCostSql } from "../utils/requestCostSql";
import { publicModelSql } from "../utils/modelAlias";

export default async function (fastify: FastifyInstance) {
  fastify.get(
    "/api/me/usage",
    { onRequest: [requireAuth] },
    async (request, reply) => {
      const user = request.user as any;
      const { startDate, endDate } = await getQueryDateRange(request.query, "all");
      const conditions = [eq(requestLogs.userId, user.id), gte(requestLogs.createdAt, startDate)];
      if (endDate) {
        conditions.push(lt(requestLogs.createdAt, endDate));
      }

      const apiKeyUsage = await db
        .select({
          apiKeyId: requestLogs.apiKeyId,
          apiKeyPrefix: apiKeys.keyPrefix,
          totalRequests: sql<number>`count(${requestLogs.id})`,
          totalPromptTokens: sql<number>`coalesce(sum(${requestLogs.inputTokens}), 0)`,
          totalCompletionTokens: sql<number>`coalesce(sum(${requestLogs.outputTokens}), 0)`,
          totalTokens: sql<number>`coalesce(sum(${requestLogs.inputTokens} + ${requestLogs.outputTokens}), 0)`,
          totalCost: summedRequestCostSql,
          errorCount: sql<number>`sum(case when ${requestLogs.statusCode} >= 400 then 1 else 0 end)`,
          lastRequestAt: sql<Date | null>`max(${requestLogs.createdAt})`,
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
        .groupBy(requestLogs.apiKeyId, apiKeys.keyPrefix);

      const totals = await db
        .select({
          totalRequests: sql<number>`count(${requestLogs.id})`,
          totalTokens: sql<number>`coalesce(sum(${requestLogs.inputTokens} + ${requestLogs.outputTokens}), 0)`,
          totalPromptTokens: sql<number>`coalesce(sum(${requestLogs.inputTokens}), 0)`,
          totalCompletionTokens: sql<number>`coalesce(sum(${requestLogs.outputTokens}), 0)`,
          totalCost: summedRequestCostSql,
          errorCount: sql<number>`sum(case when ${requestLogs.statusCode} >= 400 then 1 else 0 end)`,
          lastRequestAt: sql<Date | null>`max(${requestLogs.createdAt})`,
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

      const recentLogs = await db
        .select({
          id: requestLogs.id,
          requestId: requestLogs.requestId,
          apiKeyId: requestLogs.apiKeyId,
          apiKeyPrefix: apiKeys.keyPrefix,
          model: publicModelSql(),
          statusCode: requestLogs.statusCode,
          inputTokens: requestLogs.inputTokens,
          outputTokens: requestLogs.outputTokens,
          totalTokens: requestLogs.totalTokens,
          cost: requestCostSql,
          latencyMs: requestLogs.latencyMs,
          errorMessage: requestLogs.errorMessage,
          createdAt: requestLogs.createdAt,
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
        .where(eq(requestLogs.userId, user.id))
        .orderBy(desc(requestLogs.createdAt))
        .limit(20);

      const summary = totals[0] ?? {
        totalRequests: 0,
        totalTokens: 0,
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
        errorCount: 0,
        lastRequestAt: null,
      };
      const totalRequests = Number(summary.totalRequests ?? 0);
      const errorCount = Number(summary.errorCount ?? 0);

      return {
        totalRequests,
        totalTokens: Number(summary.totalTokens ?? 0),
        totalPromptTokens: Number(summary.totalPromptTokens ?? 0),
        totalCompletionTokens: Number(summary.totalCompletionTokens ?? 0),
        totalCost: Number(summary.totalCost ?? 0),
        successRate:
          totalRequests > 0
            ? Math.round(((totalRequests - errorCount) / totalRequests) * 1000) / 10
            : 0,
        errorCount,
        lastRequestAt: summary.lastRequestAt,
        apiKeyUsage,
        recentLogs,
      };
    },
  );

  fastify.get(
    "/api/me/usage/logs",
    { onRequest: [requireAuth] },
    async (request, reply) => {
      const user = request.user as any;
      const limit = Number((request.query as any).limit) || 20;
      const before = (request.query as any).before;
      const after = (request.query as any).after;

      let whereCondition: any = eq(requestLogs.userId, user.id);

      if (before) {
        whereCondition = and(whereCondition, lt(requestLogs.createdAt, new Date(before)));
      }

      if (after) {
        whereCondition = and(whereCondition, gt(requestLogs.createdAt, new Date(after)));
      }

      const logs = await db
        .select({
          id: requestLogs.id,
          requestId: requestLogs.requestId,
          apiKeyId: requestLogs.apiKeyId,
          apiKeyPrefix: apiKeys.keyPrefix,
          model: publicModelSql(),
          statusCode: requestLogs.statusCode,
          inputTokens: requestLogs.inputTokens,
          outputTokens: requestLogs.outputTokens,
          totalTokens: requestLogs.totalTokens,
          cost: requestCostSql,
          latencyMs: requestLogs.latencyMs,
          errorMessage: requestLogs.errorMessage,
          createdAt: requestLogs.createdAt,
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
        .where(whereCondition)
        .orderBy(desc(requestLogs.createdAt))
        .limit(limit);

      return { data: logs, hasMore: logs.length >= limit };
    },
  );

  fastify.get(
    "/api/me/usage/dashboard",
    { onRequest: [requireAuth] },
    async (request, reply) => {
      const user = request.user as any;
      const { startDate, endDate } = await getQueryDateRange(request.query, "all");
      const conditions = [eq(requestLogs.userId, user.id), gte(requestLogs.createdAt, startDate)];
      if (endDate) {
        conditions.push(lt(requestLogs.createdAt, endDate));
      }

      const avgLatencyResult = await db
        .select({
          avgLatency: sql<number>`AVG(${requestLogs.latencyMs})`,
        })
        .from(requestLogs)
        .where(and(...conditions));

      const modelBreakdown = await db
        .select({
          model: publicModelSql(),
          totalRequests: sql<number>`count(${requestLogs.id})`,
          totalTokens: sql<number>`coalesce(sum(${requestLogs.inputTokens} + ${requestLogs.outputTokens}), 0)`,
          totalCost: summedRequestCostSql,
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
        .orderBy(sql`count(${requestLogs.id}) DESC`)
        .limit(10);

      const recentRequests = await db
        .select({
          id: requestLogs.id,
          model: publicModelSql(),
          statusCode: requestLogs.statusCode,
          inputTokens: requestLogs.inputTokens,
          outputTokens: requestLogs.outputTokens,
          totalTokens: requestLogs.totalTokens,
          latencyMs: requestLogs.latencyMs,
          cost: requestCostSql,
          createdAt: requestLogs.createdAt,
        })
        .from(requestLogs)
        .leftJoin(
          providerModels,
          and(
            eq(requestLogs.providerId, providerModels.providerId),

            eq(requestLogs.model, providerModels.modelId)
          )
        )
        .where(eq(requestLogs.userId, user.id))
        .orderBy(desc(requestLogs.createdAt))
        .limit(10);

      return {
        avgLatencyMs: Math.round(avgLatencyResult[0]?.avgLatency || 0),
        modelBreakdown,
        recentRequests,
      };
    },
  );
}
