import crypto from "crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { eq, and, inArray } from "drizzle-orm";
import { db } from "../../db";
import {
  users,
  userGroupMembers,
  routeAuthorizations,
  userRouteOverrides,
  providerModels,
} from "../../db/schema";
import { logAction } from "../../utils/actionLogger";
import { formatError } from "../../utils/gatewayError";
import { getClientIp, isClientIpAllowed, isUnrestrictedIpAcl } from "../../utils/ipAcl";
import type {
  AuthContext,
  RoutingContext,
  BaseActionLog,
  AttemptState,
} from "./types";
import {
  coerceClassicTargetFromLegacy,
  isClassicRoutingMode,
} from "../../services/opcAgentRouting";

/**
 * Look up the user record and check whether they are authorized to access the
 * given route.  Returns `{ username, userRole }` on success, or `null` if the
 * request was already rejected (reply sent with 403).
 */
export async function checkRouteAuthorization(
  userId: string,
  apiKeyRecord: any,
  route: any,
  incomingProtocol: string,
  reply: FastifyReply,
  request: FastifyRequest,
): Promise<{ username?: string; userRole: string; clientIp: string } | null> {
  const userList = await db.select().from(users).where(eq(users.id, userId));
  const username = userList.length > 0 ? userList[0].username : undefined;
  const userRole = userList.length > 0 ? userList[0].role : "user";
  const clientIp = getClientIp(request);

  if (!isUnrestrictedIpAcl(route.ipWhitelist) && !isClientIpAllowed(clientIp, route.ipWhitelist)) {
    logAction({
      level: "WARN",
      code: "request.ip_forbidden",
      ip: clientIp || "-",
      routeId: route.id,
      routeName: route.name || "",
      path: request.url.split("?")[0],
      host: request.hostname,
      username,
      message: `客户端 IP ${clientIp || "-"} 不在路由来源限制范围内`,
    });
    reply.code(403).send(
      formatError(
        incomingProtocol,
        403,
        "您无权访问该路由",
        "permission_denied",
      ),
    );
    return null;
  }

  if (userRole !== "admin" && apiKeyRecord.id !== "system") {
    const userGroupList = await db
      .select({ groupId: userGroupMembers.groupId })
      .from(userGroupMembers)
      .where(eq(userGroupMembers.userId, userId));
    const groupIds = userGroupList.map((m) => m.groupId);

    let isAuthorized = false;
    const directAuth = await db
      .select({ id: routeAuthorizations.id })
      .from(routeAuthorizations)
      .where(
        and(
          eq(routeAuthorizations.routeId, route.id),
          eq(routeAuthorizations.userId, userId)
        )
      );
    if (directAuth.length > 0) isAuthorized = true;

    if (!isAuthorized && groupIds.length > 0) {
      const groupAuth = await db
        .select({ id: routeAuthorizations.id })
        .from(routeAuthorizations)
        .where(
          and(
            eq(routeAuthorizations.routeId, route.id),
            inArray(routeAuthorizations.groupId, groupIds)
          )
        );
      if (groupAuth.length > 0) isAuthorized = true;
    }

    if (!isAuthorized) {
      reply
        .code(403)
        .send(
          formatError(
            incomingProtocol,
            403,
            "您无权访问该路由",
            "permission_denied"
          ),
        );
      return null;
    }
  }

  return { username, userRole, clientIp };
}

/**
 * Build the base action-log object that is threaded through the entire
 * request lifecycle.
 */
export function createBaseActionLog(
  auth: AuthContext,
  routing: RoutingContext,
  requestHostname: string,
  username?: string,
  clientIp?: string,
): BaseActionLog {
  return {
    requestId: crypto.randomUUID(),
    userId: auth.userId,
    username,
    apiKeyPrefix:
      auth.apiKeyRecord.keyPrefix ||
      auth.apiKeyRecord.id.substring(0, 8),
    host: requestHostname,
    path: routing.reqPath,
    routeName: routing.route.name || routing.endpoint.name,
    ip: clientIp || "-",
  };
}

/**
 * Create the initial attempt state from the resolved route.
 */
export function createInitialAttemptState(route: any): AttemptState {
  let firstTarget = {
    providerId: route.providerId,
    providerProtocol: route.providerProtocol,
    modelId: route.modelId,
    promptPolicyId: route.promptPolicyId,
  };

  if (route.targets) {
    try {
      const parsedTargets = typeof route.targets === 'string' ? JSON.parse(route.targets) : route.targets;
      if (Array.isArray(parsedTargets) && parsedTargets.length > 0) {
        firstTarget = isClassicRoutingMode(route)
          ? coerceClassicTargetFromLegacy(parsedTargets[0])
          : parsedTargets[0];
      }
    } catch (e) {
      // Ignored
    }
  }

  return {
    providerId: firstTarget.providerId,
    providerProtocol: firstTarget.providerProtocol,
    modelId: firstTarget.modelId || "",
    promptPolicyId: firstTarget.promptPolicyId || null,
    isFallback: false,
    fallbackReason: "",
    targetIndex: 0,
  };
}

/**
 * If the route allows client-chosen models (`allowClientModel`), look up the
 * user's route override and apply it:
 * - **Client Override** (`useClientModel`): match `clientModelId` (request body
 *   model) against L0 strategy/base models; miss → General. Disables content
 *   strategy for this request so the match is final.
 * - **Fixed model** (`modelId`): force that model and disable strategy.
 * - **Custom strategy rules**: replace route strategy rules (no fixed model).
 *
 * Fixed modelId and Client Override are mutually exclusive at persistence;
 * if both appear, Client Override wins only when modelId is empty.
 */
export async function resolveUserRouteOverride(
  userId: string,
  route: any,
  currentAttempt: AttemptState,
  baseActionLog: BaseActionLog,
  clientModelId?: string | null,
): Promise<void> {
  if (!route.allowClientModel) return;

  const overrideList = await db.select().from(userRouteOverrides).where(
    and(eq(userRouteOverrides.userId, userId), eq(userRouteOverrides.routeId, route.id))
  );
  if (overrideList.length === 0) return;

  const override = overrideList[0] as typeof overrideList[0] & {
    useClientModel?: boolean;
  };

  // Client Override: match request model against L0 (exclusive with fixed modelId)
  if (override.useClientModel && !override.modelId) {
    const { applyClientModelOverrideToAttempt } = await import(
      "../../services/clientModelOverride"
    );
    const resolved = applyClientModelOverrideToAttempt({
      route,
      clientModelId,
      currentAttempt,
    });
    logAction({
      ...baseActionLog,
      level: "INFO",
      code: "request.client_model_override",
      clientModelId: clientModelId || "",
      matched: resolved.matched,
      source: resolved.source,
      modelId: resolved.modelId,
      providerId: resolved.providerId,
    });
    return;
  }

  if (override.strategyRoutingRules) {
    route.strategyRoutingRules = override.strategyRoutingRules;
  }

  if (override.modelId) {
    const validModel = await db.select().from(providerModels).where(
      and(
        eq(providerModels.providerId, route.providerId),
        eq(providerModels.modelId, override.modelId)
      )
    );
    if (validModel.length > 0) {
      currentAttempt.modelId = override.modelId;
      // Disable strategy routing if a fixed model is chosen
      route.strategyRoutingEnabled = false;
      // Also disable on L0 target so funnel target strategy cannot re-enable
      if (route.targets) {
        try {
          const parsed =
            typeof route.targets === "string"
              ? JSON.parse(route.targets)
              : route.targets;
          if (Array.isArray(parsed) && parsed[0] && typeof parsed[0] === "object") {
            parsed[0] = { ...parsed[0], strategyRoutingEnabled: false };
            route.targets =
              typeof route.targets === "string"
                ? JSON.stringify(parsed)
                : parsed;
          }
        } catch {
          // ignore
        }
      }
    } else {
      logAction({
        ...baseActionLog,
        level: "INFO",
        code: "request.override_ignored",
        overrideModelId: override.modelId,
      });
    }
  }
}
