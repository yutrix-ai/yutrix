import crypto from "crypto";
import { db } from "../../db";
import {
  distillationJobItems,
  distillationJobs,
  distillationLearnedRecords,
  distillationRoutingProposals,
  distillationSignalVersions,
  distillationSkillPackages,
  users,
} from "../../db/schema";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { CreateDistillationJobInput } from "./types";
import {
  resetLearnedRecords,
  selectPendingLearningRecords,
} from "./recordSelector";
import { getDistillationSettings } from "./settingsService";
import {
  startDistillationWorker,
  cancelDistillationWorker,
  pauseDistillationWorker,
  resumeDistillationWorker,
} from "./worker";
import { mergeRoutingAdjustments } from "./routingMerger";
import { validateRoutingProposals } from "./proposalValidation";
import { clearRoutingOverlayCache } from "./routingOverlay";
import { refreshRoutingWeightSnapshot } from "./routingWeightsBridge";

export async function listDistillationJobs(limit = 20) {
  return db
    .select()
    .from(distillationJobs)
    .orderBy(desc(distillationJobs.createdAt))
    .limit(limit);
}

export async function getDistillationJob(id: string) {
  const rows = await db
    .select()
    .from(distillationJobs)
    .where(eq(distillationJobs.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function createDistillationJob(
  input: CreateDistillationJobInput,
): Promise<{ jobId: string }> {
  const activeJobs = await db
    .select()
    .from(distillationJobs)
    .where(inArray(distillationJobs.status, ["pending", "running", "paused"]))
    .limit(1);
  if (activeJobs.length > 0) {
    const active = activeJobs[0]!;
    throw new Error(
      `A distillation job is already active (${active.status}: ${active.id})`,
    );
  }

  const settings = await getDistillationSettings();
  if (input.mode === "full_relearn") {
    await resetLearnedRecords();
  }

  const records = await selectPendingLearningRecords({
    userIds: input.userIds,
    timeRangeStart: input.timeRangeStart,
    timeRangeEnd: input.timeRangeEnd,
    maxRecords: input.maxRecords ?? settings.maxRecordsPerRun,
    fullRellearn: input.mode === "full_relearn",
  });

  const jobId = crypto.randomUUID();
  const generationId = crypto.randomUUID();
  const now = new Date();

  await db.insert(distillationJobs).values({
    id: jobId,
    mode: input.mode,
    status: records.length === 0 ? "completed" : "pending",
    analysisRouteId: settings.analysisRouteId,
    userIdsFilter: input.userIds ? JSON.stringify(input.userIds) : null,
    timeRangeStart: input.timeRangeStart ?? null,
    timeRangeEnd: input.timeRangeEnd ?? null,
    maxRecords: input.maxRecords ?? settings.maxRecordsPerRun,
    totalItems: records.length,
    processedItems: 0,
    failedItems: 0,
    generationId,
    createdAt: now,
    completedAt: records.length === 0 ? now : null,
  });

  if (records.length > 0) {
    await db.insert(distillationJobItems).values(
      records.map((r) => ({
        id: crypto.randomUUID(),
        jobId,
        chatLogId: r.chatLogId,
        userId: r.userId,
        status: "pending" as const,
        createdAt: now,
      })),
    );
    startDistillationWorker(jobId);
  }

  return { jobId };
}

export async function pauseDistillationJob(jobId: string): Promise<void> {
  const job = await getDistillationJob(jobId);
  if (!job) {
    throw new Error("Job not found");
  }
  if (job.status !== "pending" && job.status !== "running") {
    throw new Error(`Cannot pause job with status "${job.status}"`);
  }
  pauseDistillationWorker(jobId);
  await db
    .update(distillationJobs)
    .set({ status: "paused" })
    .where(eq(distillationJobs.id, jobId));
}

export async function resumeDistillationJob(jobId: string): Promise<void> {
  const job = await getDistillationJob(jobId);
  if (!job) {
    throw new Error("Job not found");
  }
  if (job.status !== "paused") {
    throw new Error(`Cannot resume job with status "${job.status}"`);
  }
  resumeDistillationWorker(jobId);
  await db
    .update(distillationJobs)
    .set({ status: "pending" })
    .where(eq(distillationJobs.id, jobId));
  await db
    .update(distillationJobItems)
    .set({ status: "pending" })
    .where(
      and(
        eq(distillationJobItems.jobId, jobId),
        eq(distillationJobItems.status, "processing"),
      ),
    );
  startDistillationWorker(jobId);
}

export async function cancelDistillationJob(jobId: string): Promise<void> {
  const job = await getDistillationJob(jobId);
  if (!job) {
    throw new Error("Job not found");
  }
  if (
    job.status !== "pending" &&
    job.status !== "running" &&
    job.status !== "paused"
  ) {
    throw new Error(`Cannot cancel job with status "${job.status}"`);
  }
  cancelDistillationWorker(jobId);
  await db
    .update(distillationJobs)
    .set({ status: "cancelled", completedAt: new Date() })
    .where(eq(distillationJobs.id, jobId));
}

export async function listRoutingProposals(status?: string) {
  if (status) {
    return db
      .select()
      .from(distillationRoutingProposals)
      .where(eq(distillationRoutingProposals.status, status))
      .orderBy(desc(distillationRoutingProposals.createdAt));
  }
  return db
    .select()
    .from(distillationRoutingProposals)
    .orderBy(desc(distillationRoutingProposals.createdAt));
}

export async function validateDraftProposals(): Promise<{
  ok: boolean;
  errors: string[];
  proposalCount: number;
}> {
  const drafts = await db
    .select()
    .from(distillationRoutingProposals)
    .where(eq(distillationRoutingProposals.status, "draft"));
  const payloads = drafts.map(
    (d) => JSON.parse(d.payload) as import("@promptgate/shared").DistillationRecordOutput["routing"],
  );
  const result = validateRoutingProposals(payloads);
  const status = result.ok ? "validated" : "validation_failed";
  for (const p of drafts) {
    await db
      .update(distillationRoutingProposals)
      .set({
        status,
        validationResult: JSON.stringify(result),
      })
      .where(eq(distillationRoutingProposals.id, p.id));
  }
  return {
    ok: result.ok,
    errors: result.errors,
    proposalCount: drafts.length,
  };
}

export async function applyValidatedProposals(): Promise<{
  versionId: string;
  versionLabel: string;
}> {
  const validated = await db
    .select()
    .from(distillationRoutingProposals)
    .where(eq(distillationRoutingProposals.status, "validated"));
  if (validated.length === 0) {
    throw new Error("No validated proposals to apply");
  }

  const payloads = validated.map(
    (d) => JSON.parse(d.payload) as import("@promptgate/shared").DistillationRecordOutput["routing"],
  );
  const merged = mergeRoutingAdjustments(payloads);
  const versionId = crypto.randomUUID();
  const versionLabel = `flywheel-${new Date().toISOString().slice(0, 10)}-${validated.length}p`;

  await db
    .update(distillationSignalVersions)
    .set({ isActive: false })
    .where(eq(distillationSignalVersions.isActive, true));

  await db.insert(distillationSignalVersions).values({
    id: versionId,
    versionLabel,
    weightOverrides: JSON.stringify(merged.weightOverrides),
    boundaryRules: JSON.stringify(merged.boundaryRules),
    proposalIds: JSON.stringify(validated.map((v) => v.id)),
    isActive: true,
    createdAt: new Date(),
  });

  for (const p of validated) {
    await db
      .update(distillationRoutingProposals)
      .set({ status: "applied" })
      .where(eq(distillationRoutingProposals.id, p.id));
  }

  clearRoutingOverlayCache();
  await refreshRoutingWeightSnapshot();
  return { versionId, versionLabel };
}

export async function rollbackRoutingOverlay(): Promise<void> {
  const active = await db
    .select()
    .from(distillationSignalVersions)
    .where(eq(distillationSignalVersions.isActive, true))
    .orderBy(desc(distillationSignalVersions.createdAt))
    .limit(1);
  if (active[0]) {
    await db
      .update(distillationSignalVersions)
      .set({ isActive: false })
      .where(eq(distillationSignalVersions.id, active[0].id));
  }
  clearRoutingOverlayCache();
  await refreshRoutingWeightSnapshot();
}

export async function finalizeSkillPackagesForJob(_jobId: string): Promise<void> {
  /* skill packages finalized in worker */
}

export async function listSkillPackages() {
  const rows = await db
    .select()
    .from(distillationSkillPackages)
    .orderBy(desc(distillationSkillPackages.createdAt));
  const latestByUser = new Map<string, (typeof rows)[0]>();
  for (const row of rows) {
    const prev = latestByUser.get(row.userId);
    if (!prev || row.version > prev.version) {
      latestByUser.set(row.userId, row);
    }
  }
  return [...latestByUser.values()];
}

export async function getLatestSkillPackage(userId: string) {
  const rows = await db
    .select()
    .from(distillationSkillPackages)
    .where(eq(distillationSkillPackages.userId, userId))
    .orderBy(desc(distillationSkillPackages.version))
    .limit(1);
  return rows[0] ?? null;
}

