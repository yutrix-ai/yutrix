import { db } from "../db";
import { systemSettings, requestLogs, chatLogs, actionLogs } from "../db/schema";
import { eq, lt, inArray } from "drizzle-orm";

const ONE_HOUR_MS = 60 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 5 * 60 * 1000;
const DELETE_BATCH_SIZE = 500;

const LOG_TABLES = [
  { name: "request_logs", table: requestLogs },
  { name: "chat_logs", table: chatLogs },
  { name: "action_logs", table: actionLogs },
] as const;

export type LogCleanupResult = { days: number; deleted: Record<string, number> } | null;

let running = false;

/**
 * Deletes in small batches so a large backlog does not hold a long write lock
 * or block gateway requests on the shared connection.
 */
async function deleteOlderThan(table: (typeof LOG_TABLES)[number]["table"], cutoff: Date): Promise<number> {
  let total = 0;
  for (;;) {
    const rows = await db
      .select({ id: table.id })
      .from(table)
      .where(lt(table.createdAt, cutoff))
      .limit(DELETE_BATCH_SIZE);
    if (rows.length === 0) return total;
    await db.delete(table).where(inArray(table.id, rows.map((r: { id: string }) => r.id)));
    total += rows.length;
    if (rows.length < DELETE_BATCH_SIZE) return total;
    await new Promise((resolve) => setImmediate(resolve));
  }
}

export async function runLogCleanup(now = Date.now()): Promise<LogCleanupResult> {
  if (running) return null;
  running = true;
  try {
    const settings = await db
      .select()
      .from(systemSettings)
      .where(eq(systemSettings.key, "logRetentionDays"));
    if (settings.length === 0) return null;

    const days = parseInt(settings[0].value, 10);
    if (isNaN(days) || days <= 0) return null;

    const cutoff = new Date(now - days * 24 * 60 * 60 * 1000);
    console.log(`[Log Cleanup] Deleting logs older than ${days} days (${cutoff.toISOString()})...`);
    const deleted: Record<string, number> = {};
    for (const { name, table } of LOG_TABLES) {
      deleted[name] = await deleteOlderThan(table, cutoff);
    }
    console.log(`[Log Cleanup] Completed: ${JSON.stringify(deleted)}`);
    return { days, deleted };
  } finally {
    running = false;
  }
}

export function isLogCleanupEnabled(): boolean {
  const flag = (process.env.LOG_CLEANUP_ENABLED ?? "").trim().toLowerCase();
  return flag !== "0" && flag !== "false";
}

export function startLogCleanupWorker() {
  if (!isLogCleanupEnabled()) {
    console.log("[Log Cleanup] Disabled via LOG_CLEANUP_ENABLED.");
    return;
  }

  const safeRun = () => {
    runLogCleanup().catch((e) => console.error("[Log Cleanup] Error during cleanup:", e));
  };

  setTimeout(safeRun, FIRST_RUN_DELAY_MS).unref();
  setInterval(safeRun, ONE_HOUR_MS).unref();
}
