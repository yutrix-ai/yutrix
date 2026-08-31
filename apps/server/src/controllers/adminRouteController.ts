import { FastifyRequest, FastifyReply } from "fastify";
import { db } from "../db";
import {
  subdomains,
  endpoints,
  endpointRoutes,
  providers,
  providerModels,
  promptPolicies,
  userGroups,
  routeAuthorizations,
} from "../db/schema";
import { eq, and } from "drizzle-orm";
import crypto from "crypto";
import { logAction } from "../utils/actionLogger";
import { validateRouteConfig } from "../utils/routeValidator";
import {
  findActiveSchedule,
  safeParseSchedules,
  getDailyStartTime,
} from "../utils/scheduleEvaluator";
import {
  saveRouteAuthorizations,
  getRouteAuthorizations,
  findOrCreateRouteSubdomain,
  cleanupUnusedRouteSubdomain,
} from "../services/routeService";
import { parseStrategyRoutingRules } from "../services/strategyRouting";
import { timeoutEjectAdminFields } from "../routes/gateway/timeoutEject";

export async function getAdminRoutes(request: FastifyRequest, reply: FastifyReply) {
  // Only admin can access
  const user = request.user as any;
  if (user.role !== "admin") {
    return reply.code(403).send({ error: "Forbidden" });
  }

  const allModels = await db.select().from(providerModels);
  const modelDisplayNames = new Map<string, string>();
  for (const model of allModels) {
    const key = `${model.providerId}:${model.modelId}`;
    if (!modelDisplayNames.has(key)) {
      modelDisplayNames.set(key, model.displayName);
    }
  }

  const rows = await db
    .select({
      route: endpointRoutes,
      endpoint: endpoints,
      subdomain: subdomains,
      provider: providers,
      model: providerModels,
      policy: promptPolicies,
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
    .leftJoin(promptPolicies, eq(endpointRoutes.promptPolicyId, promptPolicies.id));

  const dailyStartStr = await getDailyStartTime();
  const now = new Date();

  const result = rows.map(({ route, endpoint, subdomain, provider, model, policy }) => {
    let readiness = "ready";
    let errorMessage = undefined;
    const modelKey = `${route.providerId}:${route.modelId}`;
    const modelDisplayName =
      modelDisplayNames.get(modelKey) || (model as any)?.displayName || route.modelId;
    const modelExists = modelDisplayNames.has(modelKey) || !!model;

    if (!route.enabled) {
      readiness = "disabled";
    } else {
      if (!provider || !modelExists || !subdomain || !endpoint) {
        readiness = "incomplete";
        errorMessage = "Missing required basic configuration";
      } else if (!provider.enabled) {
        readiness = "error";
        errorMessage = "Provider is disabled";
      } else if (policy && !policy.enabled) {
        readiness = "error";
        errorMessage = "Prompt policy is disabled";
      } else if (policy && policy.protocol !== route.providerProtocol && policy.protocol !== endpoint.incomingProtocol) {
        readiness = "error";
        errorMessage = "Prompt policy protocol mismatch";
      }
    }

    const parsedSchedules = safeParseSchedules(route.schedules);
    const activeSchedule = findActiveSchedule(parsedSchedules, now, dailyStartStr);

    return {
      id: route.id,
      name: route.name || endpoint?.name || "",
      enabled: route.enabled,
      host: subdomain?.hostname || "*",
      subdomainId: route.subdomainId,
      path: endpoint?.path || "",
      endpointId: endpoint?.id || "",
      incomingProtocol: endpoint?.incomingProtocol || "openai",
      description: subdomain?.description || "",
      providerId: route.providerId,
      providerName: (provider as any)?.name || "Unknown Provider",
      providerProtocol: route.providerProtocol,
      modelId: route.modelId,
      modelName: modelDisplayName,
      promptPolicyId: route.promptPolicyId,
      promptPolicyName: policy?.name || "",
      timeoutMs: endpoint?.timeoutMs ?? 0,
      queueTimeoutMs: endpoint?.queueTimeoutMs ?? 0,
      maxBodyMb: endpoint?.maxBodyMb ?? 0,
      allowClientModel: route.allowClientModel,
      fallbackEnabled: route.fallbackEnabled,
      retryCount: route.retryCount,
      fallbackProviderId: route.fallbackProviderId,
      fallbackProviderProtocol: route.fallbackProviderProtocol,
      fallbackModelId: route.fallbackModelId,
      fallbackPromptPolicyId: route.fallbackPromptPolicyId,
      fallbackMatchTarget: route.fallbackMatchTarget,
      fallbackStrategyRoutingEnabled: route.fallbackStrategyRoutingEnabled,
      fallbackStrategyRoutingRules: parseStrategyRoutingRules(route.fallbackStrategyRoutingRules),
      strategyRoutingEnabled: route.strategyRoutingEnabled,
      strategyRoutingRules: parseStrategyRoutingRules(route.strategyRoutingRules),
      routingMode: (route as any).routingMode || "strategy",
      targets: route.targets ? (() => { try { return JSON.parse(route.targets); } catch { return null; } })() : null,
      schedules: parsedSchedules,
      isScheduleActive: !!activeSchedule,
      activeSchedule,
      ipWhitelist: route.ipWhitelist || "",
      ...timeoutEjectAdminFields(route),
      readiness,
      errorMessage,
      createdAt: route.createdAt,
      updatedAt: route.updatedAt,
    };
  });

  for (const item of result) {
    const auth = await getRouteAuthorizations(item.id);
    (item as any).authorizedUserIds = auth.userIds;
    (item as any).authorizedGroupIds = auth.groupIds;
  }

  return result;
}

export async function getAdminRouteById(request: FastifyRequest, reply: FastifyReply) {
  const user = request.user as any;
  if (user.role !== "admin") return reply.code(403).send({ error: "Forbidden" });

  const { id } = request.params as { id: string };
  const rows = await db
    .select({
      route: endpointRoutes,
      endpoint: endpoints,
      subdomain: subdomains,
      provider: providers,
      model: providerModels,
      policy: promptPolicies,
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
    .leftJoin(promptPolicies, eq(endpointRoutes.promptPolicyId, promptPolicies.id))
    .where(eq(endpointRoutes.id, id));

  if (rows.length === 0) return reply.code(404).send({ error: "Route not found" });

  const { route, endpoint, subdomain, provider, model, policy } = rows[0];
  const routeModelRows = await db
    .select()
    .from(providerModels)
    .where(
      and(
        eq(providerModels.providerId, route.providerId),
        eq(providerModels.modelId, route.modelId)
      )
    );
  const routeModelName =
    routeModelRows[0]?.displayName || (model as any)?.displayName || route.modelId;

  const auth = await getRouteAuthorizations(route.id);

  let parsedSchedules = [];
  if (route.schedules) {
    try {
      parsedSchedules = JSON.parse(route.schedules);
    } catch (e) {
      request.log.error(e, "Error parsing route schedules on detail");
    }
  }

  return {
    id: route.id,
    name: route.name || endpoint?.name || "",
    enabled: route.enabled,
    host: subdomain?.hostname || "*",
    subdomainId: route.subdomainId,
    path: endpoint?.path || "",
    endpointId: endpoint?.id || "",
    incomingProtocol: endpoint?.incomingProtocol || "openai",
    description: subdomain?.description || "",
    providerId: route.providerId,
    providerName: (provider as any)?.name || "Unknown Provider",
    providerProtocol: route.providerProtocol,
    modelId: route.modelId,
    modelName: routeModelName,
    promptPolicyId: route.promptPolicyId,
    promptPolicyName: policy?.name || "",
    timeoutMs: endpoint?.timeoutMs ?? 0,
    queueTimeoutMs: endpoint?.queueTimeoutMs ?? 0,
    maxBodyMb: endpoint?.maxBodyMb ?? 0,
    allowClientModel: route.allowClientModel,
    fallbackEnabled: route.fallbackEnabled,
    retryCount: route.retryCount,
    fallbackProviderId: route.fallbackProviderId,
    fallbackProviderProtocol: route.fallbackProviderProtocol,
    fallbackModelId: route.fallbackModelId,
    fallbackPromptPolicyId: route.fallbackPromptPolicyId,
    fallbackMatchTarget: route.fallbackMatchTarget,
    fallbackStrategyRoutingEnabled: route.fallbackStrategyRoutingEnabled,
    fallbackStrategyRoutingRules: parseStrategyRoutingRules(route.fallbackStrategyRoutingRules),
    strategyRoutingEnabled: route.strategyRoutingEnabled,
    strategyRoutingRules: parseStrategyRoutingRules(route.strategyRoutingRules),
    routingMode: (route as any).routingMode || "strategy",
    targets: route.targets ? (() => { try { return JSON.parse(route.targets); } catch { return null; } })() : null,
    schedules: parsedSchedules,
    ipWhitelist: route.ipWhitelist || "",
    ...timeoutEjectAdminFields(route),
    authorizedUserIds: auth.userIds,
    authorizedGroupIds: auth.groupIds,
  };
}
