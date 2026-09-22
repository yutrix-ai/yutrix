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

import {
  parseMainDomains,
  matchHostToDomain,
  normalizeDomain,
  parseRouteHosts,
} from "@promptgate/shared";

export interface HostSubdomainLookupResult {
  /** The matched subdomain database record, or null if matched as root/wildcard host */
  subdomainRecord: any | null;
  /** True if this host is allowed to fall back to wildcard routes */
  allowFallback: boolean;
  /** True if a matching subdomain was found but is explicitly disabled */
  disabled?: boolean;
}

/**
 * Resolves the subdomain or root host record for an incoming hostname.
 *
 * Implements a robust multi-domain resolution chain:
 * 1. Exact match in `subdomains` table (subdomains.hostname == host)
 * 2. Configured main domain root match (host in mainDomains) -> wildcard root access
 * 3. Subdomain prefix match across any configured main domain (e.g. 'api' for 'api.domain2.com')
 * 4. Unknown host fallback check (allowUnknownHostFallback == "true")
 */
export async function findSubdomainForHost(
  hostname: string,
): Promise<HostSubdomainLookupResult | null> {
  const normalizedHost = normalizeDomain(hostname);
  if (!normalizedHost) return null;

  // 1. Exact match in subdomains table
  const exactList = await db
    .select()
    .from(subdomains)
    .where(eq(subdomains.hostname, normalizedHost));

  if (exactList.length > 0) {
    const record = exactList[0];
    if (!record.enabled) {
      return { subdomainRecord: record, allowFallback: false, disabled: true };
    }
    return { subdomainRecord: record, allowFallback: false };
  }

  // 2. Fetch main domains setting
  const mainDomainSettings = await db
    .select()
    .from(systemSettings)
    .where(eq(systemSettings.key, "mainDomain"));
  const rawMainDomain =
    mainDomainSettings.length > 0 ? mainDomainSettings[0].value : "";
  const mainDomains = parseMainDomains(rawMainDomain);

  // If in dev and no mainDomain configured, fallback to localhost
  if (mainDomains.length === 0 && process.env.NODE_ENV !== "production") {
    mainDomains.push("localhost");
  }

  const match = matchHostToDomain(normalizedHost, mainDomains);

  // 3. Match configured main domain root -> wildcard routes allowed directly
  if (match.isRoot) {
    return { subdomainRecord: null, allowFallback: true };
  }

  // 4. Same prefix on another configured main domain.
  // Only when exactly one sibling exists (`api.brtel.link` can serve `api.yutrix.ai`).
  // Two rows that share the label stay isolated; the request must hit its own hostname.
  if (match.prefix) {
    const named = await db
      .select()
      .from(subdomains)
      .where(eq(subdomains.name, match.prefix));
    const siblings = named.filter((row) => {
      const host = String(row.hostname || "").trim().toLowerCase();
      return mainDomains.some((domain) => host === `${match.prefix}.${domain}`);
    });
    if (siblings.length === 1) {
      const record = siblings[0];
      if (!record.enabled) {
        return { subdomainRecord: record, allowFallback: false, disabled: true };
      }
      return { subdomainRecord: record, allowFallback: false };
    }
  }

  // 5. Unknown host fallback check
  const fallbackSettings = await db
    .select()
    .from(systemSettings)
    .where(eq(systemSettings.key, "allowUnknownHostFallback"));
  const allowFallback =
    fallbackSettings.length > 0 && fallbackSettings[0].value === "true";

  if (allowFallback) {
    return { subdomainRecord: null, allowFallback: true };
  }

  return null;
}

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
  const result = await findSubdomainForHost(hostname);

  if (result?.disabled) {
    reply
      .code(403)
      .send(formatError(incomingProtocol, 403, "Subdomain is disabled"));
    return null;
  }

  if (!result) {
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

  return {
    subdomainRecord: result.subdomainRecord,
    allowFallback: result.allowFallback,
  };
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
  requestHostname?: string,
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
  const normHost = requestHostname ? normalizeDomain(requestHostname) : (subdomainRecord?.hostname || "");

  // Match routes against hosts or subdomainId
  const specificRoutes = routes.filter((r) => {
    if (r.hosts) {
      const hList = parseRouteHosts(r.hosts);
      if (hList.includes("*")) return false;
      return (
        (normHost && hList.includes(normHost)) ||
        (subdomainRecord && hList.includes(subdomainRecord.hostname))
      );
    }
    return subdomainRecord && r.subdomainId === subdomainRecord.id;
  });

  const wildcardRoutes = routes.filter((r) => {
    if (r.hosts) {
      return parseRouteHosts(r.hosts).includes("*");
    }
    return !r.subdomainId;
  });

  if (specificRoutes.length > 0) {
    routes = specificRoutes;
  } else {
    routes = wildcardRoutes;
  }

  const allSpecificRoutes = allRoutes.filter((r) => {
    if (r.hosts) {
      const hList = parseRouteHosts(r.hosts);
      if (hList.includes("*")) return false;
      return (
        (normHost && hList.includes(normHost)) ||
        (subdomainRecord && hList.includes(subdomainRecord.hostname))
      );
    }
    return subdomainRecord && r.subdomainId === subdomainRecord.id;
  });

  const allWildcardRoutes = allRoutes.filter((r) => {
    if (r.hosts) {
      return parseRouteHosts(r.hosts).includes("*");
    }
    return !r.subdomainId;
  });

  const matchedAllRoutes =
    allSpecificRoutes.length > 0 ? allSpecificRoutes : allWildcardRoutes;

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
