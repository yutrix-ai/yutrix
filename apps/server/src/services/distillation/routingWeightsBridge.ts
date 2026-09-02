import {
  applyWeightOverlay,
  getActiveRoutingOverlay,
  type ActiveRoutingOverlay,
} from "./routingOverlay";
import type { WeightOverrides } from "./routingMerger";

let cachedSnapshot: WeightOverrides | null = null;

export function applyRoutingWeightOverlay(
  taskType: string,
  base: Record<string, number>,
): Record<string, number> {
  if (!cachedSnapshot) return base;
  return applyWeightOverlay(base, taskType, cachedSnapshot);
}

export async function refreshRoutingWeightSnapshot(): Promise<ActiveRoutingOverlay | null> {
  const overlay = await getActiveRoutingOverlay();
  cachedSnapshot = overlay?.weightOverrides ?? null;
  return overlay;
}

export function setRoutingWeightSnapshotForTests(
  overrides: WeightOverrides | null,
): void {
  cachedSnapshot = overrides;
}
