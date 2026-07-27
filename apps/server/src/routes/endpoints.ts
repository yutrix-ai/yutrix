import { FastifyInstance } from "fastify";
import { db } from "../db";
import {
  endpoints,
  endpointRoutes,
  subdomains,
  providers,
  providerModels,
  promptPolicies,
  systemSettings,
} from "../db/schema";
import { eq, and } from "drizzle-orm";
import crypto from "crypto";
import { z } from "zod";
import { requireAdmin } from "../middleware/auth";

const endpointSchema = z.object({
  name: z.string().optional(),
  path: z.string().startsWith("/"),
  virtualModelAlias: z.string().optional(),
  loadBalanceMode: z.string().default("failover"),
  incomingProtocol: z.string().default("openai"),
  enabled: z.boolean().default(true),
  timeoutMs: z.number().default(0),
  queueTimeoutMs: z.number().default(0),
  maxBodyMb: z.number().default(0),
  status: z.string().default("active"),
  defaultProviderId: z.string().optional(),
  defaultPromptPolicyId: z.string().nullable().optional(),
});

const routeSchema = z.object({
  subdomainId: z.string().nullable().optional(),
  providerId: z.string(),
  providerProtocol: z.string().default("openai"),
  modelId: z.string(),
  enabled: z.boolean().default(true),
  promptPolicyId: z.string().nullable().optional(),
  weight: z.number().default(1),
  priority: z.number().default(0),
  status: z.string().default("active"),
});

/**
 * Validate route data when enabled=true:
 * - providerId must exist and be enabled
 * - modelId must belong to providerId + providerProtocol
 * - promptPolicyId (if set) must exist and be enabled
 * Returns null if valid, or an error string if invalid.
 */
async function validateRouteIfEnabled(
  data: z.infer<typeof routeSchema>,
): Promise<string | null> {
  // If disabled, we allow the special placeholder values used during auto-creation
  const isPlaceholder = !data.enabled && (data.providerId === "setup_required" || data.modelId === "setup_required");

  if (!isPlaceholder) {
    // If enabled, placeholders are not allowed
    if (data.enabled && (!data.providerId || data.providerId === "setup_required")) {
      return "启用路由前必须选择供应商";
    }
    if (data.enabled && (!data.modelId || data.modelId === "setup_required")) {
      return "启用路由前必须选择模型";
    }

    // Only validate DB existence if not a placeholder. (If disabled and it's a placeholder, we skip DB check).
    // If they provide real IDs (even if disabled), we must validate them.

    // providerId must exist (and if enabled, must be active)
    const provList = await db
      .select()
      .from(providers)
      .where(eq(providers.id, data.providerId));
    if (provList.length === 0) {
      return "供应商不存在";
    }
    if (data.enabled && !provList[0].enabled) {
      return "供应商已禁用，无法启用该路由";
    }

    // modelId must belong to providerId + providerProtocol
    const modelList = await db
      .select()
      .from(providerModels)
      .where(
        and(
          eq(providerModels.providerId, data.providerId),
          eq(providerModels.modelId, data.modelId),
        ),
      );
    if (modelList.length === 0) {
      return `模型 ${data.modelId} 不属于该供应商的 ${data.providerProtocol} 协议`;
    }
  }

  // promptPolicyId validation (if provided)
  if (data.promptPolicyId) {
    const policyList = await db
      .select()
      .from(promptPolicies)
      .where(eq(promptPolicies.id, data.promptPolicyId));
    if (policyList.length === 0) {
      return "提示词策略不存在";
    }
    const policy = policyList[0];
    if (data.enabled && !policy.enabled) {
      return "提示词策略已禁用，无法启用该路由";
    }
    if (policy.protocol !== data.providerProtocol) {
      return `提示词策略协议 (${policy.protocol}) 与路由供应商协议 (${data.providerProtocol}) 不匹配`;
    }
  }

  return null;
}

export default async function (fastify: FastifyInstance) {
  // List all endpoints
  fastify.get(
    "/api/admin/endpoints",
    { onRequest: [requireAdmin] },
    async (request, reply) => {
      return await db.select().from(endpoints);
    },
  );

  // Create an endpoint + auto-create placeholder routes for all active subdomains
  fastify.post(
    "/api/admin/endpoints",
    { onRequest: [requireAdmin] },
    async (request, reply) => {
      const parsed = endpointSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "Invalid input", details: parsed.error.issues });
      }

      // Require at least one enabled subdomain before creating an endpoint
      const allSubdomains = await db.select().from(subdomains);
      const activeSubdomains = allSubdomains.filter((s) => s.enabled);
      if (activeSubdomains.length === 0) {
        return reply.code(400).send({ error: "请先启用至少一个二级域名" });
      }

      const user = request.user as any;
      const data = parsed.data;

      const id = crypto.randomUUID();
      try {
        await db.insert(endpoints).values({
          id,
          userId: user.id,
          name: data.name,
          path: data.path,
          virtualModelAlias: data.virtualModelAlias || null,
          loadBalanceMode: data.loadBalanceMode,
          incomingProtocol: data.incomingProtocol,
          enabled: data.enabled,
          timeoutMs: data.timeoutMs,
          queueTimeoutMs: data.queueTimeoutMs,
          maxBodyMb: data.maxBodyMb,
          status: data.status,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      } catch (e: any) {
        if (e.message?.includes("UNIQUE constraint failed: endpoints.name, endpoints.path, endpoints.incomingProtocol")) {
          return reply.code(400).send({ error: "端点名称、监听路径、协议类型的组合已存在，请修改后再试" });
        }
        throw e;
      }

      // Auto-create a route for each active subdomain
      const isConfigured = !!data.defaultProviderId && !!data.virtualModelAlias;

      for (const sub of activeSubdomains) {
        await db.insert(endpointRoutes).values({
          id: crypto.randomUUID(),
          endpointId: id,
          subdomainId: sub.id,
          providerId: data.defaultProviderId || "setup_required",
          providerProtocol: data.incomingProtocol,
          modelId: data.virtualModelAlias || "setup_required",
          promptPolicyId: data.defaultPromptPolicyId || null,
          enabled: isConfigured, // Automatically enable if configured
          weight: 1,
          priority: 0,
          status: isConfigured ? "active" : "pending_setup",
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }

      // Also create a wildcard route (subdomainId = null) for allowUnknownHostFallback
      const fallbackSetting = await db
        .select()
        .from(systemSettings)
        .where(eq(systemSettings.key, "allowUnknownHostFallback"));
      const allowFallback =
        fallbackSetting.length > 0 && fallbackSetting[0].value === "true";
      if (allowFallback) {
        await db.insert(endpointRoutes).values({
          id: crypto.randomUUID(),
          endpointId: id,
          subdomainId: null,
          providerId: data.defaultProviderId || "setup_required",
          providerProtocol: data.incomingProtocol,
          modelId: data.virtualModelAlias || "setup_required",
          promptPolicyId: data.defaultPromptPolicyId || null,
          enabled: isConfigured,
          weight: 1,
          priority: 0,
          status: isConfigured ? "active" : "pending_setup",
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }

      return { success: true, id };
    },
  );

  // Update an endpoint
  fastify.patch(
    "/api/admin/endpoints/:id",
    { onRequest: [requireAdmin] },
    async (request, reply) => {
      const { id } = request.params as any;
      const parsed = endpointSchema.partial().safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid input" });
      }

      const data = parsed.data;

      const existing = await db
        .select()
        .from(endpoints)
        .where(eq(endpoints.id, id));
      if (existing.length === 0) {
        return reply.code(404).send({ error: "Endpoint not found" });
      }

      const updateData = { ...data, updatedAt: new Date() };
      delete updateData.defaultProviderId;
      delete updateData.defaultPromptPolicyId;

      try {
        await db.update(endpoints).set(updateData).where(eq(endpoints.id, id));

        // Always bulk update all routes under this endpoint with the new config
        if (data.defaultProviderId !== undefined || data.virtualModelAlias !== undefined) {
          const isConfigured = !!data.defaultProviderId && !!data.virtualModelAlias;
          await db.update(endpointRoutes).set({
            providerId: data.defaultProviderId || "setup_required",
            modelId: data.virtualModelAlias || "setup_required",
            providerProtocol: data.incomingProtocol || "openai",
            promptPolicyId: data.defaultPromptPolicyId || null,
            enabled: isConfigured,
            status: isConfigured ? "active" : "pending_setup",
            updatedAt: new Date(),
          }).where(eq(endpointRoutes.endpointId, id));
        }

      } catch (e: any) {
        if (e.message?.includes("UNIQUE constraint failed: endpoints.name, endpoints.path, endpoints.incomingProtocol")) {
          return reply.code(400).send({ error: "更新失败：端点名称、监听路径、协议类型的组合已存在" });
        }
        throw e;
      }

      return { success: true };
    },
  );

  // Delete an endpoint and its routes
  fastify.delete(
    "/api/admin/endpoints/:id",
    { onRequest: [requireAdmin] },
    async (request, reply) => {
      const { id } = request.params as any;
      await db.delete(endpointRoutes).where(eq(endpointRoutes.endpointId, id));
      await db.delete(endpoints).where(eq(endpoints.id, id));
      return { success: true };
    },
  );

  // --- Endpoint Routes CRUD ---

  // List routes for an endpoint
  fastify.get(
    "/api/admin/endpoints/:id/routes",
    { onRequest: [requireAdmin] },
    async (request, reply) => {
      const { id } = request.params as any;
      return await db
        .select()
        .from(endpointRoutes)
        .where(eq(endpointRoutes.endpointId, id));
    },
  );

  // Create a route for an endpoint (with validation)
  fastify.post(
    "/api/admin/endpoints/:id/routes",
    { onRequest: [requireAdmin] },
    async (request, reply) => {
      const { id } = request.params as any;
      const parsed = routeSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "Invalid input", details: parsed.error.issues });
      }

      const data = parsed.data;

      // Check endpoint exists
      const endpointList = await db
        .select()
        .from(endpoints)
        .where(eq(endpoints.id, id));
      if (endpointList.length === 0) {
        return reply.code(404).send({ error: "端点不存在" });
      }

      // Check subdomain exists and enabled (if subdomainId provided)
      if (data.subdomainId) {
        const subList = await db
          .select()
          .from(subdomains)
          .where(
            and(
              eq(subdomains.id, data.subdomainId),
              eq(subdomains.enabled, true),
            ),
          );
        if (subList.length === 0) {
          return reply.code(400).send({ error: "二级域名不存在或已禁用" });
        }
      }

      // Validate if enabled
      const validationError = await validateRouteIfEnabled(data);
      if (validationError) {
        return reply.code(400).send({ error: validationError });
      }

      const routeId = crypto.randomUUID();

      await db.insert(endpointRoutes).values({
        id: routeId,
        endpointId: id,
        subdomainId: data.subdomainId || null,
        providerId: data.providerId,
        providerProtocol: data.providerProtocol,
        modelId: data.modelId,
        enabled: data.enabled,
        promptPolicyId: data.promptPolicyId || null,
        weight: data.weight,
        priority: data.priority,
        status: data.enabled ? "active" : data.status,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      return { success: true, id: routeId };
    },
  );

  // Update a route (with validation)
  fastify.patch(
    "/api/admin/endpoints/routes/:routeId",
    { onRequest: [requireAdmin] },
    async (request, reply) => {
      const { routeId } = request.params as any;
      const parsed = routeSchema.partial().safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid input" });
      }

      // Merge with existing route to get full state for validation
      const existingRoutes = await db
        .select()
        .from(endpointRoutes)
        .where(eq(endpointRoutes.id, routeId));
      if (existingRoutes.length === 0) {
        return reply.code(404).send({ error: "路由不存在" });
      }

      const existing = existingRoutes[0];
      const merged = {
        subdomainId:
          parsed.data.subdomainId !== undefined
            ? parsed.data.subdomainId
            : existing.subdomainId,
        providerId: parsed.data.providerId ?? existing.providerId,
        providerProtocol:
          parsed.data.providerProtocol ?? existing.providerProtocol,
        modelId: parsed.data.modelId ?? existing.modelId,
        enabled: parsed.data.enabled ?? existing.enabled,
        promptPolicyId:
          parsed.data.promptPolicyId !== undefined
            ? parsed.data.promptPolicyId
            : existing.promptPolicyId,
        weight: parsed.data.weight ?? existing.weight,
        priority: parsed.data.priority ?? existing.priority,
        status: parsed.data.status ?? existing.status ?? "active",
      };

      // Check subdomain exists and enabled (if subdomainId is set and changed)
      if (merged.subdomainId) {
        const subList = await db
          .select()
          .from(subdomains)
          .where(
            and(
              eq(subdomains.id, merged.subdomainId),
              eq(subdomains.enabled, true),
            ),
          );
        if (subList.length === 0) {
          return reply.code(400).send({ error: "二级域名不存在或已禁用" });
        }
      }

      // Validate if the merged state is enabled
      const validationError = await validateRouteIfEnabled(merged);
      if (validationError) {
        return reply.code(400).send({ error: validationError });
      }

      await db
        .update(endpointRoutes)
        .set({ ...parsed.data, updatedAt: new Date() })
        .where(eq(endpointRoutes.id, routeId));
      return { success: true };
    },
  );

  // Delete a route
  fastify.delete(
    "/api/admin/endpoints/routes/:routeId",
    { onRequest: [requireAdmin] },
    async (request, reply) => {
      const { routeId } = request.params as any;
      await db.delete(endpointRoutes).where(eq(endpointRoutes.id, routeId));
      return { success: true };
    },
  );
}
