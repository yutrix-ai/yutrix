import { db, isDbInitialized } from "../db";
import { systemSettings } from "../db/schema";
import { eq } from "drizzle-orm";
import { stopDingTalkJobs, scheduleDingTalkJobs } from "./dingtalk";
import { stopDistillationJobs, scheduleDistillationJobs } from "./distillation/scheduler";

let isMaintenanceActive = false;
let inFlightRequests = 0;

export function incrementInFlight(): void {
  inFlightRequests++;
}

export function decrementInFlight(): void {
  inFlightRequests = Math.max(0, inFlightRequests - 1);
}

export function getInFlightCount(): number {
  return inFlightRequests;
}

export function isMaintenanceMode(): boolean {
  return isMaintenanceActive;
}

/**
 * Polls until active in-flight requests reach 0 or timeout expires.
 */
export async function drainRequests(timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  while (inFlightRequests > 0) {
    if (Date.now() - start >= timeoutMs) {
      console.warn(
        `[Maintenance] Drain requests timed out after ${timeoutMs}ms with ${inFlightRequests} in-flight requests remaining. Force proceeding.`
      );
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/**
 * Toggles maintenance mode.
 * - On: sets memory flag, creates temporary DB setting, stops crons, drains in-flight requests.
 * - Off: clears memory flag, deletes temporary DB setting, restarts crons.
 */
export async function setMaintenanceMode(active: boolean, options: { drain?: boolean; timeoutMs?: number } = {}): Promise<void> {
  isMaintenanceActive = active;

  if (active) {
    // 1. Stop background jobs
    try {
      stopDingTalkJobs();
      stopDistillationJobs();
    } catch (err) {
      console.warn("[Maintenance] Error stopping background jobs:", err);
    }

    // 2. Persist temporary maintenance setting in DB if DB is ready
    if (isDbInitialized()) {
      try {
        await (db as any)
          .insert(systemSettings)
          .values({
            key: "maintenance",
            value: "true",
            description: "Temporary system database migration maintenance flag",
            createdAt: new Date(),
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: systemSettings.key,
            set: { value: "true", updatedAt: new Date() },
          });
      } catch (err) {
        console.warn("[Maintenance] Warning: Failed to set maintenance key in DB:", err);
      }
    }

    // 3. Drain in-flight requests if requested (default true)
    if (options.drain !== false) {
      await drainRequests(options.timeoutMs ?? 60_000);
    }
  } else {
    // 1. Clear temporary DB setting
    if (isDbInitialized()) {
      try {
        await (db as any)
          .delete(systemSettings)
          .where(eq(systemSettings.key, "maintenance"));
      } catch (err) {
        // Ignore errors if table doesn't exist
      }
    }

    // 2. Restart background jobs if DB is initialized
    if (isDbInitialized()) {
      try {
        await scheduleDingTalkJobs();
        await scheduleDistillationJobs();
      } catch (err) {
        console.warn("[Maintenance] Error resuming background jobs:", err);
      }
    }
  }
}
