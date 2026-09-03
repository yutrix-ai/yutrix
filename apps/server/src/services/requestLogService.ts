import { eq } from "drizzle-orm";
import { db } from "../db";
import { requestLogs } from "../db/schema";
import { logEmitter } from "../utils/events";

type RequestLogPayload = Record<string, any> & {
  id: string;
  userId?: string | null;
};

const REQUEST_LOG_COLUMNS = new Set([
  "id",
  "requestId",
  "userId",
  "apiKeyId",
  "providerId",
  "providerApiKeyId",
  "endpointId",
  "subdomainId",
  "protocol",
  "model",
  "statusCode",
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "totalTokens",
  "latencyMs",
  "ttftMs",
  "streaming",
  "usageStatus",
  "errorCode",
  "errorMessage",
  "ipAddress",
  "cost",
  "routingTrace",
  "createdAt",
]);

function toRequestLogDbPatch(payload: Record<string, any>) {
  const patch: Record<string, any> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (REQUEST_LOG_COLUMNS.has(key) && value !== undefined) {
      patch[key] = value;
    }
  }
  return patch;
}

type RequestLogTask =
  | { type: "insert"; payload: RequestLogPayload }
  | { type: "patch"; logId: string; patch: Record<string, any> };

// Non-blocking write queue for request logs:
// Flushes to DB in background so HTTP/LLM gateway hot path never awaits log inserts or updates.
// Generous/unbounded capacity: no drop-newest or drop-oldest policy (force majeure crash loss only).
const writeQueue: RequestLogTask[] = [];
let isFlushing = false;
let activeFlushPromise: Promise<void> | null = null;
const BACKPRESSURE_WARN_THRESHOLD = 5000;

function enqueueTask(task: RequestLogTask): void {
  if (writeQueue.length > BACKPRESSURE_WARN_THRESHOLD && writeQueue.length % 1000 === 0) {
    console.warn(
      `[RequestLogService] Backpressure warning: queue size is ${writeQueue.length}. Continuing background flush without dropping.`
    );
  }
  writeQueue.push(task);
  triggerFlush();
}

function triggerFlush(): void {
  if (!isFlushing) {
    activeFlushPromise = flushQueueWorker();
  }
}

async function flushQueueWorker(): Promise<void> {
  if (isFlushing) return;
  isFlushing = true;

  try {
    while (writeQueue.length > 0) {
      const task = writeQueue.shift()!;
      await executeTaskWithRetry(task);
    }
  } finally {
    isFlushing = false;
    activeFlushPromise = null;
    if (writeQueue.length > 0) {
      triggerFlush();
    }
  }
}

async function executeTaskWithRetry(task: RequestLogTask): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (task.type === "insert") {
        await db.insert(requestLogs).values(toRequestLogDbPatch(task.payload) as any);
      } else {
        await db
          .update(requestLogs)
          .set(toRequestLogDbPatch(task.patch) as any)
          .where(eq(requestLogs.id, task.logId))
          .execute();
      }
      return;
    } catch (error: any) {
      if (attempt === 0) {
        console.warn(
          `[RequestLogService] DB write failed (${task.type}) for ${task.type === "insert" ? task.payload.id : task.logId}, retrying once:`,
          error?.message || error
        );
        await new Promise((resolve) => setTimeout(resolve, 50));
        continue;
      }
      console.error(
        `[RequestLogService] DB write failed (${task.type}) after retry for ${task.type === "insert" ? task.payload.id : task.logId}:`,
        error
      );
    }
  }
}

/**
 * Flush all pending request log writes in the background queue.
 * Useful for tests, graceful shutdown, and drain operations.
 */
export async function flushRequestLogQueue(): Promise<void> {
  while (writeQueue.length > 0 || isFlushing) {
    if (activeFlushPromise) {
      await activeFlushPromise;
    } else {
      triggerFlush();
      if (activeFlushPromise) await activeFlushPromise;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
}

export function publishRequestLogUpdate(payload: RequestLogPayload) {
  logEmitter.emit("logUpdate", payload);
}

/**
 * Non-blocking insertion of a request log.
 * Emits real-time event and queues DB insert for background flush.
 * Does NOT await the DB insert.
 */
export async function insertRequestLog(payload: RequestLogPayload): Promise<void> {
  publishRequestLogUpdate(payload);
  enqueueTask({ type: "insert", payload });
}

/**
 * Non-blocking patch of an existing request log.
 * Queues DB update for background flush.
 * Does NOT await the DB update.
 */
export async function persistRequestLogPatch(logId: string, patch: Record<string, any>): Promise<void> {
  enqueueTask({ type: "patch", logId, patch });
}

/**
 * Non-blocking update of an existing request log.
 * Emits real-time event and queues DB update for background flush.
 * Does NOT await the DB update.
 */
export async function updateRequestLog(
  logId: string,
  patch: Record<string, any>,
  eventPayload?: RequestLogPayload,
): Promise<void> {
  publishRequestLogUpdate(eventPayload || ({ id: logId, ...patch } as RequestLogPayload));
  enqueueTask({ type: "patch", logId, patch });
}
