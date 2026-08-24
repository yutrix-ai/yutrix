import { LOOP_GUARD_DEFAULTS, type LoopGuardConfig, type LoopGuardTurn, type LoopStopDecision } from "./types";
import { HARD_STOP_PATTERNS } from "./patterns";

export function detectLoopStop(
  turns: LoopGuardTurn[],
  nowMs: number,
  config: LoopGuardConfig = LOOP_GUARD_DEFAULTS,
): LoopStopDecision | null {
  if (!config.enabled) return null;
  if (!Array.isArray(turns) || turns.length === 0) return null;
  for (const pattern of HARD_STOP_PATTERNS) {
    const hit = pattern.detect(turns, nowMs, config);
    if (hit) return hit;
  }
  return null;
}
