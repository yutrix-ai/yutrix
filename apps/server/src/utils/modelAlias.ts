import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { providerModels, requestLogs } from "../db/schema";

const MODEL_ALIAS_CACHE_TTL_MS = 60_000;
const modelAliasCache = new Map<string, { alias: string | null; expiresAt: number }>();

function normalizeAlias(alias: unknown): string | null {
  if (typeof alias !== "string") return null;
  const trimmed = alias.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function publicModelSql() {
  return sql<string>`COALESCE(NULLIF(${providerModels.alias}, ''), ${requestLogs.model})`;
}

export async function resolveModelAlias(
  providerId?: string | null,
  model?: string | null,
): Promise<string | null> {
  if (!providerId || !model) return null;

  const cacheKey = `${providerId}:${model}`;
  const cached = modelAliasCache.get(cacheKey);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.alias;
  }

  const rows = await db
    .select({ alias: providerModels.alias })
    .from(providerModels)
    .where(and(
      eq(providerModels.providerId, providerId),
      eq(providerModels.modelId, model),
    ))
    .limit(1);

  const alias = normalizeAlias(rows[0]?.alias);
  modelAliasCache.set(cacheKey, {
    alias,
    expiresAt: now + MODEL_ALIAS_CACHE_TTL_MS,
  });
  return alias;
}

export function clearModelAliasCache(providerId?: string | null, model?: string | null) {
  if (providerId && model) {
    modelAliasCache.delete(`${providerId}:${model}`);
    return;
  }
  modelAliasCache.clear();
}

export async function withPublicModelName<T extends Record<string, any>>(payload: T): Promise<T> {
  const next: Record<string, any> = { ...payload };
  const alias = normalizeAlias(next.alias) || await resolveModelAlias(next.providerId, next.model);
  if (alias) {
    next.model = alias;
  }
  delete next.alias;
  return next as T;
}
