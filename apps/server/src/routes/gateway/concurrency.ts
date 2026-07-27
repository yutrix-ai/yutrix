import { db } from "../../db";
import { systemSettings } from "../../db/schema";
import { eq } from "drizzle-orm";
import { AsyncQueue } from "../../utils/asyncQueue";

const apiKeyQueues = new Map<string, AsyncQueue>();
const providerQueues = new Map<string, AsyncQueue>();
let globalQueue = new AsyncQueue({ concurrency: 100 });

export function getApiKeyQueue(apiKeyId: string, limit: number): AsyncQueue {
  if (!apiKeyQueues.has(apiKeyId)) {
    apiKeyQueues.set(apiKeyId, new AsyncQueue({ concurrency: limit }));
  }
  const q = apiKeyQueues.get(apiKeyId)!;
  q.concurrency = limit;
  return q;
}

export function getProviderQueue(providerId: string, limit: number): AsyncQueue {
  if (!providerQueues.has(providerId)) {
    providerQueues.set(providerId, new AsyncQueue({ concurrency: limit }));
  }
  const q = providerQueues.get(providerId)!;
  q.concurrency = limit;
  return q;
}

export async function getGlobalQueue(): Promise<AsyncQueue> {
  const settings = await db
    .select()
    .from(systemSettings)
    .where(eq(systemSettings.key, "globalConcurrencyLimit"));
  const parsed = settings.length > 0 ? Number(settings[0].value) : 100;
  const limit = Number.isInteger(parsed) && parsed > 0 ? parsed : 100;
  globalQueue.concurrency = limit;
  return globalQueue;
}
