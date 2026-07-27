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

export function publishRequestLogUpdate(payload: RequestLogPayload) {
  logEmitter.emit("logUpdate", payload);
}

export async function insertRequestLog(payload: RequestLogPayload) {
  publishRequestLogUpdate(payload);
  try {
    await db.insert(requestLogs).values(toRequestLogDbPatch(payload) as any);
  } catch (error) {
    console.error("Failed to insert request log", error);
  }
}

export async function persistRequestLogPatch(logId: string, patch: Record<string, any>) {
  try {
    await db
      .update(requestLogs)
      .set(toRequestLogDbPatch(patch) as any)
      .where(eq(requestLogs.id, logId))
      .execute();
  } catch (error) {
    console.error("Failed to update request log", error);
  }
}

export async function updateRequestLog(
  logId: string,
  patch: Record<string, any>,
  eventPayload?: RequestLogPayload,
) {
  publishRequestLogUpdate(eventPayload || ({ id: logId, ...patch } as RequestLogPayload));
  await persistRequestLogPatch(logId, patch);
}
