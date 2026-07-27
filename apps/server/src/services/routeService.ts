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
  if (hostInput === "*") {
    return { subdomainId: null, hostname: "*", shortName: "*" };
  }

  const settings = await db
    .select()
    .from(systemSettings)
    .where(eq(systemSettings.key, "mainDomain"));
  const mainDomain = settings.length > 0 ? settings[0].value : "";

  let hostname = hostInput;
  let shortName = hostInput;
  if (!hostInput.includes(".")) {
    if (mainDomain) {
      hostname = `${hostInput}.${mainDomain}`;
    } else if (process.env.NODE_ENV !== "production") {
      hostname = `${hostInput}.localhost`;
    } else {
      throw new Error("请先在系统设置中配置主域名，或填写完整 Host。");
    }
  } else {
    shortName = hostInput.split(".")[0];
  }

  return { subdomainId: undefined, hostname, shortName };
}

export async function findOrCreateRouteSubdomain(input: {
  hostInput: string;
  userId: string;
  description?: string;
}) {
  const resolved = await resolveRouteHost(input.hostInput);
  if (resolved.subdomainId === null) {
    return { subdomainId: null, hostname: "*" };
  }

  const byHostname = await db
    .select()
    .from(subdomains)
    .where(eq(subdomains.hostname, resolved.hostname));
  if (byHostname.length > 0) {
    const existing = byHostname[0];
    if (input.description !== undefined) {
      await db
        .update(subdomains)
        .set({ description: input.description, updatedAt: new Date() })
        .where(eq(subdomains.id, existing.id));
    }
    return { subdomainId: existing.id, hostname: existing.hostname };
  }

  const byName = await db
    .select()
    .from(subdomains)
    .where(eq(subdomains.name, resolved.shortName));
  if (byName.length > 0) {
    const existing = byName[0];
    const hostnameOwner = await db
      .select()
      .from(subdomains)
      .where(eq(subdomains.hostname, resolved.hostname));
    if (hostnameOwner.length > 0 && hostnameOwner[0].id !== existing.id) {
      throw new Error(`Host ${resolved.hostname} 已被其他二级域名使用。`);
    }

    await db
      .update(subdomains)
      .set({
        hostname: resolved.hostname,
        description:
          input.description !== undefined ? input.description : existing.description,
        updatedAt: new Date(),
      })
      .where(eq(subdomains.id, existing.id));

    return { subdomainId: existing.id, hostname: resolved.hostname };
  }

  const subdomainId = crypto.randomUUID();
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
