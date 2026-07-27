import type { FastifyReply } from "fastify";

import { db } from "../../db";
import {
  endpoints,
  endpointRoutes,
  subdomains,
  systemSettings,
} from "../../db/schema";
import { eq, and } from "drizzle-orm";
import { formatError } from "../../utils/gatewayError";
import {
  getActiveRouteSchedule,
  resolveActiveRouteProperties,
  getDailyStartTime,
} from "../../utils/scheduleEvaluator";

/**
 * Resolves the subdomain record for the given hostname.
 *
 * Returns `{ subdomainRecord, allowFallback }` on success, or `null` if the
 * reply has already been sent (error response).
 */
export async function resolveSubdomain(
  hostname: string,
  incomingProtocol: string,
  reply: FastifyReply,
): Promise<{ subdomainRecord: any; allowFallback: boolean } | null> {
  // Subdomain matching
  const subdomainList = await db
    .select()
    .from(subdomains)
    .where(eq(subdomains.hostname, hostname));
  const subdomainRecord = subdomainList.length > 0 ? subdomainList[0] : null;

  if (
    subdomainList.length > 0 &&
    (!subdomainRecord || !subdomainRecord.enabled)
  ) {
    reply
      .code(403)
      .send(formatError(incomingProtocol, 403, "Subdomain is disabled"));
    return null;
  }

  let allowFallback = false;
  if (!subdomainRecord) {
    const settings = await db
      .select()
      .from(systemSettings)
      .where(eq(systemSettings.key, "allowUnknownHostFallback"));
    allowFallback = settings.length > 0 && settings[0].value === "true";
    if (!allowFallback) {
      reply
        .code(404)
        .send(
          formatError(
            incomingProtocol,
            404,
            "No route configured for this host/path/protocol.",
            "route_not_configured"
          ),
        );
      return null;
    }
  }

  return { subdomainRecord, allowFallback };
}

/**
 * Resolves the endpoint and best-matching route for the given request path,
 * protocol, and (optional) subdomain.
 *
 * Returns `{ endpoint, route }` on success, or `null` if the reply has
 * already been sent (error response).
 */
export async function resolveEndpointAndRoute(
  reqPath: string,
  incomingProtocol: string,
  subdomainRecord: any,
  allowFallback: boolean,
  reply: FastifyReply,
  log?: { error: (...args: any[]) => void },
): Promise<{ endpoint: any; route: any } | null> {
  // Endpoint matching (path + protocol)
  const endpointList = await db
    .select()
    .from(endpoints)
    .where(
      and(
        eq(endpoints.path, reqPath),
        eq(endpoints.incomingProtocol, incomingProtocol),
        eq(endpoints.status, "active"),
      ),
    );

  if (endpointList.length === 0) {
    reply
      .code(404)
      .send(
        formatError(
          incomingProtocol,
          404,
          "No route configured for this host/path/protocol.",
          "route_not_configured",
        ),
      );
    return null;
  }
  const endpoint = endpointList[0];

  // Optional virtualModelAlias matching if request provides a model and endpoint has one defined
  // We don't fail if body.model differs, unless we want strict routing.
  // The requirement is "不要强依赖 body.model == endpoint.targetModel"
  // So we just take the first matched route

  let allRoutes = await db
    .select()
    .from(endpointRoutes)
    .where(
      and(
        eq(endpointRoutes.endpointId, endpoint.id),
        eq(endpointRoutes.status, "active")
      ),
    );

  let routes = allRoutes.filter(r => r.enabled);

  if (subdomainRecord) {
    const subdomainRoutes = routes.filter(
      (r) => r.subdomainId === subdomainRecord.id,
    );
    if (subdomainRoutes.length > 0) {
      routes = subdomainRoutes;
    } else {
      routes = routes.filter((r) => !r.subdomainId); // fallback to wildcard
    }
  } else {
    routes = routes.filter((r) => !r.subdomainId); // only match wildcard routes
  }

  const matchedAllRoutes = subdomainRecord
    ? allRoutes.filter(r => r.subdomainId === subdomainRecord.id || !r.subdomainId)
    : allRoutes.filter(r => !r.subdomainId);

  if (routes.length === 0) {
    if (matchedAllRoutes.length > 0) {
      reply
        .code(403)
        .send(
          formatError(
            incomingProtocol,
            403,
            "路由已停用",
            "route_disabled"
          ),
        );
      return null;
    }
    reply
      .code(404)
      .send(
        formatError(
          incomingProtocol,
          404,
          "未找到匹配的路由配置",
          "route_not_configured"
        ),
      );
    return null;
  }

  routes.sort((a, b) => a.priority - b.priority);
  let route = routes[0];

  // Evaluate active schedule if configured
  if (route.schedules) {
    try {
      const dailyStartStr = await getDailyStartTime();
      const activeSchedule = getActiveRouteSchedule(route.schedules, new Date(), dailyStartStr);
      if (activeSchedule) {
        route = resolveActiveRouteProperties(route, activeSchedule);
      }
    } catch (e) {
      if (log) {
        log.error(e, "Error evaluating route schedules on gateway request");
      }
    }
  }

  return { endpoint, route };
}
