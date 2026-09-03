import { FastifyInstance } from "fastify";
import { db } from "../db";
import {
  userGroups,
  userGroupMembers,
  users,
  routeAuthorizations,
} from "../db/schema";
import { eq, and, ne, inArray } from "drizzle-orm";
import crypto from "crypto";
import { requireAdmin } from "../middleware/auth";
import { logAction } from "../utils/actionLogger";
import { normalizeTokenLimit, resolveEffectiveMaxInputTokens } from "../services/userTokenLimits";

export default async function (fastify: FastifyInstance) {
  fastify.get("/api/admin/groups", { onRequest: [requireAdmin] }, async (request, reply) => {
    const groups = await db.select().from(userGroups);
    const result = await Promise.all(
      groups.map(async (group) => {
        const members = await db
          .select()
          .from(userGroupMembers)
          .where(eq(userGroupMembers.groupId, group.id));
        return {
          ...group,
          memberCount: members.length,
        };
      })
    );
    return result;
  });

  fastify.post("/api/admin/groups", { onRequest: [requireAdmin] }, async (request, reply) => {
    const user = request.user as any;
    const body = request.body as any;
    const { name, description } = body;
    const maxInputTokens = normalizeTokenLimit(body.maxInputTokens);

    if (!name || !name.trim()) {
      return reply.code(400).send({ error: "组名不能为空" });
    }

    const existing = await db
      .select()
      .from(userGroups)
      .where(eq(userGroups.name, name.trim()));
    if (existing.length > 0) {
      return reply.code(400).send({ error: "组名已存在" });
    }

    const id = crypto.randomUUID();
    const now = new Date();
    await db.insert(userGroups).values({
      id,
      name: name.trim(),
      description: description || null,
      isDefault: false,
      maxInputTokens,
      createdAt: now,
      updatedAt: now,
    });

    logAction({
      level: "信息",
      action: "用户组创建",
      username: user.username,
      groupId: id,
      groupName: name.trim(),
    });

    return reply.code(201).send({ id, success: true });
  });

  fastify.patch("/api/admin/groups/:id", { onRequest: [requireAdmin] }, async (request, reply) => {
    const user = request.user as any;
    const { id } = request.params as { id: string };
    const body = request.body as any;

    const existing = await db.select().from(userGroups).where(eq(userGroups.id, id));
    if (existing.length === 0) {
      return reply.code(404).send({ error: "用户组不存在" });
    }

    if (body.name !== undefined) {
      const nameConflict = await db
        .select()
        .from(userGroups)
        .where(and(eq(userGroups.name, body.name.trim()), ne(userGroups.id, id)));
      if (nameConflict.length > 0) {
        return reply.code(400).send({ error: "组名已存在" });
      }
    }

    await db
      .update(userGroups)
      .set({
        name: body.name !== undefined ? body.name.trim() : existing[0].name,
        description: body.description !== undefined ? body.description : existing[0].description,
        maxInputTokens:
          body.maxInputTokens !== undefined
            ? normalizeTokenLimit(body.maxInputTokens)
            : existing[0].maxInputTokens,
        updatedAt: new Date(),
      })
      .where(eq(userGroups.id, id));

    logAction({
      level: "信息",
      action: "用户组更新",
      username: user.username,
      groupId: id,
      groupName: body.name !== undefined ? body.name.trim() : existing[0].name,
    });

    return { success: true };
  });

  fastify.delete("/api/admin/groups/:id", { onRequest: [requireAdmin] }, async (request, reply) => {
    const user = request.user as any;
    const { id } = request.params as { id: string };

    const existing = await db.select().from(userGroups).where(eq(userGroups.id, id));
    if (existing.length === 0) {
      return reply.code(404).send({ error: "用户组不存在" });
    }

    if (existing[0].isDefault) {
      return reply.code(400).send({ error: "不能删除默认组" });
    }

    await db.delete(routeAuthorizations).where(eq(routeAuthorizations.groupId, id));
    await db.delete(userGroupMembers).where(eq(userGroupMembers.groupId, id));
    await db.delete(userGroups).where(eq(userGroups.id, id));

    logAction({
      level: "警告",
      action: "用户组删除",
      username: user.username,
      groupId: id,
      groupName: existing[0].name,
    });

    return { success: true };
  });

  fastify.get("/api/admin/groups/:id/members", { onRequest: [requireAdmin] }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const group = await db.select().from(userGroups).where(eq(userGroups.id, id));
    if (group.length === 0) {
      return reply.code(404).send({ error: "用户组不存在" });
    }

    const memberRows = await db
      .select({
        id: userGroupMembers.id,
        userId: userGroupMembers.userId,
        username: users.username,
        role: users.role,
        status: users.status,
        joinedAt: userGroupMembers.createdAt,
      })
      .from(userGroupMembers)
      .leftJoin(users, eq(userGroupMembers.userId, users.id))
      .where(eq(userGroupMembers.groupId, id));

    const members = await Promise.all(
      memberRows.map(async (member) => {
        const effectiveInputTokenLimit = await resolveEffectiveMaxInputTokens(member.userId);
        return {
          ...member,
          effectiveMaxInputTokens: effectiveInputTokenLimit.maxInputTokens,
          effectiveMaxInputTokensSource: effectiveInputTokenLimit.source,
          effectiveMaxInputTokensSourceLabel: effectiveInputTokenLimit.sourceLabel,
        };
      }),
    );

    return members;
  });

  fastify.post("/api/admin/groups/:id/members", { onRequest: [requireAdmin] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as any;
    const { userId } = body;

    if (!userId) {
      return reply.code(400).send({ error: "缺少用户ID" });
    }

    const group = await db.select().from(userGroups).where(eq(userGroups.id, id));
    if (group.length === 0) {
      return reply.code(404).send({ error: "用户组不存在" });
    }

    const user = await db.select().from(users).where(eq(users.id, userId));
    if (user.length === 0) {
      return reply.code(404).send({ error: "用户不存在" });
    }

    const existingMemberships = await db
      .select()
      .from(userGroupMembers)
      .where(eq(userGroupMembers.userId, userId));

    const alreadyInTarget = existingMemberships.some((m) => m.groupId === id);
    const otherMemberships = existingMemberships.filter((m) => m.groupId !== id);
    const previousGroupIds = Array.from(new Set(otherMemberships.map((m) => m.groupId)));
    const moved = otherMemberships.length > 0;

    // Remove user from all other groups
    if (otherMemberships.length > 0) {
      await db
        .delete(userGroupMembers)
        .where(
          and(
            eq(userGroupMembers.userId, userId),
            ne(userGroupMembers.groupId, id)
          )
        );
    }

    // Ensure membership in the target group
    if (!alreadyInTarget) {
      await db.insert(userGroupMembers).values({
        id: crypto.randomUUID(),
        groupId: id,
        userId,
        createdAt: new Date(),
      });
    } else {
      // Clean up any redundant duplicate rows in the target group
      const targetMemberships = existingMemberships.filter((m) => m.groupId === id);
      if (targetMemberships.length > 1) {
        const extraIds = targetMemberships.slice(1).map((m) => m.id);
        await db.delete(userGroupMembers).where(inArray(userGroupMembers.id, extraIds));
      }
    }

    return {
      success: true,
      moved,
      previousGroupIds,
    };
  });

  fastify.delete("/api/admin/groups/:id/members/:userId", { onRequest: [requireAdmin] }, async (request, reply) => {
    const { id, userId } = request.params as { id: string; userId: string };

    const group = await db.select().from(userGroups).where(eq(userGroups.id, id));
    if (group.length === 0) {
      return reply.code(404).send({ error: "用户组不存在" });
    }

    await db
      .delete(userGroupMembers)
      .where(
        and(
          eq(userGroupMembers.groupId, id),
          eq(userGroupMembers.userId, userId)
        )
      );

    return { success: true };
  });

  fastify.get("/api/admin/groups/users-for-select", { onRequest: [requireAdmin] }, async (request, reply) => {
    const allUsers = await db
      .select({
        id: users.id,
        username: users.username,
        role: users.role,
        status: users.status,
      })
      .from(users)
      .where(ne(users.status, "deleted"));
    return allUsers;
  });
}
