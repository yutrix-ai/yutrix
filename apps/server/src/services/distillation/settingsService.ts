import { db } from "../../db";
import { systemSettings } from "../../db/schema";
import { eq } from "drizzle-orm";
import {
  distillationSettingsSchema,
  type DistillationSettings,
} from "@promptgate/shared";

const SETTINGS_KEYS = {
  analysisRouteId: "distillation.analysisRouteId",
  concurrency: "distillation.concurrency",
  cronEnabled: "distillation.cronEnabled",
  cron: "distillation.cron",
  maxRecordsPerRun: "distillation.maxRecordsPerRun",
  lastIncrementalCursor: "distillation.lastIncrementalCursor",
} as const;

async function getSetting(key: string): Promise<string | null> {
  const rows = await db
    .select()
    .from(systemSettings)
    .where(eq(systemSettings.key, key))
    .limit(1);
  return rows[0]?.value ?? null;
}

async function setSetting(key: string, value: string): Promise<void> {
  const now = new Date();
  const existing = await getSetting(key);
  if (existing === null) {
    await db.insert(systemSettings).values({
      key,
      value,
      createdAt: now,
      updatedAt: now,
    });
  } else {
    await db
      .update(systemSettings)
      .set({ value, updatedAt: now })
      .where(eq(systemSettings.key, key));
  }
}

export async function getDistillationSettings(): Promise<DistillationSettings> {
  const raw = {
    analysisRouteId: await getSetting(SETTINGS_KEYS.analysisRouteId),
    concurrency: Number(await getSetting(SETTINGS_KEYS.concurrency)) || 2,
    cronEnabled: (await getSetting(SETTINGS_KEYS.cronEnabled)) === "true",
    cron: (await getSetting(SETTINGS_KEYS.cron)) || "0 3 * * *",
    maxRecordsPerRun:
      Number(await getSetting(SETTINGS_KEYS.maxRecordsPerRun)) || 500,
  };
  return distillationSettingsSchema.parse(raw);
}

export async function updateDistillationSettings(
  patch: Partial<DistillationSettings>,
): Promise<DistillationSettings> {
  const current = await getDistillationSettings();
  const next = distillationSettingsSchema.parse({ ...current, ...patch });
  if (patch.analysisRouteId !== undefined) {
    await setSetting(
      SETTINGS_KEYS.analysisRouteId,
      patch.analysisRouteId ?? "",
    );
  }
  if (patch.concurrency !== undefined) {
    await setSetting(SETTINGS_KEYS.concurrency, String(next.concurrency));
  }
  if (patch.cronEnabled !== undefined) {
    await setSetting(SETTINGS_KEYS.cronEnabled, String(next.cronEnabled));
  }
  if (patch.cron !== undefined) {
    await setSetting(SETTINGS_KEYS.cron, next.cron);
  }
  if (patch.maxRecordsPerRun !== undefined) {
    await setSetting(
      SETTINGS_KEYS.maxRecordsPerRun,
      String(next.maxRecordsPerRun),
    );
  }
  return next;
}

export async function getLastIncrementalCursor(): Promise<Date | null> {
  const v = await getSetting(SETTINGS_KEYS.lastIncrementalCursor);
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function setLastIncrementalCursor(d: Date): Promise<void> {
  await setSetting(SETTINGS_KEYS.lastIncrementalCursor, d.toISOString());
}
