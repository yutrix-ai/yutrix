import { db } from "../db";
import { systemSettings, requestLogs, chatLogs, actionLogs } from "../db/schema";
import { eq, lt } from "drizzle-orm";

const ONE_HOUR_MS = 60 * 60 * 1000;

export function startLogCleanupWorker() {
  const runCleanup = async () => {
    try {
      const settings = await db
        .select()
        .from(systemSettings)
        .where(eq(systemSettings.key, "logRetentionDays"));

      if (settings.length > 0) {
        const days = parseInt(settings[0].value, 10);
        if (!isNaN(days) && days > 0) {
          const cutoffDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
          console.log(`[Log Cleanup] Deleting logs older than ${days} days (${cutoffDate.toISOString()})...`);

          // Delete old Request Logs
          await db.delete(requestLogs).where(lt(requestLogs.createdAt, cutoffDate));

          // Delete old Chat Logs
          await db.delete(chatLogs).where(lt(chatLogs.createdAt, cutoffDate));

          // Delete old Action Logs
          await db.delete(actionLogs).where(lt(actionLogs.createdAt, cutoffDate));

          console.log(`[Log Cleanup] Completed successfully.`);
        }
      }
    } catch (e) {
      console.error("[Log Cleanup] Error during cleanup:", e);
    }
  };

  // Run once on startup
  runCleanup();

  // Schedule every hour
  setInterval(runCleanup, ONE_HOUR_MS);
}
