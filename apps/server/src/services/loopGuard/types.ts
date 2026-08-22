/**
 * Spec: deterministic gateway loop guard.
 * Detect only error-class continuation fingerprints (normalized).
 * Hard-stop: identical@5, ping-pong@8, 400 turns or 2h since last user_intent.
 * Never hop models, never 429/5xx, fail open on I/O.
 */

export const LOOP_GUARD_DEFAULTS = {
  identicalErrorRepeats: 5,
  pingPongHalfCycles: 8,
  continuationCeiling: 400,
  continuationMaxAgeMs: 2 * 60 * 60 * 1000,
  maxBufferedTurns: 500,
} as const;

export type LoopGuardTurnKind = "user_intent" | "continuation";

export type LoopStopReason =
  | "identical_error"
  | "ping_pong"
  | "turn_ceiling"
  | "age_ceiling";

export interface LoopGuardTurn {
  kind: LoopGuardTurnKind;
  fingerprint: string;
  isErrorClass: boolean;
  at: number;
}

export interface LoopStopDecision {
  reason: LoopStopReason;
  fingerprint?: string;
}

export interface LoopGuardSession {
  turns: LoopGuardTurn[];
  tripped?: LoopStopDecision;
}

export interface LoopGuardStore {
  get(sessionKey: string): LoopGuardSession | undefined;
  set(sessionKey: string, session: LoopGuardSession): void;
}

export interface CurrentTurnFingerprint {
  fingerprint: string;
  isErrorClass: boolean;
  payload: unknown;
  kind: LoopGuardTurnKind | "other";
}

export interface LoopGuardInspection {
  shouldStop: boolean;
  reason?: LoopStopReason;
  message?: string;
  sessionKey?: string;
  failedOpen?: boolean;
}

export interface LoopGuardConfig {
  identicalErrorRepeats: number;
  pingPongHalfCycles: number;
  continuationCeiling: number;
  continuationMaxAgeMs: number;
  maxBufferedTurns: number;
}

export interface LoopPattern {
  readonly name: LoopStopReason;
  detect(turns: LoopGuardTurn[], nowMs: number, config: LoopGuardConfig): LoopStopDecision | null;
}
