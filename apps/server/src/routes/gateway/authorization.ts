import crypto from "crypto";
import type { FastifyReply } from "fastify";
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
import type {
  AuthContext,
  RoutingContext,
  BaseActionLog,
  AttemptState,
} from "./types";

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
): Promise<{ username?: string; userRole: string } | null> {
  const userList = await db.select().from(users).where(eq(users.id, userId));
  const username = userList.length > 0 ? userList[0].username : undefined;
  const userRole = userList.length > 0 ? userList[0].role : "user";

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

  return { username, userRole };
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
        firstTarget = parsedTargets[0];
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
 * user's route override and – when the override model is valid for the
 * route's provider – mutate `currentAttempt.modelId`.
 */
export async function resolveUserRouteOverride(
  userId: string,
  route: any,
  currentAttempt: AttemptState,
  baseActionLog: BaseActionLog,
): Promise<void> {
  // Trigger restart for db schema changes
  if (route.allowClientModel) {
    const overrideList = await db.select().from(userRouteOverrides).where(
      and(eq(userRouteOverrides.userId, userId), eq(userRouteOverrides.routeId, route.id))
    );
    if (overrideList.length > 0) {
      const override = overrideList[0];

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
  }
}
