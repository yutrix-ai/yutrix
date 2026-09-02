import { db } from "../../db";
import { distillationSignalVersions } from "../../db/schema";
import { desc, eq } from "drizzle-orm";
import type { BoundaryRule, WeightOverrides } from "./routingMerger";

export type ActiveRoutingOverlay = {
  versionId: string;
  versionLabel: string;
  weightOverrides: WeightOverrides;
  boundaryRules: BoundaryRule[];
};

let cachedOverlay: ActiveRoutingOverlay | null = null;
let cacheAt = 0;
const CACHE_TTL_MS = 5000;

export function clearRoutingOverlayCache(): void {
  cachedOverlay = null;
  cacheAt = 0;
}

export async function getActiveRoutingOverlay(): Promise<ActiveRoutingOverlay | null> {
  const now = Date.now();
  if (cachedOverlay && now - cacheAt < CACHE_TTL_MS) {
    return cachedOverlay;
  }
  const rows = await db
    .select()
    .from(distillationSignalVersions)
    .where(eq(distillationSignalVersions.isActive, true))
    .orderBy(desc(distillationSignalVersions.createdAt))
    .limit(1);
  if (rows.length === 0) {
    cachedOverlay = null;
    cacheAt = now;
    return null;
  }
  const row = rows[0];
  cachedOverlay = {
    versionId: row.id,
    versionLabel: row.versionLabel,
    weightOverrides: JSON.parse(row.weightOverrides) as WeightOverrides,
    boundaryRules: JSON.parse(row.boundaryRules) as BoundaryRule[],
  };
  cacheAt = now;
  return cachedOverlay;
}

export function applyWeightOverlay(
  base: Record<string, number>,
  taskType: string,
  overrides: WeightOverrides,
): Record<string, number> {
  const taskOverrides = overrides[taskType];
  if (!taskOverrides) return base;
  const merged = { ...base };
  for (const [token, delta] of Object.entries(taskOverrides)) {
    merged[token] = (merged[token] ?? 0) + delta;
  }
  return merged;
}
