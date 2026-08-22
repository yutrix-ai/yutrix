import { FastifyInstance } from "fastify";
import { db } from "../db";
import { responseCache } from "../db/schema";
import { eq, desc } from "drizzle-orm";
import crypto from "crypto";
import { requireAdmin } from "../middleware/auth";
import { evaluateResponseCacheWrite } from "../services/loopGuard";

export default async function (fastify: FastifyInstance) {
  // GET /api/admin/cache — list all cache entries
  fastify.get(
    "/api/admin/cache",
    { onRequest: [requireAdmin] },
    async (request, reply) => {
      const entries = await db
        .select()
        .from(responseCache)
        .orderBy(desc(responseCache.createdAt));
      return entries;
    },
  );

  // POST /api/admin/cache — create a new cache entry
  fastify.post(
    "/api/admin/cache",
    { onRequest: [requireAdmin] },
    async (request, reply) => {
      const { inputText, responseText, model, sourceLogId } = request.body as {
        inputText: string;
        responseText: string;
        model?: string;
        sourceLogId?: string;
      };

      const writeGate = evaluateResponseCacheWrite(inputText || "");
      if (!writeGate.ok) {
        return reply.code(writeGate.status).send({ error: writeGate.error });
      }

      const inputHash = crypto
        .createHash("md5")
        .update(inputText)
        .digest("hex");

      const existing = await db
        .select()
        .from(responseCache)
        .where(eq(responseCache.inputHash, inputHash))
        .limit(1);

      if (existing.length > 0) {
        return reply.code(409).send({
          error: "Cache entry already exists for this input",
          existing: existing[0],
        });
      }

      const newId = crypto.randomUUID();
      await db.insert(responseCache).values({
        id: newId,
        inputHash,
        inputText,
        responseText,
        model: model ?? null,
        sourceLogId: sourceLogId ?? null,
        hitCount: 0,
        createdBy: (request as any).user?.id,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      return { success: true, id: newId };
    },
  );

  // PATCH /api/admin/cache/:id — update a cache entry
  fastify.patch(
    "/api/admin/cache/:id",
    { onRequest: [requireAdmin] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { responseText, model } = request.body as {
        responseText?: string;
        model?: string;
      };

      const existing = await db
        .select()
        .from(responseCache)
        .where(eq(responseCache.id, id))
        .limit(1);

      if (existing.length === 0) {
        return reply.code(404).send({ error: "Cache entry not found" });
      }

      const updateData: Record<string, any> = { updatedAt: new Date() };
      if (responseText !== undefined) updateData.responseText = responseText;
      if (model !== undefined) updateData.model = model;

      await db
        .update(responseCache)
        .set(updateData)
        .where(eq(responseCache.id, id));

      return { success: true };
    },
  );

  // DELETE /api/admin/cache/:id — delete a cache entry
  fastify.delete(
    "/api/admin/cache/:id",
    { onRequest: [requireAdmin] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      await db.delete(responseCache).where(eq(responseCache.id, id));

      return { success: true };
    },
  );
}
