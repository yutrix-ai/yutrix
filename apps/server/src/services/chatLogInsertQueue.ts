import crypto from "crypto";
import { extractConversationRoot, getMessagesFromParsedRequest, tryParseJson } from "../utils/chatTurns";

export type AuditInsertQueuePayload = {
  userId?: string | null;
  clientSessionId?: string | null;
  requestId?: string | null;
  id?: string | null;
  inputText?: string | null;
};

const insertQueues = new Map<string, Promise<void>>();

/**
 * Serialize audit inserts per conversation, not per user.
 * Same client session (or conversation root) stays ordered for merge/turnId;
 * unrelated sessions of the same user may run in parallel.
 * Unknown identity fail-closes to a unique per-request key (no user-wide mutex).
 */
export function resolveAuditInsertQueueKey(payload: AuditInsertQueuePayload): string {
  const userId = (payload.userId || "anonymous").trim() || "anonymous";
  const client = (payload.clientSessionId || "").trim();
  if (client) return `${userId}::client:${client}`;

  try {
    const parsed = tryParseJson(payload.inputText);
    const root = extractConversationRoot(getMessagesFromParsedRequest(parsed));
    if (root) return `${userId}::root:${root}`;
  } catch {
    // isolate this request rather than collapsing onto the whole user
  }

  const req = (payload.requestId || payload.id || "").trim();
  if (req) return `${userId}::req:${req}`;
  return `${userId}::anon:${crypto.randomUUID()}`;
}

export async function enqueueAuditInsert<T>(
  payload: AuditInsertQueuePayload,
  task: () => Promise<T>,
): Promise<T> {
  const key = resolveAuditInsertQueueKey(payload);
  const prev = insertQueues.get(key) ?? Promise.resolve();

  let result!: T;
  const current = prev.then(async () => {
    result = await task();
  });

  const wrapped = current.catch((error) => {
    console.error(`[ChatLogService] Unhandled error in queue for ${key}:`, error);
  }).finally(() => {
    if (insertQueues.get(key) === wrapped) {
      insertQueues.delete(key);
    }
  });

  insertQueues.set(key, wrapped);
  await current;
  return result;
}
