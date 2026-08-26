import { db } from "../db";
import { endpoints, endpointRoutes, subdomains, systemSettings } from "../db/schema";
import { eq } from "drizzle-orm";
import {
  collectRouteIdentityIssues,
  type RouteIdentityRecord,
} from "@promptgate/shared";

export async function getMainDomainSetting(): Promise<string> {
  const settings = await db
    .select()
    .from(systemSettings)
    .where(eq(systemSettings.key, "mainDomain"));
  return settings.length > 0 ? settings[0].value || "" : "";
}

export async function loadRouteIdentityRecords(): Promise<RouteIdentityRecord[]> {
  const rows = await db
    .select({
      id: endpointRoutes.id,
      name: endpointRoutes.name,
      hostname: subdomains.hostname,
      path: endpoints.path,
      incomingProtocol: endpoints.incomingProtocol,
    })
    .from(endpointRoutes)
    .leftJoin(endpoints, eq(endpointRoutes.endpointId, endpoints.id))
    .leftJoin(subdomains, eq(endpointRoutes.subdomainId, subdomains.id));

  return rows.map((row) => ({
    id: row.id,
    name: row.name || "",
    host: row.hostname || "*",
    path: row.path || "",
    incomingProtocol: row.incomingProtocol || "openai",
  }));
}

export async function assertRouteIdentityAvailable(input: {
  name: unknown;
  hostInput: string;
  path: string;
  incomingProtocol: string;
  excludeRouteId?: string | null;
  requireName?: boolean;
}): Promise<{ ok: true } | { ok: false; error: string; code: string }> {
  const [records, mainDomain] = await Promise.all([
    loadRouteIdentityRecords(),
    getMainDomainSetting(),
  ]);
  const issues = collectRouteIdentityIssues({
    name: input.name,
    hostInput: input.hostInput,
    path: input.path,
    protocol: input.incomingProtocol,
    records,
    mainDomain,
    excludeRouteId: input.excludeRouteId,
    requireName: input.requireName,
    fallbackLocalhost: process.env.NODE_ENV !== "production",
  });
  if (issues.length === 0) return { ok: true };
  const first = issues[0];
  return { ok: false, error: first.error, code: first.code };
}
