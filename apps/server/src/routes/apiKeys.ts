import { FastifyInstance } from "fastify";
import { db } from "../db";
import { apiKeys, systemSettings, users } from "../db/schema";
import { eq, and, ne, desc } from "drizzle-orm";
import crypto from "crypto";
import { z } from "zod";
import { requireAuth, requireAdmin } from "../middleware/auth";
import { logAction } from "../utils/actionLogger";



const userCreateApiKeySchema = z.object({
  name: z.string().min(1),
}).passthrough();

const adminPatchApiKeySchema = z.object({
  status: z.enum(["active", "disabled", "revoked"]).optional(),
  concurrencyLimit: z.number().int().min(1).optional(),
  expiresAt: z.string().nullable().optional(),
});

async function getDefaultApiKeyConcurrency() {
  const settings = await db
    .select()
    .from(systemSettings)
    .where(eq(systemSettings.key, "defaultApiKeyConcurrency"));
  const parsed = settings.length > 0 ? Number(settings[0].value) : 2;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 2;
}

export default async function (fastify: FastifyInstance) {
  // Admin routes
  fastify.get(
    "/api/admin/api-keys",
    { onRequest: [requireAdmin] },
    async (request, reply) => {
      const list = await db
        .select({
          id: apiKeys.id,
          userId: apiKeys.userId,
          name: apiKeys.name,
          keyPrefix: apiKeys.keyPrefix,
          concurrencyLimit: apiKeys.concurrencyLimit,
          expiresAt: apiKeys.expiresAt,
          status: apiKeys.status,
          createdAt: apiKeys.createdAt,
          lastUsedAt: apiKeys.lastUsedAt,
          username: users.username,
        })
        .from(apiKeys)
        .leftJoin(users, eq(apiKeys.userId, users.id));
      return list;
    },
  );

  fastify.post(
    "/api/admin/api-keys",
    { onRequest: [requireAdmin] },
    async (request, reply) => {
      return reply.code(400).send({ error: "管理员不能代用户创建 API Key" });
    }
  );

  fastify.patch(
    "/api/admin/api-keys/:id",
    { onRequest: [requireAdmin] },
    async (request, reply) => {
      const { id } = request.params as any;
      const parsed = adminPatchApiKeySchema.safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send({ error: "参数不正确" });
      }
      const body = parsed.data;

      const existing = await db
        .select()
        .from(apiKeys)
        .where(eq(apiKeys.id, id));
      if (existing.length === 0) {
        return reply.code(404).send({ error: "API Key 不存在" });
      }

      if (existing[0].status === "revoked" && body.status && body.status !== "revoked") {
        return reply.code(400).send({ error: "已作废的 API Key 无法修改状态" });
      }

      const updateData: any = {};
      if (body.status !== undefined) updateData.status = body.status;
      if (body.concurrencyLimit !== undefined) {
        updateData.concurrencyLimit = body.concurrencyLimit;
      }
      if (body.expiresAt !== undefined) {
        if (body.expiresAt === null || body.expiresAt === "") {
          updateData.expiresAt = null;
        } else {
          const parsedDate = new Date(body.expiresAt);
          if (isNaN(parsedDate.getTime())) {
            return reply.code(400).send({ error: "过期时间格式不正确" });
          }
          updateData.expiresAt = parsedDate;
        }
      }

      if (Object.keys(updateData).length === 0) {
        return reply.code(400).send({ error: "没有可更新的字段" });
      }

      await db
        .update(apiKeys)
        .set(updateData)
        .where(eq(apiKeys.id, id));

      if (body.status === "revoked" && existing[0].status !== "revoked") {
        logAction({
          level: "WARN",
          code: "api_key.revoked",
          userId: existing[0].userId,
          apiKeyPrefix: existing[0].keyPrefix,
          message: "管理员作废 API Key",
        });
      } else if (body.status === "disabled" && existing[0].status !== "disabled") {
        logAction({
          level: "WARN",
          code: "api_key.status_changed",
          userId: existing[0].userId,
          apiKeyPrefix: existing[0].keyPrefix,
          status: "disabled"
        });
      } else if (body.status === "active" && existing[0].status !== "active") {
        logAction({
          level: "INFO",
          code: "api_key.status_changed",
          userId: existing[0].userId,
          apiKeyPrefix: existing[0].keyPrefix,
          status: "active"
        });
      }
      const updated = await db
        .select({
          id: apiKeys.id,
          status: apiKeys.status,
          concurrencyLimit: apiKeys.concurrencyLimit,
          expiresAt: apiKeys.expiresAt,
        })
        .from(apiKeys)
        .where(eq(apiKeys.id, id));
      return { success: true, apiKey: updated[0] };
    },
  );

  // User routes
  fastify.get(
    "/api/me/api-keys",
    { onRequest: [requireAuth] },
    async (request, reply) => {
      const user = request.user as any;
      const query = request.query as any;
      const conditions = [eq(apiKeys.userId, user.id)];
      if (query.includeRevoked !== "true") {
        conditions.push(ne(apiKeys.status, "revoked"));
      }
      return await db
        .select({
          id: apiKeys.id,
          name: apiKeys.name,
          keyPrefix: apiKeys.keyPrefix,
          status: apiKeys.status,
          createdAt: apiKeys.createdAt,
          lastUsedAt: apiKeys.lastUsedAt,
        })
        .from(apiKeys)
        .where(and(...conditions))
        .orderBy(desc(apiKeys.createdAt));
    },
  );

  fastify.post(
    "/api/me/api-keys",
    { onRequest: [requireAuth] },
    async (request, reply) => {
      const parsed = userCreateApiKeySchema.safeParse(request.body);
      if (!parsed.success)
        return reply.code(400).send({ error: "参数不正确" });

      const user = request.user as any;
      const { name } = parsed.data;

      const rawKey = "pg_" + crypto.randomBytes(24).toString("hex");
      const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");
      const keyPrefix = rawKey.substring(0, 8);

      const existingKeys = await db
        .select({ id: apiKeys.id, keyPrefix: apiKeys.keyPrefix })
        .from(apiKeys)
        .where(and(eq(apiKeys.userId, user.id), ne(apiKeys.status, "revoked")));

      if (existingKeys.length > 0) {
        await db
          .update(apiKeys)
          .set({ status: "revoked" })
          .where(and(eq(apiKeys.userId, user.id), ne(apiKeys.status, "revoked")));

        logAction({
          level: "WARN",
          code: "api_key.revoked",
          userId: user.id,
          username: user.username,
          message: `作废旧 API Key 数量=${existingKeys.length}`,
        });
      }

      await db.insert(apiKeys).values({
        id: crypto.randomUUID(),
        userId: user.id,
        name,
        keyHash,
        keyPrefix,
        concurrencyLimit: await getDefaultApiKeyConcurrency(),
        expiresAt: null,
        status: "active",
        createdAt: new Date(),
      });

      logAction({
        level: "INFO",
        code: "api_key.created",
        userId: user.id,
        username: user.username,
        apiKeyPrefix: keyPrefix,
        keyName: name,
      });

      return { success: true, apiKey: rawKey };
    },
  );

  fastify.patch(
    "/api/me/api-keys/:id",
    { onRequest: [requireAuth] },
    async (request, reply) => {
      const { id } = request.params as any;
      const body = request.body as any;
      const user = request.user as any;

      if (body.status !== "revoked") {
        return reply.code(400).send({ error: "状态值不合法" });
      }

      const existing = await db
        .select({ id: apiKeys.id, status: apiKeys.status, keyPrefix: apiKeys.keyPrefix })
        .from(apiKeys)
        .where(and(eq(apiKeys.id, id), eq(apiKeys.userId, user.id)));
      if (existing.length === 0) {
        return reply.code(404).send({ error: "API Key 不存在" });
      }

      if (existing[0].status === "revoked") {
        return reply.code(400).send({ error: "该 API Key 已删除" });
      }

      await db
        .update(apiKeys)
        .set({ status: "revoked" })
        .where(and(eq(apiKeys.id, id), eq(apiKeys.userId, user.id)));

      logAction({
        level: "WARN",
        code: "api_key.revoked",
        userId: user.id,
        username: user.username,
        apiKeyPrefix: existing[0].keyPrefix,
        message: "用户作废自己的 API Key",
      });

      return { success: true, status: "revoked" };
    },
  );
}
