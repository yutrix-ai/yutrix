import { db } from "../db";
import {
  subdomains,
  endpointRoutes,
  userGroups,
  userGroupMembers,
  routeAuthorizations,
  systemSettings,
} from "../db/schema";
import { eq, and, inArray } from "drizzle-orm";
import crypto from "crypto";
import { normalizeRouteHostKey } from "@promptgate/shared";

export async function getUserAuthorizedRouteIds(userId: string): Promise<Set<string>> {
  const userGroupsList = await db
    .select({ groupId: userGroupMembers.groupId })
    .from(userGroupMembers)
    .where(eq(userGroupMembers.userId, userId));

  const groupIds = userGroupsList.map((m: any) => m.groupId);

  const auths = await db
    .select({ routeId: routeAuthorizations.routeId })
    .from(routeAuthorizations)
    .where(
      groupIds.length > 0
        ? and(
            eq(routeAuthorizations.userId, userId)
          )
        : eq(routeAuthorizations.userId, userId)
    );

  const routeIds = new Set<string>(auths.map((a: any) => a.routeId));

  if (groupIds.length > 0) {
    const groupAuths = await db
      .select({ routeId: routeAuthorizations.routeId })
      .from(routeAuthorizations)
      .where(inArray(routeAuthorizations.groupId, groupIds));
    for (const a of groupAuths as any[]) {
      routeIds.add(a.routeId);
    }
  }

  return routeIds;
}

export async function saveRouteAuthorizations(routeId: string, userIds: string[], groupIds: string[]) {
  await db.delete(routeAuthorizations).where(eq(routeAuthorizations.routeId, routeId));

  const now = new Date();
  const inserts: any[] = [];

  for (const uid of userIds) {
    inserts.push({
      id: crypto.randomUUID(),
      routeId,
      userId: uid,
      groupId: null,
      createdAt: now,
    });
  }
  for (const gid of groupIds) {
    inserts.push({
      id: crypto.randomUUID(),
      routeId,
      userId: null,
      groupId: gid,
      createdAt: now,
    });
  }

  if (inserts.length > 0) {
    await db.insert(routeAuthorizations).values(inserts);
  }
}

export async function getRouteAuthorizations(routeId: string) {
  const auths = await db.select().from(routeAuthorizations).where(eq(routeAuthorizations.routeId, routeId));
  const userIds: string[] = [];
  const groupIds: string[] = [];
  for (const a of auths) {
    if (a.userId) userIds.push(a.userId);
    if (a.groupId) groupIds.push(a.groupId);
  }
  return { userIds, groupIds };
}

export async function resolveRouteHost(hostInput: string) {
  const trimmed = String(hostInput ?? "").trim();
  if (trimmed === "*" || trimmed.toLowerCase() === "all") {
    return { subdomainId: null, hostname: "*", shortName: "*" };
  }

  const settings = await db
    .select()
    .from(systemSettings)
    .where(eq(systemSettings.key, "mainDomain"));
  const mainDomain = settings.length > 0 ? settings[0].value : "";

  if (!trimmed.includes(".") && !mainDomain && process.env.NODE_ENV === "production") {
    throw new Error("请先在系统设置中配置主域名，或填写完整 Host。");
  }

  const hostname = normalizeRouteHostKey(trimmed, mainDomain || "", {
    fallbackLocalhost: process.env.NODE_ENV !== "production",
  });
  const shortName = hostname.split(".")[0];

  return { subdomainId: undefined, hostname, shortName };
}

function isUniqueConstraintError(err: unknown): boolean {
  const rec = err as { code?: string; message?: string; cause?: { message?: string } } | null;
  const message = `${rec?.message || ""} ${rec?.cause?.message || ""}`;
  return (
    rec?.code === "SQLITE_CONSTRAINT" ||
    rec?.code === "SQLITE_CONSTRAINT_UNIQUE" ||
    message.includes("UNIQUE")
  );
}

async function subdomainByHostname(hostname: string) {
  const rows = await db.select().from(subdomains).where(eq(subdomains.hostname, hostname));
  return rows[0] ?? null;
}

/**
 * Bind a route to a Host. Hostname is the identity key.
 * Reuses an existing subdomain row when that hostname already exists;
 * otherwise inserts a new row. Never rewrites hostname on a shared row.
 */
export async function findOrCreateRouteSubdomain(input: {
  hostInput: string;
  userId: string;
  description?: string;
}) {
  const resolved = await resolveRouteHost(input.hostInput);
  if (resolved.subdomainId === null) {
    return { subdomainId: null, hostname: "*" };
  }

  const existing = await subdomainByHostname(resolved.hostname);
  if (existing) {
    if (input.description !== undefined) {
      await db
        .update(subdomains)
        .set({ description: input.description, updatedAt: new Date() })
        .where(eq(subdomains.id, existing.id));
    }
    return { subdomainId: existing.id, hostname: existing.hostname };
  }

  const subdomainId = crypto.randomUUID();
  try {
    await db.insert(subdomains).values({
      id: subdomainId,
      userId: input.userId,
      name: resolved.shortName,
      hostname: resolved.hostname,
      enabled: true,
      description: input.description || "",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return { subdomainId, hostname: resolved.hostname };
  } catch (err) {
    if (!isUniqueConstraintError(err)) throw err;
    const raced = await subdomainByHostname(resolved.hostname);
    if (raced) {
      return { subdomainId: raced.id, hostname: raced.hostname };
    }
    throw new Error(`Host ${resolved.hostname} 已被其他二级域名使用。`);
  }
}

export async function cleanupUnusedRouteSubdomain(subdomainId: string | null) {
  if (!subdomainId) return;

  const remainingRoutes = await db
    .select({ id: endpointRoutes.id })
    .from(endpointRoutes)
    .where(eq(endpointRoutes.subdomainId, subdomainId));

  if (remainingRoutes.length === 0) {
    await db.delete(subdomains).where(eq(subdomains.id, subdomainId));
  }
}
