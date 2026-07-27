import { FastifyInstance } from "fastify";
import { db } from "../db";
import { subdomains, endpoints, endpointRoutes } from "../db/schema";
import { eq } from "drizzle-orm";
import { systemSettings } from "../db/schema";
import crypto from "crypto";
import { z } from "zod";
import { requireAdmin } from "../middleware/auth";

const subdomainSchema = z.object({
  name: z
    .string()
    .min(3)
    .max(63)
    .regex(/^[a-z0-9-]+$/),
  description: z.string().optional(),
  enabled: z.boolean().default(true),
});

export default async function (fastify: FastifyInstance) {
  fastify.get(
    "/api/admin/subdomains",
    { onRequest: [requireAdmin] },
    async (request, reply) => {
      return await db.select().from(subdomains);
    },
  );

  fastify.post(
    "/api/admin/subdomains",
    { onRequest: [requireAdmin] },
    async (request, reply) => {
      const parsed = subdomainSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "Invalid input", details: parsed.error.issues });
      }

      const user = request.user as any;
      const { name, description, enabled } = parsed.data;

      const existing = await db
        .select()
        .from(subdomains)
        .where(eq(subdomains.name, name));
      if (existing.length > 0) {
        return reply.code(400).send({ error: "Subdomain already taken" });
      }

      const mainDomainSettings = await db
        .select()
        .from(systemSettings)
        .where(eq(systemSettings.key, "mainDomain"));
      const mainDomain =
        mainDomainSettings.length > 0 ? mainDomainSettings[0].value : "";

      let hostname = "";
      if (mainDomain) {
        hostname = `${name}.${mainDomain}`;
      } else {
        if (process.env.NODE_ENV === "production") {
          return reply
            .code(400)
            .send({ error: "生产环境请先在系统设置中配置主域名 (mainDomain)" });
        } else {
          hostname = `${name}.localhost`;
        }
      }

      const newSubdomainId = crypto.randomUUID();
      await db.insert(subdomains).values({
        id: newSubdomainId,
        userId: user.id,
        name: name,
        hostname,
        description: description || null,
        enabled: enabled,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Auto-create a placeholder endpoint_route for each existing endpoint
      const existingEndpoints = await db.select().from(endpoints);
      for (const ep of existingEndpoints) {
        await db.insert(endpointRoutes).values({
          id: crypto.randomUUID(),
          endpointId: ep.id,
          subdomainId: newSubdomainId,
          providerId: "setup_required",
          providerProtocol: ep.incomingProtocol,
          modelId: "setup_required",
          enabled: false,
          weight: 1,
          priority: 0,
          status: "pending_setup",
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }

      return { success: true, id: newSubdomainId };
    },
  );

  fastify.patch(
    "/api/admin/subdomains/:id",
    { onRequest: [requireAdmin] },
    async (request, reply) => {
      const { id } = request.params as any;
      const parsed = z
        .object({
          enabled: z.boolean().optional(),
          description: z.string().optional(),
        })
        .safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid input" });
      }

      const data = parsed.data;

      const existing = await db
        .select()
        .from(subdomains)
        .where(eq(subdomains.id, id));
      if (existing.length === 0) {
        return reply.code(404).send({ error: "Subdomain not found" });
      }

      const updateData: any = { updatedAt: new Date() };
      if (data.enabled !== undefined) updateData.enabled = data.enabled;
      if (data.description !== undefined)
        updateData.description = data.description;

      await db.update(subdomains).set(updateData).where(eq(subdomains.id, id));
      return { success: true };
    },
  );

  fastify.delete(
    "/api/admin/subdomains/:id",
    { onRequest: [requireAdmin] },
    async (request, reply) => {
      const { id } = request.params as any;

      const existing = await db
        .select()
        .from(subdomains)
        .where(eq(subdomains.id, id));
      if (existing.length === 0) {
        return reply.code(404).send({ error: "Subdomain not found" });
      }

      // Also delete associated endpoint_routes
      await db.delete(endpointRoutes).where(eq(endpointRoutes.subdomainId, id));
      await db.delete(subdomains).where(eq(subdomains.id, id));
      return { success: true };
    },
  );
}
