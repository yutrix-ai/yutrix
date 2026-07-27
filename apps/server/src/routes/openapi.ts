import { FastifyInstance } from "fastify";
import { db } from "../db";
import { openapiKeys, users } from "../db/schema";
import { eq, desc } from "drizzle-orm";
import crypto from "crypto";
import { z } from "zod";
import { requireAdmin } from "../middleware/auth";
import { logAction } from "../utils/actionLogger";
import { getStatisticsData } from "../services/statistics";

const createApiKeySchema = z.object({
  name: z.string().min(1),
}).passthrough();

export default async function (fastify: FastifyInstance) {
  fastify.get(
    "/api/admin/openapi-keys",
    { onRequest: [requireAdmin] },
    async (request, reply) => {
      return await db
        .select({
          id: openapiKeys.id,
          userId: openapiKeys.userId,
          name: openapiKeys.name,
          keyPrefix: openapiKeys.keyPrefix,
          status: openapiKeys.status,
          createdAt: openapiKeys.createdAt,
          lastUsedAt: openapiKeys.lastUsedAt,
          username: users.username,
        })
        .from(openapiKeys)
        .leftJoin(users, eq(openapiKeys.userId, users.id))
        .orderBy(desc(openapiKeys.createdAt));
    },
  );

  fastify.post(
    "/api/admin/openapi-keys",
    { onRequest: [requireAdmin] },
    async (request, reply) => {
      const parsed = createApiKeySchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "参数不正确" });

      const user = request.user as any;
      const { name } = parsed.data;

      const rawKey = "pg_oa_" + crypto.randomBytes(24).toString("hex");
      const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");
      const keyPrefix = rawKey.substring(0, 14);

      await db.insert(openapiKeys).values({
        id: crypto.randomUUID(),
        userId: user.id,
        name,
        keyHash,
        keyPrefix,
        status: "active",
        createdAt: new Date(),
      });

      logAction({
        level: "INFO",
        code: "openapi_key.created",
        userId: user.id,
        username: user.username,
        apiKeyPrefix: keyPrefix,
        keyName: name,
      });

      return { success: true, apiKey: rawKey };
    },
  );

  fastify.delete(
    "/api/admin/openapi-keys/:id",
    { onRequest: [requireAdmin] },
    async (request, reply) => {
      const { id } = request.params as any;
      const user = request.user as any;

      const existing = await db
        .select()
        .from(openapiKeys)
        .where(eq(openapiKeys.id, id));

      if (existing.length === 0) {
        return reply.code(404).send({ error: "OpenAPI Key 不存在" });
      }

      await db
        .delete(openapiKeys)
        .where(eq(openapiKeys.id, id));

      logAction({
        level: "WARN",
        code: "openapi_key.deleted",
        userId: user.id,
        username: user.username,
        apiKeyPrefix: existing[0].keyPrefix,
        message: "管理员删除 OpenAPI Key",
      });

      return { success: true };
    },
  );

  fastify.get(
    "/api/admin/openapi-keys/test-statistics",
    { onRequest: [requireAdmin] },
    async (request, reply) => {
      const now = new Date();
      const start = new Date(now.getTime() - 24 * 60 * 60 * 1000); // 24 hours ago
      const end = now;
      const stats = await getStatisticsData(start, end);
      return stats;
    },
  );

  fastify.get("/api/openapi/v1/statistics", async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    const token = authHeader.substring(7);
    const keyHash = crypto.createHash("sha256").update(token).digest("hex");

    const keyRecord = await db
      .select({ id: openapiKeys.id, userId: openapiKeys.userId, status: openapiKeys.status })
      .from(openapiKeys)
      .where(eq(openapiKeys.keyHash, keyHash));

    if (keyRecord.length === 0 || keyRecord[0].status !== "active") {
      return reply.code(401).send({ error: "Invalid or inactive API Key" });
    }

    const adminUser = await db
      .select({ id: users.id, role: users.role, status: users.status })
      .from(users)
      .where(eq(users.id, keyRecord[0].userId));

    if (adminUser.length === 0 || adminUser[0].role !== "admin" || adminUser[0].status !== "active") {
      return reply.code(403).send({ error: "Forbidden: Not an active admin" });
    }

    const query = request.query as any;
    if (!query.startTime || !query.endTime) {
      return reply.code(400).send({ error: "startTime and endTime are required (ISO8601 format)" });
    }

    const start = new Date(query.startTime);
    const end = new Date(query.endTime);

    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return reply.code(400).send({ error: "Invalid date format. Use ISO8601." });
    }

    await db.update(openapiKeys).set({ lastUsedAt: new Date() }).where(eq(openapiKeys.id, keyRecord[0].id));

    const stats = await getStatisticsData(start, end);
    return stats;
  });
}
