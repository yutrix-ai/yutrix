import type {
  LoopGuardConfig,
  LoopGuardTurn,
  LoopPattern,
  LoopStopDecision,
} from "./types";

function lastUserIntentIndex(turns: LoopGuardTurn[]): number {
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].kind === "user_intent") return i;
  }
  return -1;
}

function continuationsSinceIntent(turns: LoopGuardTurn[]): LoopGuardTurn[] {
  const idx = lastUserIntentIndex(turns);
  const slice = idx >= 0 ? turns.slice(idx + 1) : turns;
  return slice.filter((turn) => turn.kind === "continuation");
}

export const identicalErrorPattern: LoopPattern = {
  name: "identical_error",
  detect(turns, _nowMs, config) {
    const n = config.identicalErrorRepeats;
    if (n <= 0) return null;
    if (turns.length < n) return null;
    const window = turns.slice(-n);
    if (!window.every((turn) => turn.kind === "continuation" && turn.isErrorClass)) {
      return null;
    }
    const fingerprint = window[0].fingerprint;
    if (!fingerprint || window.some((turn) => turn.fingerprint !== fingerprint)) {
      return null;
    }
    return { reason: "identical_error", fingerprint };
  },
};

export const pingPongErrorPattern: LoopPattern = {
  name: "ping_pong",
  detect(turns, _nowMs, config) {
    const n = config.pingPongHalfCycles;
    if (n <= 1) return null;
    if (turns.length < n) return null;
    const window = turns.slice(-n);
    if (!window.every((turn) => turn.kind === "continuation" && turn.isErrorClass)) {
      return null;
    }
    const a = window[0].fingerprint;
    const b = window[1]?.fingerprint;
    if (!a || !b || a === b) return null;
    for (let i = 0; i < window.length; i++) {
      if (window[i].fingerprint !== (i % 2 === 0 ? a : b)) return null;
    }
    return { reason: "ping_pong", fingerprint: `${a}|${b}` };
  },
};

export const continuationCeilingPattern: LoopPattern = {
  name: "turn_ceiling",
  detect(turns, _nowMs, config) {
    if (config.continuationCeiling <= 0) return null;
    const cont = continuationsSinceIntent(turns);
    if (cont.length < config.continuationCeiling) return null;
    if (turns[turns.length - 1]?.kind !== "continuation") return null;
    return { reason: "turn_ceiling" };
  },
};

export const ageCeilingPattern: LoopPattern = {
  name: "age_ceiling",
  detect(turns, nowMs, config) {
    if (config.continuationMaxAgeMs <= 0) return null;
    if (turns[turns.length - 1]?.kind !== "continuation") return null;
    const intentAt = lastUserIntentIndex(turns);
    if (intentAt < 0) return null;
    const age = nowMs - turns[intentAt].at;
    if (age < config.continuationMaxAgeMs) return null;
    return { reason: "age_ceiling" };
  },
};

/** Closed hard-stop registry. Open for new patterns: append to this array. */
export const HARD_STOP_PATTERNS: LoopPattern[] = [
  identicalErrorPattern,
  pingPongErrorPattern,
  continuationCeilingPattern,
  ageCeilingPattern,
];
