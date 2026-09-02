import type { DistillationRecordOutput } from "@promptgate/shared";

export type WeightOverrides = Record<string, Record<string, number>>;

export type BoundaryRule = {
  id: string;
  taskType: string;
  pattern: string;
  reason: string;
};

export function mergeRoutingAdjustments(
  proposals: DistillationRecordOutput["routing"][],
): { weightOverrides: WeightOverrides; boundaryRules: BoundaryRule[] } {
  const weightOverrides: WeightOverrides = {
    debug: {},
    code: {},
    writing: {},
  };
  const boundaryRules: BoundaryRule[] = [];
  const seenBoundary = new Set<string>();

  for (const p of proposals) {
    if (p.action === "confirm" || p.action === "ambiguous") continue;
    for (const adj of p.adjustments) {
      if (adj.type === "weight_delta" && adj.token && adj.delta) {
        const bucket = weightOverrides[adj.taskType] ?? {};
        bucket[adj.token] = (bucket[adj.token] ?? 0) + adj.delta;
        weightOverrides[adj.taskType] = bucket;
      }
      if (
        (adj.type === "boundary_rule" || p.action === "boundary_rule") &&
        adj.pattern
      ) {
        const key = `${adj.taskType}:${adj.pattern}`;
        if (!seenBoundary.has(key)) {
          seenBoundary.add(key);
          boundaryRules.push({
            id: adj.ruleId ?? `flywheel-${boundaryRules.length + 1}`,
            taskType: adj.taskType,
            pattern: adj.pattern,
            reason: adj.reason,
          });
        }
      }
    }
  }
  return { weightOverrides, boundaryRules };
}
