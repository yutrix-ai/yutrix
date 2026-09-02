import cron, { type ScheduledTask } from "node-cron";
import { createDistillationJob } from "./jobService";
import { getDistillationSettings } from "./settingsService";

let currentTask: ScheduledTask | null = null;

export async function scheduleDistillationJobs(): Promise<void> {
  if (currentTask) {
    currentTask.stop();
    currentTask = null;
  }
  const settings = await getDistillationSettings();
  if (!settings.cronEnabled || !cron.validate(settings.cron)) {
    return;
  }
  currentTask = cron.schedule(settings.cron, async () => {
    try {
      await createDistillationJob({
        mode: "scheduled_incremental",
        maxRecords: settings.maxRecordsPerRun,
      });
    } catch (e) {
      console.error("[distillation-cron]", e);
    }
  });
  console.log(`[distillation] scheduled cron: ${settings.cron}`);
}
