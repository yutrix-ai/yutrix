import { extractConversationRoot, getMessagesFromParsedRequest } from "../../utils/chatTurns";
import { detectLoopStop } from "./detect";
import { fingerprintCurrentTurn } from "./fingerprint";
import { serveLoopStopResponse } from "./stopResponse";
import { defaultLoopGuardStore } from "./store";
import { peekLoopGuardRuntime } from "./runtime";
import type { LoopGuardConfig, LoopGuardInspection, LoopGuardStore, LoopStopReason } from "./types";

function resolveSessionKey(options: {
  userId: string;
  body: any;
  clientSessionId?: string | null;
}): string | null {
  const userId = (options.userId || "").trim();
  if (!userId) return null;
  const root = extractConversationRoot(getMessagesFromParsedRequest(options.body));
  const client = (options.clientSessionId || "").trim();
  if (root) return `${userId}::root:${root}`;
  if (client) return `${userId}::client:${client}`;
  return null;
}

const STOP_MESSAGES: Record<LoopStopReason, string> = {
  identical_error:
    "Yutrix stopped this run: the same tool error repeated 5 times with no progress. Try a different approach or start a new session.",
  ping_pong:
    "Yutrix stopped this run: two tool errors kept alternating (ping-pong) with no progress. Try a different approach or start a new session.",
  turn_ceiling:
    "Yutrix stopped this run: 400 tool-continuation turns elapsed since the last user message.",
  age_ceiling:
    "Yutrix stopped this run: more than 2 hours elapsed since the last user message without a new user turn.",
};

export function maybeServeContinuationLoopStop(options: {
  userId: string;
  body: any;
  clientSessionId?: string | null;
  reply: any;
  incomingProtocol: string;
  modelId: string;
  logAction?: (event: any) => void;
  baseActionLog?: Record<string, any>;
}): boolean {
  const inspection = inspectContinuationLoop({
    userId: options.userId,
    body: options.body,
    clientSessionId: options.clientSessionId,
  });
  if (inspection.failedOpen) {
    options.logAction?.({
      ...(options.baseActionLog || {}),
      level: "WARN",
      code: "request.loop_guard.error",
      message: "loop guard failed open",
    });
    return false;
  }
  if (!inspection.shouldStop || !inspection.reason) return false;
  options.logAction?.({
    ...(options.baseActionLog || {}),
    level: "WARN",
    code: "request.loop_guard.stopped",
    reason: inspection.reason,
    message: inspection.message,
    modelId: options.modelId,
  });
  serveLoopStopResponse({
    reply: options.reply,
    protocol: options.incomingProtocol,
    streaming: options.body?.stream === true,
    modelId: options.modelId,
    reason: inspection.reason,
    message: inspection.message || "Yutrix stopped this run.",
  });
  return true;
}

export function inspectContinuationLoop(options: {
  userId: string;
  body: any;
  clientSessionId?: string | null;
  store?: LoopGuardStore;
  nowMs?: number;
  config?: LoopGuardConfig;
}): LoopGuardInspection {
  try {
    const store = options.store || defaultLoopGuardStore;
    const nowMs = options.nowMs ?? Date.now();
    const runtime = options.config
      ? { config: options.config, unavailable: false }
      : peekLoopGuardRuntime();
    if (runtime.unavailable) {
      return { shouldStop: false, failedOpen: true };
    }
    const config = runtime.config;
    const sessionKey = resolveSessionKey(options);
    if (!sessionKey) {
      return { shouldStop: false, failedOpen: true };
    }

    const fp = fingerprintCurrentTurn(options.body);
    const session = store.get(sessionKey) || { turns: [] };

    if (fp.kind === "user_intent") {
      store.set(sessionKey, {
        turns: [{ kind: "user_intent", fingerprint: fp.fingerprint, isErrorClass: false, at: nowMs }],
        tripped: undefined,
      });
      return { shouldStop: false, sessionKey };
    }

    if (fp.kind !== "continuation") {
      return { shouldStop: false, sessionKey };
    }

    if (!config.enabled) {
      const nextTurnsWhileOff = [
        ...session.turns,
        {
          kind: "continuation" as const,
          fingerprint: fp.fingerprint,
          isErrorClass: fp.isErrorClass,
          at: nowMs,
        },
      ];
      store.set(sessionKey, { turns: nextTurnsWhileOff, tripped: session.tripped });
      return { shouldStop: false, sessionKey };
    }

    if (session.tripped) {
      return {
        shouldStop: true,
        reason: session.tripped.reason,
        message: STOP_MESSAGES[session.tripped.reason],
        sessionKey,
      };
    }

    const nextTurns = [
      ...session.turns,
      {
        kind: "continuation" as const,
        fingerprint: fp.fingerprint,
        isErrorClass: fp.isErrorClass,
        at: nowMs,
      },
    ];
    const hit = detectLoopStop(nextTurns, nowMs, config);
    if (hit) {
      store.set(sessionKey, { turns: nextTurns, tripped: hit });
      return {
        shouldStop: true,
        reason: hit.reason,
        message: STOP_MESSAGES[hit.reason],
        sessionKey,
      };
    }

    store.set(sessionKey, { turns: nextTurns });
    return { shouldStop: false, sessionKey };
  } catch {
    return { shouldStop: false, failedOpen: true };
  }
}
