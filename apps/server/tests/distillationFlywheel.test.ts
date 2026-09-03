import { describe, it, expect, beforeAll } from "vitest";
import crypto from "crypto";
import path from "path";
import fs from "fs";

const testDb = `data/promptgate_distillation_test_${crypto.randomUUID()}.sqlite`;
process.env.DB_FILE = testDb;

describe("distillation flywheel integration", () => {
  beforeAll(async () => {
    const { migrate } = await import("drizzle-orm/libsql/migrator");
    const { db, initAutoMigrations, initDb } = await import("../src/db");
    await initDb();
    const { chatLogs, users } = await import("../src/db/schema");
    const migrationsFolder = path.resolve(process.cwd(), "drizzle");
    await migrate(db, { migrationsFolder });
    await initAutoMigrations();

    const userId = crypto.randomUUID();
    await db.insert(users).values({
      id: userId,
      username: "flywheel-user",
      passwordHash: "x",
      role: "user",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await db.insert(chatLogs).values({
      id: crypto.randomUUID(),
      requestId: crypto.randomUUID(),
      turnId: 0,
      userId,
      inputText: JSON.stringify({
        messages: [{ role: "user", content: "fix this error stack trace exception" }],
      }),
      outputText: "done",
      status: "error",
      error: "timeout",
      model: "test-model",
      createdAt: new Date(),
    });

    const { setDistillationAnalyzer } = await import("../src/services/distillation/worker");
    const { HeuristicDistillationAnalyzer } = await import(
      "../src/services/distillation/analyzer"
    );
    setDistillationAnalyzer(new HeuristicDistillationAnalyzer());

    (globalThis as any).__distillationTestUserId = userId;
  }, 60000);

  it("runs job, validates proposals, applies routing overlay, produces skill", async () => {
    const { createDistillationJob, validateDraftProposals, applyValidatedProposals, listSkillPackages, getLatestSkillPackage } =
      await import("../src/services/distillation/jobService");
    const { ROUTING_WEIGHTS } = await import("../src/services/strategyRouting");
    const { applyRoutingWeightOverlay } = await import(
      "../src/services/distillation/routingWeightsBridge"
    );

    const { jobId } = await createDistillationJob({ mode: "incremental" });
    expect(jobId).toBeTruthy();

    await new Promise((r) => setTimeout(r, 2000));

    const validation = await validateDraftProposals();
    expect(validation.proposalCount).toBeGreaterThan(0);

    if (validation.ok) {
      const applied = await applyValidatedProposals();
      expect(applied.versionLabel).toMatch(/^flywheel-/);
      const debugWeights = applyRoutingWeightOverlay("debug", ROUTING_WEIGHTS.debug);
      expect(debugWeights.error).toBeGreaterThan(ROUTING_WEIGHTS.debug.error);
    }

    const skills = await listSkillPackages();
    expect(skills.length).toBeGreaterThan(0);
    const pkg = await getLatestSkillPackage(skills[0]!.userId);
    expect(pkg?.files).toContain("SKILL.md");
  }, 30000);
});
