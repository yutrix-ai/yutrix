import { FastifyInstance } from "fastify";
import { db } from "../db";
import { users, apiKeys, requestLogs, providerModels, userGroups, userGroupMembers } from "../db/schema";
import { eq, and, ne, sql, gte, lt } from "drizzle-orm";
import crypto from "crypto";
import { z } from "zod";
import { requireAdmin } from "../middleware/auth";
import { getQueryDateRange } from "../utils/timeRange";
import bcrypt from "bcryptjs";
import { strongPasswordSchema } from "../utils/password";
import { summedRequestCostSql } from "../utils/requestCostSql";
import { normalizeTokenLimit, resolveEffectiveMaxInputTokens } from "../services/userTokenLimits";

const createUserSchema = z.object({
  username: z.string().min(2, "用户名至少需要 2 个字符"),
  password: strongPasswordSchema,
  role: z.enum(["admin", "user"]).default("user"),
  maxInputTokensOverride: z.number().int().nonnegative().nullable().optional(),
});

const updateUserSchema = z.object({
  role: z.enum(["admin", "user"]).optional(),
  status: z.enum(["active", "disabled"]).optional(),
  maxInputTokensOverride: z.number().int().nonnegative().nullable().optional(),
});

export default async function (fastify: FastifyInstance) {
  // List all users (admin only)
  fastify.get(
    "/api/admin/users",
    { onRequest: [requireAdmin] },
    async (request, reply) => {
      const { startDate, endDate } = await getQueryDateRange(request.query, "all");
      const list = await db.select().from(users).where(ne(users.status, "deleted"));

      // Get API key count and usage stats for each user
      const usersWithStats = await Promise.all(
        list.map(async (user) => {
          const keys = await db
            .select()
            .from(apiKeys)
            .where(eq(apiKeys.userId, user.id));

          const conditions = [eq(requestLogs.userId, user.id), gte(requestLogs.createdAt, startDate)];
          if (endDate) {
            conditions.push(lt(requestLogs.createdAt, endDate));
          }

          const usageStats = await db
            .select({
              totalRequests: sql<number>`COUNT(*)`,
              totalTokens: sql<number>`SUM(${requestLogs.inputTokens} + ${requestLogs.outputTokens})`,
              totalInputTokens: sql<number>`SUM(${requestLogs.inputTokens})`,
              totalOutputTokens: sql<number>`SUM(${requestLogs.outputTokens})`,
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
            .where(and(...conditions));

          const effectiveInputTokenLimit = await resolveEffectiveMaxInputTokens(user.id);

          return {
            id: user.id,
            username: user.username,
            role: user.role,
            status: user.status,
            maxInputTokensOverride: user.maxInputTokensOverride,
            effectiveMaxInputTokens: effectiveInputTokenLimit.maxInputTokens,
            effectiveMaxInputTokensSource: effectiveInputTokenLimit.source,
            effectiveMaxInputTokensSourceLabel: effectiveInputTokenLimit.sourceLabel,
            createdAt: user.createdAt,
            updatedAt: user.updatedAt,
            lastLoginAt: user.lastLoginAt,
            apiKeyCount: keys.length,
            totalRequests: usageStats[0]?.totalRequests || 0,
            totalTokens: usageStats[0]?.totalTokens || 0,
            totalInputTokens: usageStats[0]?.totalInputTokens || 0,
            totalOutputTokens: usageStats[0]?.totalOutputTokens || 0,
            totalCost: usageStats[0]?.totalCost || 0,
          };
        })
      );

      return usersWithStats;
    }
  );

  // Create user (admin only)
  fastify.post(
    "/api/admin/users",
    { onRequest: [requireAdmin] },
    async (request, reply) => {
      const parsed = createUserSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "输入无效", details: parsed.error.issues });
      }

      const { username, password, role, maxInputTokensOverride } = parsed.data;

      // Check if username exists
      const existing = await db
        .select()
        .from(users)
        .where(eq(users.username, username));

      if (existing.length > 0) {
        return reply.code(400).send({ error: "用户名已存在" });
      }

      const passwordHash = await bcrypt.hash(password, 10);
      const id = crypto.randomUUID();
      const now = new Date();

      await db.insert(users).values({
        id,
        username,
        passwordHash,
        role,
        status: "active",
        maxInputTokensOverride:
          maxInputTokensOverride === undefined || maxInputTokensOverride === null
            ? null
            : normalizeTokenLimit(maxInputTokensOverride),
        createdAt: now,
        updatedAt: now,
      });

      if (role === "user") {
        const defaultGroups = await db
          .select()
          .from(userGroups)
          .where(eq(userGroups.isDefault, true));
        if (defaultGroups.length > 0) {
          await db.insert(userGroupMembers).values({
            id: crypto.randomUUID(),
            groupId: defaultGroups[0].id,
            userId: id,
            createdAt: now,
          });
        }
      }

      return { success: true, id };
    }
  );

  // Update user (admin only)
  fastify.patch(
    "/api/admin/users/:id",
    { onRequest: [requireAdmin] },
    async (request, reply) => {
      const { id } = request.params as any;
      const parsed = updateUserSchema.safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send({ error: "输入无效", details: parsed.error.issues });
      }

      const data = parsed.data;
      const updateData: Record<string, any> = { ...data };
      if (data.maxInputTokensOverride !== undefined) {
        updateData.maxInputTokensOverride =
          data.maxInputTokensOverride === null
            ? null
            : normalizeTokenLimit(data.maxInputTokensOverride);
      }

      const existing = await db.select().from(users).where(eq(users.id, id));
      if (existing.length === 0) {
        return reply.code(404).send({ error: "用户不存在" });
      }

      await db
        .update(users)
        .set({ ...updateData, updatedAt: new Date() })
        .where(eq(users.id, id));

      return { success: true };
    }
  );

  // Reset user password (admin only)
  fastify.post(
    "/api/admin/users/:id/reset-password",
    { onRequest: [requireAdmin] },
    async (request, reply) => {
      const { id } = request.params as any;

      const existing = await db.select().from(users).where(eq(users.id, id));
      if (existing.length === 0) {
        return reply.code(404).send({ error: "用户不存在" });
      }

      // Generate random password
      const newPassword = crypto.randomBytes(12).toString("base64url");
      const passwordHash = await bcrypt.hash(newPassword, 10);

      await db
        .update(users)
        .set({ passwordHash, updatedAt: new Date() })
        .where(eq(users.id, id));

      return { success: true, newPassword };
    }
  );

  // Get user's API keys (admin only)
  fastify.get(
    "/api/admin/users/:id/api-keys",
    { onRequest: [requireAdmin] },
    async (request, reply) => {
      const { id } = request.params as any;

      const keys = await db.select().from(apiKeys).where(eq(apiKeys.userId, id));

      return keys.map((k) => ({
        id: k.id,
        name: k.name,
        keyPrefix: k.keyPrefix,
        status: k.status,
        createdAt: k.createdAt,
        lastUsedAt: k.lastUsedAt,
      }));
    }
  );

  // Get user's usage stats (admin only)
  fastify.get(
    "/api/admin/users/:id/usage",
    { onRequest: [requireAdmin] },
    async (request, reply) => {
      const { id } = request.params as any;
      const { startDate, endDate } = await getQueryDateRange(request.query, "all");

      const conditions = [eq(requestLogs.userId, id), gte(requestLogs.createdAt, startDate)];
      if (endDate) {
        conditions.push(lt(requestLogs.createdAt, endDate));
      }

      const stats = await db
        .select({
          totalRequests: sql<number>`COUNT(*)`,
          totalTokens: sql<number>`SUM(${requestLogs.inputTokens} + ${requestLogs.outputTokens})`,
          totalInputTokens: sql<number>`SUM(${requestLogs.inputTokens})`,
          totalOutputTokens: sql<number>`SUM(${requestLogs.outputTokens})`,
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
        .where(and(...conditions));

      return stats[0] || {
        totalRequests: 0,
        totalTokens: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCost: 0,
      };
    }
  );

  // Delete user (admin only)
  fastify.delete(
    "/api/admin/users/:id",
    { onRequest: [requireAdmin] },
    async (request, reply) => {
      const { id } = request.params as any;
      const user = request.user as any;

      if (id === user.id) {
        return reply.code(400).send({ error: "不能删除当前登录用户" });
      }

      const existing = await db.select().from(users).where(eq(users.id, id));
      if (existing.length === 0) {
        return reply.code(404).send({ error: "用户不存在" });
      }

      // Soft delete: revoke API keys and set user status to deleted
      await db
        .update(apiKeys)
        .set({ status: "revoked" })
        .where(eq(apiKeys.userId, id));

      await db
        .update(users)
        .set({ status: "deleted", updatedAt: new Date() })
        .where(eq(users.id, id));

      return { success: true };
    }
  );
}
