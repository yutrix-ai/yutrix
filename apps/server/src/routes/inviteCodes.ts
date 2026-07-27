import { FastifyInstance } from "fastify";
import { db } from "../db";
import { inviteCodes } from "../db/schema";
import { eq } from "drizzle-orm";
import crypto from "crypto";
import { z } from "zod";
import { requireAdmin } from "../middleware/auth";

const createInviteCodeSchema = z.object({
  maxUses: z.number().min(1).default(1),
  expiresAt: z.string().optional(), // ISO date string
});

const updateInviteCodeSchema = z.object({
  maxUses: z.number().min(1).optional(),
  expiresAt: z.string().nullable().optional(),
  status: z.enum(["active", "disabled"]).optional(),
});

export default async function (fastify: FastifyInstance) {
  // List all invite codes (admin only)
  fastify.get(
    "/api/admin/invite-codes",
    { onRequest: [requireAdmin] },
    async (request, reply) => {
      const list = await db.select().from(inviteCodes);

      return list.map((code) => ({
        id: code.id,
        codePrefix: code.codePrefix,
        maxUses: code.maxUses,
        usedCount: code.usedCount,
        expiresAt: code.expiresAt,
        status: code.status,
        createdBy: code.createdBy,
        createdAt: code.createdAt,
      }));
    }
  );

  // Create invite code (admin only)
  fastify.post(
    "/api/admin/invite-codes",
    { onRequest: [requireAdmin] },
    async (request, reply) => {
      const parsed = createInviteCodeSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "输入无效", details: parsed.error.issues });
      }

      const { maxUses, expiresAt } = parsed.data;

      // Generate random invite code
      const rawCode = "pg-inv-" + crypto.randomBytes(12).toString("base64url");
      const codeHash = crypto.createHash("sha256").update(rawCode).digest("hex");
      const codePrefix = rawCode.substring(0, 12);

      const id = crypto.randomUUID();
      const now = new Date();

      await db.insert(inviteCodes).values({
        id,
        codeHash,
        codePrefix,
        maxUses,
        usedCount: 0,
        expiresAt: expiresAt ? new Date(expiresAt) : null,
        status: "active",
        createdBy: (request.user as any).id,
        createdAt: now,
      });

      // Return the raw code (only shown once)
      return { success: true, id, code: rawCode };
    }
  );

  // Update invite code (admin only)
  fastify.patch(
    "/api/admin/invite-codes/:id",
    { onRequest: [requireAdmin] },
    async (request, reply) => {
      const { id } = request.params as any;
      const parsed = updateInviteCodeSchema.safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send({ error: "输入无效", details: parsed.error.issues });
      }

      const data = parsed.data;

      const existing = await db.select().from(inviteCodes).where(eq(inviteCodes.id, id));
      if (existing.length === 0) {
        return reply.code(404).send({ error: "邀请码不存在" });
      }

      const updateData: any = {};
      if (data.maxUses !== undefined) updateData.maxUses = data.maxUses;
      if (data.expiresAt !== undefined) {
        updateData.expiresAt = data.expiresAt ? new Date(data.expiresAt) : null;
      }
      if (data.status !== undefined) updateData.status = data.status;

      await db.update(inviteCodes).set(updateData).where(eq(inviteCodes.id, id));

      return { success: true };
    }
  );

  // Delete invite code (admin only)
  fastify.delete(
    "/api/admin/invite-codes/:id",
    { onRequest: [requireAdmin] },
    async (request, reply) => {
      const { id } = request.params as any;

      const existing = await db.select().from(inviteCodes).where(eq(inviteCodes.id, id));
      if (existing.length === 0) {
        return reply.code(404).send({ error: "邀请码不存在" });
      }

      await db.delete(inviteCodes).where(eq(inviteCodes.id, id));

      return { success: true };
    }
  );
}
