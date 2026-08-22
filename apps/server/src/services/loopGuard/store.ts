import { LOOP_GUARD_DEFAULTS, type LoopGuardSession, type LoopGuardStore } from "./types";

export function createLoopGuardStore(): LoopGuardStore {
  const sessions = new Map<string, LoopGuardSession>();
  return {
    get(sessionKey: string) {
      return sessions.get(sessionKey);
    },
    set(sessionKey: string, session: LoopGuardSession) {
      const turns = session.turns.slice(-LOOP_GUARD_DEFAULTS.maxBufferedTurns);
      sessions.set(sessionKey, { ...session, turns });
    },
  };
}

export const defaultLoopGuardStore = createLoopGuardStore();
