import crypto from "crypto";
import { db } from "../../db";
import {
  distillationJobItems,
  distillationJobs,
  distillationLearnedRecords,
  distillationRoutingProposals,
  distillationSkillPackages,
  chatLogs,
  users,
} from "../../db/schema";
import { and, eq } from "drizzle-orm";
import {
  defaultDistillationAnalyzer,
  type DistillationAnalyzer,
} from "./analyzer";
import { validateDistillationOutput } from "./outputValidator";
import { consolidateSkillFragments } from "./skillConsolidator";
import { getDistillationSettings, setLastIncrementalCursor } from "./settingsService";

let analyzer: DistillationAnalyzer = defaultDistillationAnalyzer;
const cancelledJobs = new Set<string>();
const activeWorkers = new Map<string, Promise<void>>();

export function setDistillationAnalyzer(a: DistillationAnalyzer): void {
  analyzer = a;
}

export function cancelDistillationWorker(jobId: string): void {
  cancelledJobs.add(jobId);
}

export function startDistillationWorker(jobId: string): void {
  if (activeWorkers.has(jobId)) return;
  const task = runWorker(jobId).finally(() => {
    activeWorkers.delete(jobId);
  });
  activeWorkers.set(jobId, task);
}

async function runWorker(jobId: string): Promise<void> {
  const settings = await getDistillationSettings();
  const concurrency = settings.concurrency;
  await db
    .update(distillationJobs)
    .set({ status: "running", startedAt: new Date() })
    .where(eq(distillationJobs.id, jobId));

  const jobRows = await db
    .select()
    .from(distillationJobs)
    .where(eq(distillationJobs.id, jobId))
    .limit(1);
  const job = jobRows[0];
  if (!job) return;

  const skillAccum = new Map<
    string,
    { username: string; fragments: import("@promptgate/shared").DistillationRecordOutput["skill"][] }
  >();

  while (!cancelledJobs.has(jobId)) {
    const pending = await db
      .select()
      .from(distillationJobItems)
      .where(
        and(
          eq(distillationJobItems.jobId, jobId),
          eq(distillationJobItems.status, "pending"),
        ),
      )
      .limit(concurrency);

    if (pending.length === 0) break;

    await Promise.all(
      pending.map(async (item) => {
        if (cancelledJobs.has(jobId)) return;
        await db
          .update(distillationJobItems)
          .set({ status: "processing" })
          .where(eq(distillationJobItems.id, item.id));

        try {
          const userRow = await db
            .select()
            .from(users)
            .where(eq(users.id, item.userId))
            .limit(1);
          const record = {
            chatLogId: item.chatLogId,
            userId: item.userId,
            username: userRow[0]?.username ?? item.userId,
            inputText: null as string | null,
            outputText: null as string | null,
            status: null as string | null,
            error: null as string | null,
            model: null as string | null,
            createdAt: new Date(),
          };
          const logRows = await db
            .select()
            .from(chatLogs)
            .where(eq(chatLogs.id, item.chatLogId))
            .limit(1);
          const log = logRows[0];
          if (log) {
            record.inputText = log.inputText;
            record.outputText = log.outputText;
            record.status = log.status;
            record.error = log.error;
            record.model = log.model;
            record.createdAt = log.createdAt;
          }

          const raw = await analyzer.analyze(record);
          const validated = validateDistillationOutput(raw);
          if (!validated.ok) {
            await db
              .update(distillationJobItems)
              .set({
                status: "skipped",
                errorMessage: validated.error,
                processedAt: new Date(),
              })
              .where(eq(distillationJobItems.id, item.id));
            return;
          }

          const out = validated.data;
          if (
            out.routing.action !== "confirm" &&
            out.routing.adjustments.length > 0
          ) {
            await db.insert(distillationRoutingProposals).values({
              id: crypto.randomUUID(),
              jobId,
              chatLogId: item.chatLogId,
              sourceUserId: item.userId,
              status: "draft",
              payload: JSON.stringify(out.routing),
              createdAt: new Date(),
            });
          }

          const acc = skillAccum.get(item.userId) ?? {
            username: record.username,
            fragments: [],
          };
          acc.fragments.push(out.skill);
          skillAccum.set(item.userId, acc);

          await db.insert(distillationLearnedRecords).values({
            chatLogId: item.chatLogId,
            jobId,
            generationId: job.generationId,
            learnedAt: new Date(),
          });

          await db
            .update(distillationJobItems)
            .set({ status: "learned", processedAt: new Date() })
            .where(eq(distillationJobItems.id, item.id));

          await db
            .update(distillationJobs)
            .set({
              processedItems: job.processedItems + 1,
            })
            .where(eq(distillationJobs.id, jobId));
          job.processedItems += 1;
        } catch (e: any) {
          await db
            .update(distillationJobItems)
            .set({
              status: "failed",
              errorMessage: e?.message ?? String(e),
              processedAt: new Date(),
            })
            .where(eq(distillationJobItems.id, item.id));
          await db
            .update(distillationJobs)
            .set({ failedItems: job.failedItems + 1 })
            .where(eq(distillationJobs.id, jobId));
          job.failedItems += 1;
        }
      }),
    );
  }

  for (const [userId, acc] of skillAccum) {
    const existing = await db
      .select()
      .from(distillationSkillPackages)
      .where(eq(distillationSkillPackages.userId, userId))
      .orderBy(distillationSkillPackages.version)
      .limit(1);
    const latest = existing.at(-1);
    const version = (latest?.version ?? 0) + 1;
    const pkg = consolidateSkillFragments({
      userId,
      username: acc.username,
      version,
      fragments: acc.fragments,
    });
    await db.insert(distillationSkillPackages).values({
      id: crypto.randomUUID(),
      userId,
      username: acc.username,
      version,
      status: "published",
      files: JSON.stringify(pkg.files),
      sourceRecordCount: acc.fragments.length,
      jobId,
      createdAt: new Date(),
    });
  }

  await setLastIncrementalCursor(new Date());

  const finalStatus = cancelledJobs.has(jobId) ? "cancelled" : "completed";
  cancelledJobs.delete(jobId);
  await db
    .update(distillationJobs)
    .set({ status: finalStatus, completedAt: new Date() })
    .where(eq(distillationJobs.id, jobId));
}
