import { mergeRoutingAdjustments } from "./routingMerger";
import type { DistillationRecordOutput } from "@promptgate/shared";

const MAX_WEIGHT_DELTA = 5;

export type ValidationResult = {
  ok: boolean;
  errors: string[];
  merged?: ReturnType<typeof mergeRoutingAdjustments>;
};

export function validateRoutingProposals(
  payloads: DistillationRecordOutput["routing"][],
): ValidationResult {
  const errors: string[] = [];
  const merged = mergeRoutingAdjustments(payloads);

  for (const [task, tokens] of Object.entries(merged.weightOverrides)) {
    for (const [token, delta] of Object.entries(tokens)) {
      if (Math.abs(delta) > MAX_WEIGHT_DELTA) {
        errors.push(
          `weight_delta_out_of_bounds:${task}.${token}=${delta}`,
        );
      }
    }
  }

  for (const rule of merged.boundaryRules) {
    try {
      // eslint-disable-next-line no-new
      new RegExp(rule.pattern, "i");
    } catch {
      errors.push(`invalid_boundary_regex:${rule.id}`);
    }
  }

  return { ok: errors.length === 0, errors, merged };
}
