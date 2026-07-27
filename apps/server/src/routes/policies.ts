import { FastifyInstance } from "fastify";
import { db } from "../db";
import { promptPolicies } from "../db/schema";
import { eq } from "drizzle-orm";
import crypto from "crypto";
import { z } from "zod";
import { requireAdmin } from "../middleware/auth";

const policySchema = z.object({
  name: z.string().min(1),
  protocol: z.enum(["openai", "anthropic"]).default("openai"),
  injectPosition: z
    .enum(["messages_unshift", "append_system", "replace_system", "system"])
    .default("append_system"),
  injectMode: z
    .enum(["every_request", "once_per_conversation"])
    .default("every_request"),
  conversationKeySource: z.enum(["header", "body"]).default("header"),
  conversationKeyName: z.string().default("X-Conversation-Id"),
  fallbackMode: z
    .enum(["treat_as_new", "skip_injection", "error"])
    .default("treat_as_new"),
  content: z.string(), // JSON string for unshift or raw string for append
  description: z.string().optional(),
  enabled: z.boolean().default(true),
});

export default async function (fastify: FastifyInstance) {
  fastify.get(
    "/api/admin/policies",
    { onRequest: [requireAdmin] },
    async (request, reply) => {
      return await db.select().from(promptPolicies);
    },
  );

  fastify.post(
    "/api/admin/policies",
    { onRequest: [requireAdmin] },
    async (request, reply) => {
      const parsed = policySchema.safeParse(request.body);
      if (!parsed.success)
        return reply
          .code(400)
          .send({ error: "Invalid input", details: parsed.error.issues });

      const user = request.user as any;
      const data = parsed.data;

      await db.insert(promptPolicies).values({
        id: crypto.randomUUID(),
        userId: user.id,
        name: data.name,
        protocol: data.protocol,
        injectPosition: data.injectPosition,
        injectMode: data.injectMode,
        conversationKeySource: data.conversationKeySource,
        conversationKeyName: data.conversationKeyName,
        fallbackMode: data.fallbackMode,
        content: data.content,
        description: data.description,
        version: 1,
        enabled: data.enabled,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      return { success: true };
    },
  );

  fastify.patch(
    "/api/admin/policies/:id",
    { onRequest: [requireAdmin] },
    async (request, reply) => {
      const { id } = request.params as any;
      const parsed = policySchema.partial().safeParse(request.body);
      if (!parsed.success)
        return reply.code(400).send({ error: "Invalid input" });

      const data = parsed.data;

      const existing = await db
        .select()
        .from(promptPolicies)
        .where(eq(promptPolicies.id, id));
      if (existing.length === 0)
        return reply.code(404).send({ error: "Policy not found" });

      const updateData = {
        ...data,
        updatedAt: new Date(),
        version: existing[0].version + 1,
      };
      await db
        .update(promptPolicies)
        .set(updateData)
        .where(eq(promptPolicies.id, id));

      return { success: true };
    },
  );

  fastify.delete(
    "/api/admin/policies/:id",
    { onRequest: [requireAdmin] },
    async (request, reply) => {
      const { id } = request.params as any;
      await db.delete(promptPolicies).where(eq(promptPolicies.id, id));
      return { success: true };
    },
  );
}
