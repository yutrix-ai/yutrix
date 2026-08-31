import { FastifyRequest, FastifyReply } from "fastify";
import { db } from "../db";
import {
  subdomains,
  endpoints,
  endpointRoutes,
  providers,
  userGroups,
  routeAuthorizations,
} from "../db/schema";
import { eq, and } from "drizzle-orm";
import crypto from "crypto";
import { logAction } from "../utils/actionLogger";
import { validateRouteConfig } from "../utils/routeValidator";
import {
  saveRouteAuthorizations,
  findOrCreateRouteSubdomain,
  cleanupUnusedRouteSubdomain,
} from "../services/routeService";
import { stringifyStrategyRoutingRules } from "../services/strategyRouting";
import { normalizeIpAclForStorage } from "../utils/ipAcl";
import { assertRouteIdentityAvailable } from "../services/routeIdentityGuard";
import { DEFAULT_PROVIDER_TIMEOUT_MS, trimRouteName } from "@promptgate/shared";

export async function createAdminRoute(request: FastifyRequest, reply: FastifyReply) {
  const user = request.user as any;
  if (user.role !== "admin") return reply.code(403).send({ error: "Forbidden" });

  const body = request.body as any;
  const {
    name,
    hostInput: rawHostInput,
    path,
    incomingProtocol,
    description,
    timeoutMs,
    queueTimeoutMs,
    maxBodyMb,
    enabled,
    allowClientModel,
    retryCount,
    authorizedUserIds,
    authorizedGroupIds,
    schedules,
    targets,
    routingMode,
    ipWhitelist: rawIpWhitelist,
    timeoutEjectEnabled,
  } = body;
  const hostInput = rawHostInput ?? body.host;
  const resolvedRoutingMode = routingMode === "opc_agent" ? "opc_agent" : "strategy";

  if (!hostInput || !path || !incomingProtocol || !targets || targets.length === 0) {
    return reply.code(400).send({ error: "缺少必填字段或路由目标为空" });
  }

  const routeName = trimRouteName(name);
  const identity = await assertRouteIdentityAvailable({
    name: routeName,
    hostInput,
    path,
    incomingProtocol,
    requireName: true,
  });
  if (!identity.ok) {
    return reply.code(400).send({ error: identity.error, code: identity.code });
  }

  let ipWhitelist: string | null = null;
  try {
    ipWhitelist = normalizeIpAclForStorage(rawIpWhitelist);
  } catch (e: any) {
    return reply.code(400).send({ error: e.message || "来源限制格式无效" });
  }

  const validationResult = await validateRouteConfig({
    incomingProtocol,
    enabled: enabled !== undefined ? enabled : true,
    retryCount: retryCount !== undefined ? retryCount : 3,
    targets
  });
  if (!validationResult.ok) {
    return reply.code(400).send({ error: validationResult.error });
  }

  const resolvedTargets = validationResult.resolvedTargets!;
  const firstTarget = resolvedTargets[0];

  // Resolve host
  let subdomainId = null;
  let routeHost = hostInput === "*" ? "*" : hostInput;
  if (hostInput !== "*") {
    try {
      const resolvedHost = await findOrCreateRouteSubdomain({
        hostInput,
        userId: user.id,
        description: description || "",
      });
      subdomainId = resolvedHost.subdomainId;
      routeHost = resolvedHost.hostname;
    } catch (e: any) {
      return reply.code(400).send({ error: e.message });
    }
  }

  // Find or create endpoint
  let ep = await db.select().from(endpoints).where(
    and(
      eq(endpoints.path, path),
      eq(endpoints.incomingProtocol, incomingProtocol)
    )
  );
  let endpointId;
  if (ep.length > 0) {
    endpointId = ep[0].id;
    await db.update(endpoints).set({
      timeoutMs: timeoutMs !== undefined ? timeoutMs : ep[0].timeoutMs,
      queueTimeoutMs: queueTimeoutMs !== undefined ? queueTimeoutMs : ep[0].queueTimeoutMs,
      maxBodyMb: maxBodyMb !== undefined ? maxBodyMb : ep[0].maxBodyMb,
      updatedAt: new Date()
    }).where(eq(endpoints.id, endpointId));
  } else {
    endpointId = crypto.randomUUID();
    await db.insert(endpoints).values({
      id: endpointId,
      userId: user.id,
      name: routeName,
      path: path,
      incomingProtocol: incomingProtocol,
      enabled: true,
      timeoutMs: timeoutMs !== undefined ? timeoutMs : DEFAULT_PROVIDER_TIMEOUT_MS,
      queueTimeoutMs: queueTimeoutMs !== undefined ? queueTimeoutMs : 0,
      maxBodyMb: maxBodyMb !== undefined ? maxBodyMb : 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  // Create route
  const routeId = crypto.randomUUID();
  await db.insert(endpointRoutes).values({
    id: routeId,
    name: routeName,
    endpointId,
    subdomainId,
    providerId: firstTarget.providerId,
    providerProtocol: firstTarget.providerProtocol,
    modelId: firstTarget.modelId || "",
    promptPolicyId: firstTarget.promptPolicyId || null,
    enabled: enabled !== undefined ? enabled : true,
    allowClientModel: allowClientModel || false,
    schedules: schedules ? JSON.stringify(schedules) : null,
    targets: JSON.stringify(resolvedTargets),
    routingMode: resolvedRoutingMode,
    retryCount: retryCount !== undefined ? retryCount : 3,
    ipWhitelist,
    timeoutEjectEnabled: !!timeoutEjectEnabled,
    weight: 1,
    priority: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const primaryProvider = await db
    .select({ name: providers.name })
    .from(providers)
    .where(eq(providers.id, firstTarget.providerId));

  logAction({
    level: "信息",
    action: "路由创建",
    username: user.username,
    routeId,
    routeName,
    host: routeHost,
    path,
    incomingProtocol,
    providerName: primaryProvider[0]?.name || firstTarget.providerId,
    modelId: firstTarget.modelId,
    fallbackEnabled: resolvedTargets.length > 1,
    retryCount: retryCount !== undefined ? retryCount : 3,
  });

  let finalUserIds: string[] = authorizedUserIds || [];
  let finalGroupIds: string[] = authorizedGroupIds || [];
  if (finalUserIds.length === 0 && finalGroupIds.length === 0) {
    const defaultGroups = await db.select().from(userGroups).where(eq(userGroups.isDefault, true));
    if (defaultGroups.length > 0) {
      finalGroupIds = [defaultGroups[0].id];
    }
  }
  await saveRouteAuthorizations(routeId, finalUserIds, finalGroupIds);

  return reply.code(201).send({ id: routeId, success: true });
}

export async function updateAdminRoute(request: FastifyRequest, reply: FastifyReply) {
  const user = request.user as any;
  if (user.role !== "admin") return reply.code(403).send({ error: "Forbidden" });

  const { id } = request.params as { id: string };
  const body = request.body as any;

  const routes = await db.select().from(endpointRoutes).where(eq(endpointRoutes.id, id));
  if (routes.length === 0) return reply.code(404).send({ error: "Route not found" });
  const route = routes[0];

  const eps = await db.select().from(endpoints).where(eq(endpoints.id, route.endpointId));
  const endpoint = eps[0];

  let subdomainsList: any[] = [];
  if (route.subdomainId) {
    subdomainsList = await db.select().from(subdomains).where(eq(subdomains.id, route.subdomainId));
  }
  const subdomain = subdomainsList.length > 0 ? subdomainsList[0] : null;

  const patchIncomingProtocol = (body.incomingProtocol !== undefined ? body.incomingProtocol : endpoint.incomingProtocol) || "openai";
  const patchEnabled = body.enabled !== undefined ? body.enabled : route.enabled;
  const patchAllowClientModel = body.allowClientModel !== undefined ? body.allowClientModel : route.allowClientModel;
  const patchRetryCount = body.retryCount !== undefined ? body.retryCount : route.retryCount;

  let patchIpWhitelist = route.ipWhitelist ?? null;
  if (body.ipWhitelist !== undefined) {
    try {
      patchIpWhitelist = normalizeIpAclForStorage(body.ipWhitelist);
    } catch (e: any) {
      return reply.code(400).send({ error: e.message || "来源限制格式无效" });
    }
  }

  // Backwards compatibility for targets: if body.targets missing, try to parse from existing or legacy
  let targets = body.targets;
  if (!targets) {
    if (route.targets) {
      targets = JSON.parse(route.targets);
    } else {
      targets = [{
        providerId: route.providerId,
        modelId: route.modelId,
        bestEffort: false,
        promptPolicyId: route.promptPolicyId
      }];
    }
  }

  const validationResult = await validateRouteConfig({
    incomingProtocol: patchIncomingProtocol,
    enabled: patchEnabled,
    retryCount: patchRetryCount,
    targets: targets
  });

  if (!validationResult.ok) {
    return reply.code(400).send({ error: validationResult.error });
  }
  const resolvedTargets = validationResult.resolvedTargets!;
  const firstTarget = resolvedTargets[0];

  let finalSubdomainId = route.subdomainId;
  const currentHostname = subdomain ? subdomain.hostname : "*";
  const requestedHostInput = body.hostInput ?? body.host;
  const nextHostInput =
    requestedHostInput !== undefined && requestedHostInput !== ""
      ? requestedHostInput
      : currentHostname;
  const nextPath = body.path !== undefined ? body.path : endpoint.path;
  const nameProvided = body.name !== undefined;
  const nextName = nameProvided ? trimRouteName(body.name) : route.name || "";
  const identity = await assertRouteIdentityAvailable({
    name: nextName,
    hostInput: nextHostInput,
    path: nextPath,
    incomingProtocol: patchIncomingProtocol,
    excludeRouteId: id,
    requireName: nameProvided,
  });
  if (!identity.ok) {
    return reply.code(400).send({ error: identity.error, code: identity.code });
  }

  if (requestedHostInput && requestedHostInput !== currentHostname) {
    if (requestedHostInput === "*") {
      finalSubdomainId = null;
    } else {
      try {
        const resolvedHost = await findOrCreateRouteSubdomain({
          hostInput: requestedHostInput,
          userId: user.id,
          description: body.description,
        });
        finalSubdomainId = resolvedHost.subdomainId;
      } catch (e: any) {
        return reply.code(400).send({ error: e.message });
      }
    }
  } else if (subdomain && body.description !== undefined) {
    await db.update(subdomains).set({ description: body.description, updatedAt: new Date() }).where(eq(subdomains.id, subdomain.id));
  }

  let finalEndpointId = route.endpointId;
  const pathChanged = body.path !== undefined && body.path !== endpoint.path;
  const protocolChanged = body.incomingProtocol !== undefined && body.incomingProtocol !== endpoint.incomingProtocol;

  if (pathChanged || protocolChanged) {
    const newPath = body.path !== undefined ? body.path : endpoint.path;
    const newProto = body.incomingProtocol !== undefined ? body.incomingProtocol : endpoint.incomingProtocol;

    let ep = await db.select().from(endpoints).where(
      and(
        eq(endpoints.path, newPath),
        eq(endpoints.incomingProtocol, newProto)
      )
    );
    if (ep.length > 0) {
      finalEndpointId = ep[0].id;
      await db.update(endpoints).set({
        timeoutMs: body.timeoutMs !== undefined ? body.timeoutMs : ep[0].timeoutMs,
        queueTimeoutMs: body.queueTimeoutMs !== undefined ? body.queueTimeoutMs : ep[0].queueTimeoutMs,
        maxBodyMb: body.maxBodyMb !== undefined ? body.maxBodyMb : ep[0].maxBodyMb,
        updatedAt: new Date()
      }).where(eq(endpoints.id, finalEndpointId));
    } else {
      finalEndpointId = crypto.randomUUID();
      await db.insert(endpoints).values({
        id: finalEndpointId,
        userId: user.id,
        name: endpoint.name,
        path: newPath,
        incomingProtocol: newProto,
        enabled: true,
        timeoutMs: body.timeoutMs !== undefined ? body.timeoutMs : endpoint.timeoutMs,
        queueTimeoutMs: body.queueTimeoutMs !== undefined ? body.queueTimeoutMs : endpoint.queueTimeoutMs,
        maxBodyMb: body.maxBodyMb !== undefined ? body.maxBodyMb : endpoint.maxBodyMb,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }
  } else {
    // Just update existing endpoint
    await db.update(endpoints).set({
      timeoutMs: body.timeoutMs !== undefined ? body.timeoutMs : endpoint.timeoutMs,
      queueTimeoutMs: body.queueTimeoutMs !== undefined ? body.queueTimeoutMs : endpoint.queueTimeoutMs,
      maxBodyMb: body.maxBodyMb !== undefined ? body.maxBodyMb : endpoint.maxBodyMb,
      updatedAt: new Date()
    }).where(eq(endpoints.id, endpoint.id));
  }

  await db.update(endpointRoutes).set({
    name: nameProvided ? nextName : route.name,
    endpointId: finalEndpointId,
    subdomainId: finalSubdomainId,
    providerId: firstTarget.providerId,
    providerProtocol: firstTarget.providerProtocol,
    modelId: firstTarget.modelId || "",
    promptPolicyId: firstTarget.promptPolicyId || null,
    enabled: body.enabled !== undefined ? body.enabled : route.enabled,
    allowClientModel: patchAllowClientModel,
    schedules: body.schedules !== undefined ? (body.schedules ? JSON.stringify(body.schedules) : null) : route.schedules,
    retryCount: patchRetryCount,
    targets: JSON.stringify(resolvedTargets),
    routingMode: body.routingMode !== undefined
      ? (body.routingMode === "opc_agent" ? "opc_agent" : "strategy")
      : ((route as any).routingMode || "strategy"),
    ipWhitelist: patchIpWhitelist,
    timeoutEjectEnabled: body.timeoutEjectEnabled !== undefined ? !!body.timeoutEjectEnabled : route.timeoutEjectEnabled,
    status: body.status !== undefined ? body.status : (body.enabled ? "active" : route.status),
    updatedAt: new Date()
  }).where(eq(endpointRoutes.id, id));

  if (route.subdomainId && route.subdomainId !== finalSubdomainId) {
    await cleanupUnusedRouteSubdomain(route.subdomainId);
  }

  const updatedProvider = await db
    .select({ name: providers.name })
    .from(providers)
    .where(eq(providers.id, firstTarget.providerId));
  const updatedEndpoint = pathChanged || protocolChanged
    ? await db.select().from(endpoints).where(eq(endpoints.id, finalEndpointId))
    : [endpoint];
  const updatedSubdomain = finalSubdomainId
    ? await db.select().from(subdomains).where(eq(subdomains.id, finalSubdomainId))
    : [];

  logAction({
    level: "信息",
    action: "路由更新",
    username: user.username,
    routeId: id,
    routeName: nameProvided ? nextName : (route.name || endpoint.name || ""),
    host: updatedSubdomain[0]?.hostname || "*",
    path: updatedEndpoint[0]?.path || endpoint.path,
    incomingProtocol: updatedEndpoint[0]?.incomingProtocol || endpoint.incomingProtocol,
    providerName: updatedProvider[0]?.name || firstTarget.providerId,
    modelId: firstTarget.modelId,
    fallbackEnabled: resolvedTargets.length > 1,
    retryCount: patchRetryCount,
  });

  if (body.authorizedUserIds !== undefined || body.authorizedGroupIds !== undefined) {
    let finalUserIds: string[] = body.authorizedUserIds || [];
    let finalGroupIds: string[] = body.authorizedGroupIds || [];
    if (finalUserIds.length === 0 && finalGroupIds.length === 0) {
      const defaultGroups = await db.select().from(userGroups).where(eq(userGroups.isDefault, true));
      if (defaultGroups.length > 0) {
        finalGroupIds = [defaultGroups[0].id];
      }
    }
    await saveRouteAuthorizations(id, finalUserIds, finalGroupIds);
  }

  return { success: true };
}

export async function deleteAdminRoute(request: FastifyRequest, reply: FastifyReply) {
  const user = request.user as any;
  if (user.role !== "admin") return reply.code(403).send({ error: "Forbidden" });

  const { id } = request.params as { id: string };

  const existing = await db
    .select({
      name: endpointRoutes.name,
      endpointId: endpointRoutes.endpointId,
      providerId: endpointRoutes.providerId,
      modelId: endpointRoutes.modelId,
      fallbackEnabled: endpointRoutes.fallbackEnabled,
      retryCount: endpointRoutes.retryCount,
      subdomainId: endpointRoutes.subdomainId,
    })
    .from(endpointRoutes)
    .where(eq(endpointRoutes.id, id));
  if (existing.length > 0) {
    const eps = await db.select().from(endpoints).where(eq(endpoints.id, existing[0].endpointId));
    const provs = await db.select({ name: providers.name }).from(providers).where(eq(providers.id, existing[0].providerId));
    const subs = existing[0].subdomainId
      ? await db.select({ hostname: subdomains.hostname }).from(subdomains).where(eq(subdomains.id, existing[0].subdomainId))
      : [];
    logAction({
      level: "警告",
      action: "路由删除",
      username: user.username,
      routeName: existing[0].name || (eps.length > 0 ? (eps[0].name || "未知路由") : "未知路由"),
      routeId: id,
      host: subs[0]?.hostname || "*",
      path: eps[0]?.path,
      incomingProtocol: eps[0]?.incomingProtocol,
      providerName: provs[0]?.name || existing[0].providerId,
      modelId: existing[0].modelId,
      fallbackEnabled: existing[0].fallbackEnabled,
      retryCount: existing[0].retryCount,
    });
  }

  await db.delete(routeAuthorizations).where(eq(routeAuthorizations.routeId, id));
  await db.delete(endpointRoutes).where(eq(endpointRoutes.id, id));
  if (existing.length > 0) {
    await cleanupUnusedRouteSubdomain(existing[0].subdomainId);
  }

  return { success: true };
}
