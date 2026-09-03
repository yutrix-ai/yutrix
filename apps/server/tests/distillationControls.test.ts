import { describe, it, expect, beforeAll } from "vitest";
import crypto from "crypto";
import path from "path";
import Fastify, { FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import jwt from "@fastify/jwt";

const testDb = `data/promptgate_distillation_ctrl_test_${crypto.randomUUID()}.sqlite`;
process.env.DB_FILE = testDb;

describe("distillation job pause, resume, cancel controls", () => {
  let fastify: FastifyInstance;
  let adminToken: string;
  let adminUserId: string;
  let testChatLogId: string;

  beforeAll(async () => {
    const { migrate } = await import("drizzle-orm/libsql/migrator");
    const { db, initAutoMigrations, initDb } = await import("../src/db");
    await initDb();
    const { chatLogs, users } = await import("../src/db/schema");
    const migrationsFolder = path.resolve(process.cwd(), "drizzle");
    await migrate(db, { migrationsFolder });
    await initAutoMigrations();

    adminUserId = crypto.randomUUID();
    await db.insert(users).values({
      id: adminUserId,
      username: "ctrl-admin",
      passwordHash: "hash",
      role: "admin",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    testChatLogId = crypto.randomUUID();
    await db.insert(chatLogs).values({
      id: testChatLogId,
      requestId: crypto.randomUUID(),
      turnId: 0,
      userId: adminUserId,
      inputText: JSON.stringify({
        messages: [{ role: "user", content: "hello test pause controls" }],
      }),
      outputText: "world",
      status: "success",
      model: "test-model",
      createdAt: new Date(),
    });

    const secret = "test-secret-key-1234567890123456";
    fastify = Fastify();
    await fastify.register(cookie);
    await fastify.register(jwt, {
      secret,
      cookie: { cookieName: "token", signed: false },
    });
    adminToken = fastify.jwt.sign({
      id: adminUserId,
      role: "admin",
      username: "ctrl-admin",
    });

    const distillationRoutes = (await import("../src/routes/distillation")).default;
    await fastify.register(distillationRoutes);
  }, 60000);

  it("createDistillationJob blocks if any job has status pending, running, or paused", async () => {
    const { db } = await import("../src/db");
    const { distillationJobs } = await import("../src/db/schema");
    const { createDistillationJob } = await import(
      "../src/services/distillation/jobService"
    );

    const testJobId = crypto.randomUUID();

    // 1. Pending job blocks create
    await db.insert(distillationJobs).values({
      id: testJobId,
      mode: "incremental",
      status: "pending",
      generationId: crypto.randomUUID(),
      createdAt: new Date(),
    });

    await expect(
      createDistillationJob({ mode: "incremental" }),
    ).rejects.toThrow(/already active \(pending:/);

    // 2. Running job blocks create
    await db
      .update(distillationJobs)
      .set({ status: "running" })
      .where(await import("drizzle-orm").then((m) => m.eq(distillationJobs.id, testJobId)));

    await expect(
      createDistillationJob({ mode: "incremental" }),
    ).rejects.toThrow(/already active \(running:/);

    // 3. Paused job blocks create
    await db
      .update(distillationJobs)
      .set({ status: "paused" })
      .where(await import("drizzle-orm").then((m) => m.eq(distillationJobs.id, testJobId)));

    await expect(
      createDistillationJob({ mode: "incremental" }),
    ).rejects.toThrow(/already active \(paused:/);

    // Clean up test job to cancelled so next tests can proceed
    await db
      .update(distillationJobs)
      .set({ status: "cancelled", completedAt: new Date() })
      .where(await import("drizzle-orm").then((m) => m.eq(distillationJobs.id, testJobId)));
  });

  it("pause only allows pending or running, rejects invalid states", async () => {
    const { db } = await import("../src/db");
    const { distillationJobs } = await import("../src/db/schema");
    const {
      pauseDistillationJob,
      getDistillationJob,
    } = await import("../src/services/distillation/jobService");
    const { eq } = await import("drizzle-orm");

    // Non-existent
    await expect(pauseDistillationJob("non-existent-job")).rejects.toThrow(
      "Job not found",
    );

    const jobId = crypto.randomUUID();
    await db.insert(distillationJobs).values({
      id: jobId,
      mode: "incremental",
      status: "pending",
      generationId: crypto.randomUUID(),
      createdAt: new Date(),
    });

    // Pause from pending -> OK, no completedAt
    await pauseDistillationJob(jobId);
    let job = await getDistillationJob(jobId);
    expect(job?.status).toBe("paused");
    expect(job?.completedAt).toBeNull();

    // Pause from paused -> rejected
    await expect(pauseDistillationJob(jobId)).rejects.toThrow(
      'Cannot pause job with status "paused"',
    );

    // Flip to running -> pause is OK
    await db
      .update(distillationJobs)
      .set({ status: "running" })
      .where(eq(distillationJobs.id, jobId));
    await pauseDistillationJob(jobId);
    job = await getDistillationJob(jobId);
    expect(job?.status).toBe("paused");
    expect(job?.completedAt).toBeNull();

    // Flip to completed -> rejected
    await db
      .update(distillationJobs)
      .set({ status: "completed", completedAt: new Date() })
      .where(eq(distillationJobs.id, jobId));
    await expect(pauseDistillationJob(jobId)).rejects.toThrow(
      'Cannot pause job with status "completed"',
    );

    // Flip to cancelled -> rejected
    await db
      .update(distillationJobs)
      .set({ status: "cancelled" })
      .where(eq(distillationJobs.id, jobId));
    await expect(pauseDistillationJob(jobId)).rejects.toThrow(
      'Cannot pause job with status "cancelled"',
    );
  });

  it("resume only allows paused, rejects other states", async () => {
    const { db } = await import("../src/db");
    const { distillationJobs } = await import("../src/db/schema");
    const {
      resumeDistillationJob,
      getDistillationJob,
    } = await import("../src/services/distillation/jobService");
    const { eq } = await import("drizzle-orm");

    // Non-existent
    await expect(resumeDistillationJob("non-existent-job")).rejects.toThrow(
      "Job not found",
    );

    const jobId = crypto.randomUUID();
    await db.insert(distillationJobs).values({
      id: jobId,
      mode: "incremental",
      status: "pending",
      generationId: crypto.randomUUID(),
      createdAt: new Date(),
    });

    // Resume from pending -> rejected
    await expect(resumeDistillationJob(jobId)).rejects.toThrow(
      'Cannot resume job with status "pending"',
    );

    // Resume from running -> rejected
    await db
      .update(distillationJobs)
      .set({ status: "running" })
      .where(eq(distillationJobs.id, jobId));
    await expect(resumeDistillationJob(jobId)).rejects.toThrow(
      'Cannot resume job with status "running"',
    );

    // Resume from completed -> rejected
    await db
      .update(distillationJobs)
      .set({ status: "completed" })
      .where(eq(distillationJobs.id, jobId));
    await expect(resumeDistillationJob(jobId)).rejects.toThrow(
      'Cannot resume job with status "completed"',
    );

    // Resume from cancelled -> rejected
    await db
      .update(distillationJobs)
      .set({ status: "cancelled" })
      .where(eq(distillationJobs.id, jobId));
    await expect(resumeDistillationJob(jobId)).rejects.toThrow(
      'Cannot resume job with status "cancelled"',
    );

    // Resume from paused -> succeeds
    await db
      .update(distillationJobs)
      .set({ status: "paused" })
      .where(eq(distillationJobs.id, jobId));
    await resumeDistillationJob(jobId);
    const job = await getDistillationJob(jobId);
    expect(["pending", "running"]).toContain(job?.status);

    // Clean up
    await db
      .update(distillationJobs)
      .set({ status: "cancelled", completedAt: new Date() })
      .where(eq(distillationJobs.id, jobId));
  });

  it("cancel works for pending, running, and paused; rejects terminal states", async () => {
    const { db } = await import("../src/db");
    const { distillationJobs } = await import("../src/db/schema");
    const {
      cancelDistillationJob,
      getDistillationJob,
    } = await import("../src/services/distillation/jobService");
    const { eq } = await import("drizzle-orm");

    // Non-existent
    await expect(cancelDistillationJob("non-existent-job")).rejects.toThrow(
      "Job not found",
    );

    // Cancel pending
    const id1 = crypto.randomUUID();
    await db.insert(distillationJobs).values({
      id: id1,
      mode: "incremental",
      status: "pending",
      generationId: crypto.randomUUID(),
      createdAt: new Date(),
    });
    await cancelDistillationJob(id1);
    const job1 = await getDistillationJob(id1);
    expect(job1?.status).toBe("cancelled");
    expect(job1?.completedAt).toBeInstanceOf(Date);

    // Cancel running
    const id2 = crypto.randomUUID();
    await db.insert(distillationJobs).values({
      id: id2,
      mode: "incremental",
      status: "running",
      generationId: crypto.randomUUID(),
      createdAt: new Date(),
    });
    await cancelDistillationJob(id2);
    const job2 = await getDistillationJob(id2);
    expect(job2?.status).toBe("cancelled");
    expect(job2?.completedAt).toBeInstanceOf(Date);

    // Cancel paused
    const id3 = crypto.randomUUID();
    await db.insert(distillationJobs).values({
      id: id3,
      mode: "incremental",
      status: "paused",
      generationId: crypto.randomUUID(),
      createdAt: new Date(),
    });
    await cancelDistillationJob(id3);
    const job3 = await getDistillationJob(id3);
    expect(job3?.status).toBe("cancelled");
    expect(job3?.completedAt).toBeInstanceOf(Date);

    // Cancel already cancelled -> rejected
    await expect(cancelDistillationJob(id3)).rejects.toThrow(
      'Cannot cancel job with status "cancelled"',
    );

    // Cancel completed -> rejected
    const id4 = crypto.randomUUID();
    await db.insert(distillationJobs).values({
      id: id4,
      mode: "incremental",
      status: "completed",
      completedAt: new Date(),
      generationId: crypto.randomUUID(),
      createdAt: new Date(),
    });
    await expect(cancelDistillationJob(id4)).rejects.toThrow(
      'Cannot cancel job with status "completed"',
    );
  });

  it("worker pause, resume, and cancel lifecycle", async () => {
    const { db } = await import("../src/db");
    const {
      distillationJobs,
      distillationJobItems,
      distillationSkillPackages,
      chatLogs,
    } = await import("../src/db/schema");
    const {
      pauseDistillationJob,
      resumeDistillationJob,
      getDistillationJob,
    } = await import("../src/services/distillation/jobService");
    const { setDistillationAnalyzer, startDistillationWorker } = await import(
      "../src/services/distillation/worker"
    );
    const { eq } = await import("drizzle-orm");

    // Custom analyzer with controlled delay
    setDistillationAnalyzer({
      analyze: async () => {
        await new Promise((r) => setTimeout(r, 60));
        return {
          routing: { action: "confirm", adjustments: [] },
          skill: {
            capability: ["skill fragment"],
            heuristic: [],
            workflow: [],
            persona: [],
          },
        };
      },
    });

    const jobId = crypto.randomUUID();
    const generationId = crypto.randomUUID();
    const now = new Date();

    await db.insert(distillationJobs).values({
      id: jobId,
      mode: "incremental",
      status: "pending",
      totalItems: 3,
      processedItems: 0,
      failedItems: 0,
      generationId,
      createdAt: now,
    });

    for (let i = 0; i < 3; i++) {
      const logId = crypto.randomUUID();
      await db.insert(chatLogs).values({
        id: logId,
        requestId: crypto.randomUUID(),
        turnId: 0,
        userId: adminUserId,
        inputText: "test input",
        outputText: "test output",
        status: "success",
        createdAt: now,
      });

      await db.insert(distillationJobItems).values({
        id: crypto.randomUUID(),
        jobId,
        chatLogId: logId,
        userId: adminUserId,
        status: "pending",
        createdAt: now,
      });
    }

    // Start worker
    startDistillationWorker(jobId);

    // Give it a tiny moment to pick up item 1
    await new Promise((r) => setTimeout(r, 20));

    // Pause worker
    await pauseDistillationJob(jobId);

    // Wait for in-flight item to finish and worker to exit
    await new Promise((r) => setTimeout(r, 250));

    let job = await getDistillationJob(jobId);
    expect(job?.status).toBe("paused");
    expect(job?.completedAt).toBeNull();

    // Check items: some items are pending
    const items = await db
      .select()
      .from(distillationJobItems)
      .where(eq(distillationJobItems.jobId, jobId));
    const pendingCount = items.filter((i) => i.status === "pending").length;
    expect(pendingCount).toBeGreaterThan(0);

    // No skill packages published yet
    const skillsWhilePaused = await db
      .select()
      .from(distillationSkillPackages)
      .where(eq(distillationSkillPackages.jobId, jobId));
    expect(skillsWhilePaused.length).toBe(0);

    // Resume worker
    await resumeDistillationJob(jobId);

    // Wait for worker to finish remaining items naturally
    await new Promise((r) => setTimeout(r, 600));

    job = await getDistillationJob(jobId);
    expect(job?.status).toBe("completed");
    expect(job?.completedAt).toBeInstanceOf(Date);

    // Skills are now consolidated and published
    const skillsAfterResume = await db
      .select()
      .from(distillationSkillPackages)
      .where(eq(distillationSkillPackages.jobId, jobId));
    expect(skillsAfterResume.length).toBe(1);
  });

  it("HTTP routes: pause, resume, and cancel endpoints", async () => {
    const { db } = await import("../src/db");
    const { distillationJobs } = await import("../src/db/schema");

    const jobId = crypto.randomUUID();
    await db.insert(distillationJobs).values({
      id: jobId,
      mode: "incremental",
      status: "pending",
      generationId: crypto.randomUUID(),
      createdAt: new Date(),
    });

    // 1. Pause via HTTP
    const pauseRes = await fastify.inject({
      method: "POST",
      url: `/api/admin/distillation/jobs/${jobId}/pause`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(pauseRes.statusCode).toBe(200);
    expect(pauseRes.json()).toEqual({ ok: true });

    // 2. Pause again returns 409
    const pauseAgainRes = await fastify.inject({
      method: "POST",
      url: `/api/admin/distillation/jobs/${jobId}/pause`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(pauseAgainRes.statusCode).toBe(409);

    // 3. Resume via HTTP
    const resumeRes = await fastify.inject({
      method: "POST",
      url: `/api/admin/distillation/jobs/${jobId}/resume`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(resumeRes.statusCode).toBe(200);
    expect(resumeRes.json()).toEqual({ ok: true });

    // 4. Cancel via HTTP on a pending job
    const cancelJobId = crypto.randomUUID();
    await db.insert(distillationJobs).values({
      id: cancelJobId,
      mode: "incremental",
      status: "pending",
      generationId: crypto.randomUUID(),
      createdAt: new Date(),
    });

    const cancelRes = await fastify.inject({
      method: "POST",
      url: `/api/admin/distillation/jobs/${cancelJobId}/cancel`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(cancelRes.statusCode).toBe(200);
    expect(cancelRes.json()).toEqual({ ok: true });

    // 5. Cancel again returns 409
    const cancelAgainRes = await fastify.inject({
      method: "POST",
      url: `/api/admin/distillation/jobs/${cancelJobId}/cancel`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(cancelAgainRes.statusCode).toBe(409);

    // 6. Nonexistent job returns 404
    const notFoundRes = await fastify.inject({
      method: "POST",
      url: `/api/admin/distillation/jobs/does-not-exist/pause`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(notFoundRes.statusCode).toBe(404);
  });
});
