import { LOOP_GUARD_DEFAULTS, type LoopGuardConfig } from "./types";

export const LOOP_GUARD_SETTING_KEYS = {
  enabled: "loopGuardEnabled",
  identicalErrorRepeats: "loopGuardIdenticalErrorRepeats",
  pingPongHalfCycles: "loopGuardPingPongHalfCycles",
  continuationCeiling: "loopGuardContinuationCeiling",
  continuationMaxAgeHours: "loopGuardContinuationMaxAgeHours",
} as const;

export const LOOP_GUARD_FLOORS = {
  identicalErrorRepeats: 3,
  pingPongHalfCycles: 6,
} as const;

const HOUR_MS = 60 * 60 * 1000;
export const LOOP_GUARD_DEFAULT_AGE_HOURS =
  LOOP_GUARD_DEFAULTS.continuationMaxAgeMs / HOUR_MS;

export const LOOP_GUARD_SETTING_STRING_DEFAULTS: Record<string, string> = {
  [LOOP_GUARD_SETTING_KEYS.enabled]: "true",
  [LOOP_GUARD_SETTING_KEYS.identicalErrorRepeats]: String(
    LOOP_GUARD_DEFAULTS.identicalErrorRepeats,
  ),
  [LOOP_GUARD_SETTING_KEYS.pingPongHalfCycles]: String(
    LOOP_GUARD_DEFAULTS.pingPongHalfCycles,
  ),
  [LOOP_GUARD_SETTING_KEYS.continuationCeiling]: String(
    LOOP_GUARD_DEFAULTS.continuationCeiling,
  ),
  [LOOP_GUARD_SETTING_KEYS.continuationMaxAgeHours]: String(
    LOOP_GUARD_DEFAULT_AGE_HOURS,
  ),
};

function readKey(
  map: Record<string, string | null | undefined> | undefined,
  key: string,
): string | undefined {
  if (!map) return undefined;
  const value = map[key];
  if (value === undefined || value === null) return undefined;
  const trimmed = String(value).trim();
  return trimmed === "" ? undefined : trimmed;
}

function parseEnabled(raw: string | undefined): boolean {
  if (raw === undefined) return LOOP_GUARD_DEFAULTS.enabled;
  const n = raw.toLowerCase();
  if (n === "false" || n === "0" || n === "off" || n === "no") return false;
  if (n === "true" || n === "1" || n === "on" || n === "yes") return true;
  return LOOP_GUARD_DEFAULTS.enabled;
}

function parseBoundedInt(
  raw: string | undefined,
  fallback: number,
  options: { floor?: number; allowZero?: boolean; cap?: number },
): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return fallback;
  if (options.allowZero && n === 0) return 0;
  if (n < 0) return fallback;
  let value = n;
  if (options.floor !== undefined && value < options.floor) value = options.floor;
  if (options.cap !== undefined && value > options.cap) value = options.cap;
  return value;
}

/**
 * Pure map → config. Missing/empty/illegal values become LOOP_GUARD_DEFAULTS.
 * Identical/ping-pong values below the floor are clamped up. Ceiling/age 0
 * disable that signal (must not use 0 as a trip threshold).
 */
export function resolveLoopGuardConfig(
  map?: Record<string, string | null | undefined>,
): LoopGuardConfig {
  const identical = parseBoundedInt(
    readKey(map, LOOP_GUARD_SETTING_KEYS.identicalErrorRepeats),
    LOOP_GUARD_DEFAULTS.identicalErrorRepeats,
    { floor: LOOP_GUARD_FLOORS.identicalErrorRepeats, cap: 100 },
  );
  const pingPong = parseBoundedInt(
    readKey(map, LOOP_GUARD_SETTING_KEYS.pingPongHalfCycles),
    LOOP_GUARD_DEFAULTS.pingPongHalfCycles,
    { floor: LOOP_GUARD_FLOORS.pingPongHalfCycles, cap: 100 },
  );
  const ceiling = parseBoundedInt(
    readKey(map, LOOP_GUARD_SETTING_KEYS.continuationCeiling),
    LOOP_GUARD_DEFAULTS.continuationCeiling,
    { allowZero: true, floor: 1, cap: 100_000 },
  );
  const ageHours = parseBoundedInt(
    readKey(map, LOOP_GUARD_SETTING_KEYS.continuationMaxAgeHours),
    LOOP_GUARD_DEFAULT_AGE_HOURS,
    { allowZero: true, floor: 1, cap: 168 },
  );

  return {
    enabled: parseEnabled(readKey(map, LOOP_GUARD_SETTING_KEYS.enabled)),
    identicalErrorRepeats: identical,
    pingPongHalfCycles: pingPong,
    continuationCeiling: ceiling,
    continuationMaxAgeMs: ageHours === 0 ? 0 : ageHours * HOUR_MS,
    maxBufferedTurns: LOOP_GUARD_DEFAULTS.maxBufferedTurns,
  };
}
