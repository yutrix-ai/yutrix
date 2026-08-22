import {
  GATEWAY_REQUEST_CLASSES,
  type GatewayRequestClass,
} from "../../services/requestRoutingClass";
import {
  globalSessionQueueManager,
  type SessionQueueManager,
} from "./sessionQueueManager";

export type SessionLockMode = "none" | "short";

/**
 * Per-class admission policy. Add a row to extend; do not special-case
 * inside the queue primitive. Unknown classes fail closed to a short lock.
 */
export const SESSION_LOCK_MODE_BY_CLASS: Record<GatewayRequestClass, SessionLockMode> = {
  client_sidecar: "none",
  user_intent: "short",
  tool_continuation: "short",
};

const KNOWN_REQUEST_CLASSES = new Set<string>(GATEWAY_REQUEST_CLASSES);

export function sessionLockModeFor(requestClass: string): SessionLockMode {
  if (!KNOWN_REQUEST_CLASSES.has(requestClass)) return "short";
  return SESSION_LOCK_MODE_BY_CLASS[requestClass as GatewayRequestClass];
}

export interface SessionAdmissionOptions<T> {
  sessionId: string;
  requestClass: string;
  criticalSection?: () => Promise<void>;
  onAdmitted: () => Promise<T>;
  manager?: SessionQueueManager;
  timeoutMs?: number;
}

/**
 * Session IDs group related requests; they are not an HTTP mutex.
 * Sidecar traffic never waits. Other classes take a short lock only around
 * `criticalSection` (sticky / loop-guard state), then release before the
 * caller runs `onAdmitted` (upstream + stream).
 */
export async function runWithSessionAdmission<T>(
  options: SessionAdmissionOptions<T>,
): Promise<T> {
  const manager = options.manager ?? globalSessionQueueManager;
  const sessionId = (options.sessionId || "").trim();
  const mode = sessionId ? sessionLockModeFor(options.requestClass) : "none";

  if (mode === "none") {
    return options.onAdmitted();
  }

  const lock = await manager.acquireLock(sessionId, { timeoutMs: options.timeoutMs });
  try {
    if (options.criticalSection) {
      await options.criticalSection();
    }
  } finally {
    lock.release();
  }

  return options.onAdmitted();
}
