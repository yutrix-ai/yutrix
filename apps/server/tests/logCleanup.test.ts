import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import crypto from "crypto";
import { initTestDatabase, closeAndCleanup } from "./helpers/testDatabase";
import { isLogCleanupEnabled, runLogCleanup } from "../src/utils/logCleanup";

const dbFile = `data/promptgate-test-log-cleanup-${crypto.randomUUID()}.sqlite`;
const DAY = 24 * 60 * 60 * 1000;

describe("runLogCleanup", () => {
  let db: any;
  let client: any;
  let schema: any;
  const now = Date.now();

  beforeAll(async () => {
    ({ db, client } = await initTestDatabase({ dbFilePath: dbFile }));
    schema = await import("../src/db/schema");
  }, 60000);

  afterAll(async () => {
    await closeAndCleanup(client, dbFile);
  });

  beforeEach(async () => {
    await db.delete(schema.requestLogs);
    await db.delete(schema.chatLogs);
    await db.delete(schema.actionLogs);
    await db.delete(schema.systemSettings).where(
      (await import("drizzle-orm")).eq(schema.systemSettings.key, "logRetentionDays"),
    );
  });

  async function setRetention(value: string) {
    await db.insert(schema.systemSettings).values({
      key: "logRetentionDays",
      value,
      createdAt: new Date(now),
      updatedAt: new Date(now),
    });
  }

  async function seed(oldCount: number, newCount: number) {
    const ages = [
      ...Array.from({ length: oldCount }, () => 10 * DAY),
      ...Array.from({ length: newCount }, () => 1 * DAY),
    ];
    const reqRows = ages.map((age) => ({
      id: crypto.randomUUID(),
      requestId: crypto.randomUUID(),
      userId: "u",
      model: "m",
      statusCode: 200,
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      latencyMs: 1,
      createdAt: new Date(now - age),
    }));
    const chatRows = ages.map((age, i) => ({
      id: crypto.randomUUID(),
      requestId: crypto.randomUUID(),
      serverSessionId: `s-${i}`,
      turnId: 1,
      userId: "u",
      model: "m",
      inputText: "in",
      outputText: "out",
      inputTokens: 1,
      outputTokens: 1,
      latencyMs: 1,
      createdAt: new Date(now - age),
    }));
    const actionRows = ages.map((age) => ({
      id: crypto.randomUUID(),
      timestamp: "2026-10-14 00:00:00",
      level: "INFO",
      code: "test",
      serverLine: "line",
      createdAt: new Date(now - age),
    }));
    for (let i = 0; i < ages.length; i += 200) {
      await db.insert(schema.requestLogs).values(reqRows.slice(i, i + 200));
      await db.insert(schema.chatLogs).values(chatRows.slice(i, i + 200));
      await db.insert(schema.actionLogs).values(actionRows.slice(i, i + 200));
    }
  }

  async function counts() {
    return {
      request: (await db.select().from(schema.requestLogs)).length,
      chat: (await db.select().from(schema.chatLogs)).length,
      action: (await db.select().from(schema.actionLogs)).length,
    };
  }

  it("deletes only rows older than the retention window across batches", async () => {
    await setRetention("7");
    await seed(1200, 5);

    const result = await runLogCleanup(now);

    expect(result).toEqual({
      days: 7,
      deleted: { request_logs: 1200, chat_logs: 1200, action_logs: 1200 },
    });
    expect(await counts()).toEqual({ request: 5, chat: 5, action: 5 });
  }, 60000);

  it("does nothing when retention is missing or not positive", async () => {
    await seed(3, 2);
    expect(await runLogCleanup(now)).toBeNull();

    await setRetention("0");
    expect(await runLogCleanup(now)).toBeNull();
    expect(await counts()).toEqual({ request: 5, chat: 5, action: 5 });
  });
});

describe("isLogCleanupEnabled", () => {
  const original = process.env.LOG_CLEANUP_ENABLED;
  afterEach(() => {
    if (original === undefined) delete process.env.LOG_CLEANUP_ENABLED;
    else process.env.LOG_CLEANUP_ENABLED = original;
  });

  it("is on by default and can be turned off", () => {
    delete process.env.LOG_CLEANUP_ENABLED;
    expect(isLogCleanupEnabled()).toBe(true);
    process.env.LOG_CLEANUP_ENABLED = "0";
    expect(isLogCleanupEnabled()).toBe(false);
    process.env.LOG_CLEANUP_ENABLED = "false";
    expect(isLogCleanupEnabled()).toBe(false);
    process.env.LOG_CLEANUP_ENABLED = "1";
    expect(isLogCleanupEnabled()).toBe(true);
  });
});
