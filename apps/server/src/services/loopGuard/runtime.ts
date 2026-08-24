import { inArray } from "drizzle-orm";
import { resolveLoopGuardConfig, LOOP_GUARD_SETTING_KEYS } from "./config";
import { LOOP_GUARD_DEFAULTS, type LoopGuardConfig } from "./types";

export interface LoopGuardRuntime {
  config: LoopGuardConfig;
  unavailable: boolean;
}

const SETTING_KEY_LIST = Object.values(LOOP_GUARD_SETTING_KEYS);

let cached: LoopGuardRuntime | null = null;

export function peekLoopGuardRuntime(): LoopGuardRuntime {
  return (
    cached || {
      config: { ...LOOP_GUARD_DEFAULTS },
      unavailable: false,
    }
  );
}

export function resetLoopGuardRuntimeForTests(): void {
  cached = null;
}

export function applyLoopGuardRuntime(runtime: LoopGuardRuntime): void {
  cached = runtime;
}

export async function refreshLoopGuardConfigCache(): Promise<LoopGuardRuntime> {
  try {
    const { db } = await import("../../db");
    const { systemSettings } = await import("../../db/schema");
    const rows = await db
      .select()
      .from(systemSettings)
      .where(inArray(systemSettings.key, SETTING_KEY_LIST));
    const map: Record<string, string> = {};
    for (const row of rows) {
      map[row.key] = row.value;
    }
    cached = { config: resolveLoopGuardConfig(map), unavailable: false };
    return cached;
  } catch {
    cached = { config: { ...LOOP_GUARD_DEFAULTS }, unavailable: true };
    return cached;
  }
}
