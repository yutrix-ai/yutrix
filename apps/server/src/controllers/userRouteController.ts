import { FastifyRequest, FastifyReply } from "fastify";
import { db } from "../db";
import {
  subdomains,
  endpoints,
  endpointRoutes,
  providers,
  providerModels,
  userRouteOverrides,
} from "../db/schema";
import { eq, and } from "drizzle-orm";
import crypto from "crypto";
import { logAction } from "../utils/actionLogger";
import {
  getActiveRouteSchedule,
  getDailyStartTime,
} from "../utils/scheduleEvaluator";
import { getUserAuthorizedRouteIds } from "../services/routeService";
import { normalizeUserRouteOverridePayload } from "../services/clientModelOverride";
import { isClassicRoutingMode, resolveRouteRoutingMode } from "../services/opcAgentRouting";

export async function getUserRoutes(request: FastifyRequest, reply: FastifyReply) {
  const user = request.user as any;

  const isAdmin = user.role === "admin";
  const authorizedRouteIds = isAdmin ? null : await getUserAuthorizedRouteIds(user.id);

  const allProviders = await db.select().from(providers);
  const providerMap = new Map(allProviders.map((p: any) => [p.id, p]));

  const allProviderModels = await db.select().from(providerModels);
  const modelMap = new Map(allProviderModels.map((m: any) => [`${m.providerId}:${m.modelId}`, m]));

  const validOverrides = new Set<string>();
  for (const pm of allProviderModels) {
    validOverrides.add(`${pm.providerId}:${pm.modelId}`);
  }

  const dailyStartStr = await getDailyStartTime();
  const now = new Date();

  const rows = await db
    .select({
      route: endpointRoutes,
      endpoint: endpoints,
      subdomain: subdomains,
      override: userRouteOverrides,
      provider: providers,
      model: providerModels,
    })
    .from(endpointRoutes)
    .leftJoin(endpoints, eq(endpointRoutes.endpointId, endpoints.id))
    .leftJoin(subdomains, eq(endpointRoutes.subdomainId, subdomains.id))
    .leftJoin(providers, eq(endpointRoutes.providerId, providers.id))
    .leftJoin(
      providerModels,
      and(
        eq(providerModels.providerId, endpointRoutes.providerId),
        eq(providerModels.modelId, endpointRoutes.modelId)
      )
    )
    .leftJoin(userRouteOverrides, and(
      eq(userRouteOverrides.routeId, endpointRoutes.id),
      eq(userRouteOverrides.userId, user.id)
    ))
    .where(eq(endpointRoutes.enabled, true));

  const result = rows
    .filter(({ route }) => isAdmin || authorizedRouteIds!.has(route.id))
    .map(({ route, endpoint, subdomain, override, provider, model }) => {
      let activeProviderId = route.providerId;
      let activeProviderProtocol = route.providerProtocol;
      let activeProviderName = (provider as any)?.name || "Unknown Provider";
      let activeModelId = route.modelId;
      let activeModelName = (model as any)?.displayName || route.modelId;
      let activeAllowClientModel = route.allowClientModel;

      const activeSchedule = getActiveRouteSchedule(route.schedules, now, dailyStartStr);
      if (activeSchedule) {
        activeProviderId = activeSchedule.providerId;
        activeProviderProtocol = activeSchedule.providerProtocol;

        const schedProv = providerMap.get(activeSchedule.providerId);
        activeProviderName = schedProv?.name || "Unknown Provider";

        activeModelId = activeSchedule.modelId;

        const modelKey = `${activeSchedule.providerId}:${activeSchedule.providerProtocol}:${activeSchedule.modelId}`;
        const schedModel = modelMap.get(modelKey);
        activeModelName = schedModel?.displayName || activeSchedule.modelId;

        activeAllowClientModel = !!activeSchedule.allowClientModel;
      }

      let finalOverrideModelId = override?.modelId || null;
      if (finalOverrideModelId && !validOverrides.has(`${activeProviderId}:${finalOverrideModelId}`)) {
         finalOverrideModelId = null;
      }

      // Client override is exclusive with a fixed page modelId
      const useClientModel = !!(override as any)?.useClientModel && !finalOverrideModelId;

      return {
        id: route.id,
        name: route.name || endpoint?.name || "未命名规则",
        host: subdomain ? subdomain.hostname : "*",
        path: endpoint?.path || "",
        incomingProtocol: endpoint?.incomingProtocol || "openai",
        routingMode: resolveRouteRoutingMode(route),
        allowClientModel: activeAllowClientModel,
        providerId: activeProviderId,
        providerName: activeProviderName,
        providerProtocol: activeProviderProtocol || "openai",
        defaultModelId: activeModelId,
        defaultModelName: activeModelName,
        overrideModelId: useClientModel ? null : finalOverrideModelId,
        useClientModel,
        overrideStrategyRules: useClientModel ? null : (override?.strategyRoutingRules || null),
        strategyRoutingEnabled: activeSchedule
          ? false
          : (isClassicRoutingMode(route) ? false : (route.strategyRoutingEnabled || false)),
        strategyRoutingRules: route.strategyRoutingRules,
      };
    });

  return reply.send(result);
}

export async function getProviderModels(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: string };
  return await db.select().from(providerModels).where(eq(providerModels.providerId, id));
}

export async function overrideUserRoute(request: FastifyRequest, reply: FastifyReply) {
  const user = request.user as any;
  const { id } = request.params as { id: string };
  const body = request.body as {
    modelId?: string | null;
    strategyRoutingRules?: string | null;
    useClientModel?: boolean | null;
  };

  const authorizedRouteIds = await getUserAuthorizedRouteIds(user.id);
  if (!authorizedRouteIds.has(id)) {
    return reply.code(403).send({ error: "无权访问该路由" });
  }

  const routes = await db.select().from(endpointRoutes).where(eq(endpointRoutes.id, id));
  if (routes.length === 0 || !routes[0].enabled) {
    return reply.code(404).send({ error: "Route not found or disabled" });
  }

  const route = routes[0];
  let activeAllowClientModel = route.allowClientModel;
  let activeProviderId = route.providerId;
  let activeProviderProtocol = route.providerProtocol;

  const dailyStartStr = await getDailyStartTime();
  const activeSchedule = getActiveRouteSchedule(route.schedules, new Date(), dailyStartStr);
  if (activeSchedule) {
    activeAllowClientModel = !!activeSchedule.allowClientModel;
    activeProviderId = activeSchedule.providerId;
    activeProviderProtocol = activeSchedule.providerProtocol;
  }

  if (!activeAllowClientModel) {
    return reply.code(403).send({ error: "This route does not allow client model override" });
  }

  if (isClassicRoutingMode(route) && body.strategyRoutingRules) {
    return reply.code(400).send({ error: "经典路由不支持自定义策略映射" });
  }

  // Enforce mutual exclusion: client mode vs fixed modelId vs custom strategy
  const normalized = normalizeUserRouteOverridePayload({
    useClientModel: body.useClientModel,
    modelId: body.modelId,
    strategyRoutingRules: body.strategyRoutingRules,
  });

  if (normalized.mode === "default") {
    // Clear override
    await db.delete(userRouteOverrides).where(and(
      eq(userRouteOverrides.routeId, id),
      eq(userRouteOverrides.userId, user.id)
    ));
    return reply.send({ success: true, mode: "default" });
  }

  // Validate fixed modelId if provided (not used in client mode)
  if (normalized.modelId) {
    const models = await db.select().from(providerModels).where(
      and(
        eq(providerModels.providerId, activeProviderId),
        eq(providerModels.modelId, normalized.modelId)
      )
    );

    if (models.length === 0) {
      return reply.code(400).send({ error: "Invalid model for this provider" });
    }
  }

  // Validate strategyRoutingRules if provided
  if (normalized.strategyRoutingRules) {
    try {
      const rules = JSON.parse(normalized.strategyRoutingRules);
      if (!Array.isArray(rules)) throw new Error("Rules must be an array");
      const validModels = await db.select().from(providerModels).where(eq(providerModels.providerId, activeProviderId));
      const validModelIds = new Set(validModels.map(m => m.modelId));
      for (const r of rules) {
        if (r.modelId && r.providerId === activeProviderId && !validModelIds.has(r.modelId)) {
          return reply.code(400).send({ error: `Invalid model ${r.modelId} for this provider` });
        }
      }
    } catch (e: any) {
      return reply.code(400).send({ error: "Invalid strategy rules format: " + e.message });
    }
  }

  // Upsert override — never store fixed modelId together with useClientModel
  const existing = await db.select().from(userRouteOverrides).where(and(
    eq(userRouteOverrides.routeId, id),
    eq(userRouteOverrides.userId, user.id)
  ));

  const overrideValues = {
    modelId: normalized.modelId,
    useClientModel: normalized.useClientModel,
    strategyRoutingRules: normalized.strategyRoutingRules,
    updatedAt: new Date(),
  };

  if (existing.length > 0) {
    await db.update(userRouteOverrides)
      .set(overrideValues)
      .where(eq(userRouteOverrides.id, existing[0].id));
  } else {
    await db.insert(userRouteOverrides).values({
      id: crypto.randomUUID(),
      userId: user.id,
      routeId: id,
      modelId: overrideValues.modelId,
      useClientModel: overrideValues.useClientModel,
      strategyRoutingRules: overrideValues.strategyRoutingRules,
      createdAt: new Date(),
      updatedAt: overrideValues.updatedAt,
    });
  }

  logAction({
    level: "INFO",
    code: "route.model_override.set",
    username: user.username,
    routeId: id,
    routeName: route.name as string | undefined,
    modelId: normalized.modelId as string | undefined,
    useClientModel: normalized.useClientModel,
    mode: normalized.mode,
  });

  return reply.send({ success: true, mode: normalized.mode });
}
