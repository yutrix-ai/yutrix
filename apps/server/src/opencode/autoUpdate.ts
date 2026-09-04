import cron, { type ScheduledTask } from "node-cron";
import { OpencodeService } from "./opencodeService";
import { getOpencodeAutoUpdate } from "./settings";

let currentTask: ScheduledTask | null = null;

export function stopOpencodeAutoUpdate(): void {
  if (currentTask) {
    currentTask.stop();
    currentTask = null;
  }
}

export async function runOpencodeAutoUpdate(): Promise<void> {
  try {
    if (!(await getOpencodeAutoUpdate())) return;
    await OpencodeService.getInstance().maybeAutoUpdate();
  } catch (e) {
    console.error("[opencode-auto-update]", e);
  }
}

export async function scheduleOpencodeAutoUpdate(): Promise<void> {
  stopOpencodeAutoUpdate();
  currentTask = cron.schedule("0 4 * * *", () => {
    void runOpencodeAutoUpdate();
  });
  void runOpencodeAutoUpdate();
}
