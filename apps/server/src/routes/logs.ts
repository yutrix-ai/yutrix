import { FastifyInstance } from "fastify";
import { db } from "../db";
import { requestLogs, systemSettings, providerModels } from "../db/schema";
import { eq, and, sql, gte, lt, like, desc } from "drizzle-orm";
import { requireAdmin } from "../middleware/auth";
import { getQueryDateRange } from "../utils/timeRange";
import { PassThrough } from "stream";
import {
  getActionLogEntries,
  getActionLogHistory,
  logAction,
  subscribeActionLogs,
} from "../utils/actionLogger";

export default async function (fastify: FastifyInstance) {
  // Get paginated request logs with filters
  fastify.get(
    "/api/admin/logs",
    { onRequest: [requireAdmin] },
    async (request, reply) => {
      const {
        page = "1",
        limit = "50",
        startDate,
        endDate,
        statusCode,
        userId,
        providerId,
        endpointId,
        requestId,
        model,
      } = request.query as any;

      const pageNum = parseInt(page);
      const limitNum = parseInt(limit);
      const offset = (pageNum - 1) * limitNum;

      // Build where conditions
      const conditions = [];

      if (startDate) {
        conditions.push(gte(requestLogs.createdAt, new Date(startDate)));
      }

      if (endDate) {
        conditions.push(lt(requestLogs.createdAt, new Date(endDate)));
      }

      if (statusCode) {
        conditions.push(eq(requestLogs.statusCode, parseInt(statusCode)));
      }

      if (userId) {
        conditions.push(eq(requestLogs.userId, userId));
      }

      if (providerId) {
        conditions.push(eq(requestLogs.providerId, providerId));
      }

      if (endpointId) {
        conditions.push(eq(requestLogs.endpointId, endpointId));
      }

      if (requestId) {
        conditions.push(eq(requestLogs.requestId, requestId));
      }

      if (model) {
        conditions.push(like(requestLogs.model, `%${model}%`));
      }

      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

      // Get total count
      const countResult = await db
        .select({ count: sql<number>`COUNT(*)` })
        .from(requestLogs)
        .where(whereClause);

      const total = countResult[0]?.count || 0;

      // Get paginated results
      const logsRaw = await db
        .select({
          log: requestLogs,
          alias: providerModels.alias
        })
        .from(requestLogs)
        .leftJoin(providerModels, and(
          eq(requestLogs.providerId, providerModels.providerId),
          eq(requestLogs.model, providerModels.modelId)
        ))
        .where(whereClause)
        .orderBy(desc(requestLogs.createdAt))
        .limit(limitNum)
        .offset(offset);

      const logs = logsRaw.map(r => ({
        ...r.log,
        model: r.alias || r.log.model
      }));

      return {
        data: logs,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total,
          totalPages: Math.ceil(total / limitNum),
        },
      };
    }
  );

  // SSE endpoint for real-time logs
  fastify.get(
    "/api/admin/logs/stream",
    { onRequest: [requireAdmin] },
    async (request, reply) => {
      const settings = await db
        .select()
        .from(systemSettings)
        .where(eq(systemSettings.key, "realtimeLogsEnabled"));
      const realtimeLogsEnabled = settings.length === 0 || settings[0].value !== "false";
      const stream = new PassThrough();

      // Set SSE headers
      reply.header("Content-Type", "text/event-stream");
      reply.header("Cache-Control", "no-cache, no-transform");
      reply.header("Connection", "keep-alive");
      reply.header("X-Accel-Buffering", "no");

      const writeEvent = (event: string | null, data: unknown) => {
        if (event) stream.write(`event: ${event}\n`);
        stream.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      let isClosed = false;
      let unsubscribe: (() => void) | undefined;

      if (!realtimeLogsEnabled) {
        writeEvent("disabled", { message: "实时日志已关闭" });
      } else {
        writeEvent(null, {
          timestamp: new Date().toISOString(),
          level: "信息",
          line: "实时日志已连接",
        });

        const historyLimit = Number((request.query as any)?.limit || 200);
        for (const entry of getActionLogEntries(Number.isFinite(historyLimit) ? historyLimit : 200)) {
          writeEvent(null, entry);
        }

        unsubscribe = subscribeActionLogs((entry) => {
          if (!isClosed) writeEvent(null, entry);
        });
      }

      const interval = setInterval(() => {
        if (!isClosed) writeEvent("ping", {});
      }, 15000);

      request.raw.on("close", () => {
        isClosed = true;
        clearInterval(interval);
        unsubscribe?.();
        stream.end();
      });

      return reply.send(stream);
    }
  );

  // Test Action Log
  fastify.post(
    "/api/admin/logs/test",
    { onRequest: [requireAdmin] },
    async (request, reply) => {
      const user = request.user as any;
      logAction({
        level: "INFO",
        code: "log.test",
        message: "这是一条实时日志测试",
        username: user?.username,
      });
      return { success: true };
    }
  );

  // Get real-time action log history
  fastify.get(
    "/api/admin/logs/action-history",
    { onRequest: [requireAdmin] },
    async (request, reply) => {
      const limit = Number((request.query as any)?.limit || 200);
      return getActionLogEntries(Number.isFinite(limit) ? limit : 200);
    }
  );

  fastify.get(
    "/api/admin/logs/action-history/entries",
    { onRequest: [requireAdmin] },
    async (request, reply) => {
      const limit = Number((request.query as any)?.limit || 200);
      return getActionLogEntries(Number.isFinite(limit) ? limit : 200);
    }
  );

  // Get log statistics
  fastify.get(
    "/api/admin/logs/stats",
    { onRequest: [requireAdmin] },
    async (request, reply) => {
      const { startDate, endDate } = await getQueryDateRange(request.query, "7");

      const conditions = [gte(requestLogs.createdAt, startDate)];
      if (endDate) {
        conditions.push(lt(requestLogs.createdAt, endDate));
      }

      const stats = await db
        .select({
          total: sql<number>`COUNT(*)`,
          success: sql<number>`SUM(CASE WHEN ${requestLogs.statusCode} >= 200 AND ${requestLogs.statusCode} < 300 THEN 1 ELSE 0 END)`,
          error: sql<number>`SUM(CASE WHEN ${requestLogs.statusCode} >= 400 THEN 1 ELSE 0 END)`,
          avgLatency: sql<number>`AVG(${requestLogs.latencyMs})`,
          totalTokens: sql<number>`COALESCE(SUM(${requestLogs.inputTokens} + ${requestLogs.outputTokens}), 0)`,
        })
        .from(requestLogs)
        .where(and(...conditions));

      const total = stats[0]?.total || 0;
      const success = stats[0]?.success || 0;
      const error = stats[0]?.error || 0;

      return {
        total,
        success,
        error,
        successRate: total > 0 ? Math.round((success / total) * 10000) / 100 : 100,
        errorRate: total > 0 ? Math.round((error / total) * 10000) / 100 : 0,
        avgLatency: Math.round(stats[0]?.avgLatency || 0),
        totalTokens: stats[0]?.totalTokens || 0,
      };
    }
  );

  // Get top error messages
  fastify.get(
    "/api/admin/logs/top-errors",
    { onRequest: [requireAdmin] },
    async (request, reply) => {
      const { startDate, endDate } = await getQueryDateRange(request.query, "7");
      const { limit = "10" } = request.query as any;

      const conditions = [
        gte(requestLogs.createdAt, startDate),
        sql`${requestLogs.statusCode} >= 400`
      ];
      if (endDate) {
        conditions.push(lt(requestLogs.createdAt, endDate));
      }

      const errors = await db
        .select({
          errorMessage: requestLogs.errorMessage,
          errorCode: requestLogs.errorCode,
          count: sql<number>`COUNT(*)`,
        })
        .from(requestLogs)
        .where(and(...conditions))
        .groupBy(requestLogs.errorMessage, requestLogs.errorCode)
        .orderBy(sql`COUNT(*) DESC`)
        .limit(parseInt(limit));

      return errors;
    }
  );
}
