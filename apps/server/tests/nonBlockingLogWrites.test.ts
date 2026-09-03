import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import crypto from "crypto";
import { eq } from "drizzle-orm";
import { initTestDatabase, closeAndCleanup } from "./helpers/testDatabase";
import {
  insertRequestLog,
  updateRequestLog,
  flushRequestLogQueue,
} from "../src/services/requestLogService";
import {
  insertInitialRequestLog,
  finalizeStreamLog,
  emitAuditEvent,
} from "../src/routes/gateway/logging";
import { logEmitter } from "../src/utils/events";

const dbFile = `data/promptgate-test-nonblocking-${crypto.randomUUID()}.sqlite`;

describe("Non-blocking log writes & reliable background flush", () => {
  let db: any;
  let client: any;
  let realDb: any;
  let requestLogs: any;
  let chatLogs: any;

  beforeAll(async () => {
    ({ db, client } = await initTestDatabase({ dbFilePath: dbFile }));
    const dbMod = await import("../src/db");
    realDb = dbMod.getDb();
    const schema = await import("../src/db/schema");
    requestLogs = schema.requestLogs;
    chatLogs = schema.chatLogs;
    // Ensure chatLogService listener is active
    await import("../src/services/chatLogService");
  });

  afterAll(async () => {
    await flushRequestLogQueue();
    await closeAndCleanup(client, dbFile);
  });

  it("insertInitialRequestLog does not await DB insert (enqueue returns before DB resolves)", async () => {
    const reqId = crypto.randomUUID();
    const mockCtx: any = {
      reqLogId: reqId,
      baseActionLog: { requestId: reqId, ip: "127.0.0.1" },
      auth: { userId: "user-nb-1", apiKeyRecord: { id: "key-1" } },
      routing: { endpoint: { id: "ep-1" }, subdomainRecord: null },
      currentAttempt: { providerProtocol: "openai", modelId: "gpt-4o" },
      activeModelConfig: null,
      request: { headers: {} },
      isStreaming: false,
      isLogInserted: false,
    };

    let dbInsertResolved = false;
    let finishDbInsert: () => void = () => {};
    const deferredDbPromise = new Promise<void>((resolve) => {
      finishDbInsert = () => {
        dbInsertResolved = true;
        resolve();
      };
    });

    const origInsert = realDb.insert.bind(realDb);
    // Intercept db.insert on the underlying database to artificially delay the DB write
    const insertSpy = vi.spyOn(realDb, "insert").mockImplementation((table: any) => {
      if (table === requestLogs) {
        return {
          values: (vals: any) => ({
            then: async (onFulfilled: any, onRejected: any) => {
              await deferredDbPromise;
              return origInsert(table).values(vals).then(onFulfilled, onRejected);
            },
          }),
        } as any;
      }
      return origInsert(table);
    });

    const baseLog = {
      id: reqId,
      requestId: reqId,
      userId: "user-nb-1",
      model: "gpt-4o",
      createdAt: new Date(),
    };

    const startTime = Date.now();
    // Call insertInitialRequestLog on the hot path
    insertInitialRequestLog(mockCtx, baseLog);
    const elapsed = Date.now() - startTime;

    // Must return immediately without waiting for DB insert
    expect(elapsed).toBeLessThan(50);
    expect(mockCtx.isLogInserted).toBe(true);
    expect(dbInsertResolved).toBe(false);

    // Now let the background DB write resolve
    finishDbInsert();
    insertSpy.mockRestore();

    await flushRequestLogQueue();

    // Verify row eventually landed in DB
    const rows = await db.select().from(requestLogs).where(eq(requestLogs.id, reqId));
    expect(rows.length).toBe(1);
    expect(rows[0].usageStatus).toBe("queued");
  });

  it("finalizeStreamLog does not await DB update on the streaming completion path", async () => {
    const reqId = crypto.randomUUID();
    // First, insert an initial log and flush so the row exists
    await insertRequestLog({
      id: reqId,
      requestId: reqId,
      userId: "user-nb-stream",
      model: "gpt-4o",
      usageStatus: "queued",
      createdAt: new Date(),
    });
    await flushRequestLogQueue();

    let dbUpdateResolved = false;
    let finishDbUpdate: () => void = () => {};
    const deferredUpdatePromise = new Promise<void>((resolve) => {
      finishDbUpdate = () => {
        dbUpdateResolved = true;
        resolve();
      };
    });

    const origUpdate = realDb.update.bind(realDb);
    const updateSpy = vi.spyOn(realDb, "update").mockImplementation((table: any) => {
      if (table === requestLogs) {
        return {
          set: (patch: any) => ({
            where: (cond: any) => ({
              execute: async () => {
                await deferredUpdatePromise;
                return origUpdate(table).set(patch).where(cond).execute();
              },
            }),
          }),
        } as any;
      }
      return origUpdate(table);
    });

    const mockCtx: any = {
      reqLogId: reqId,
      baseActionLog: { requestId: reqId, ip: "127.0.0.1" },
      auth: { userId: "user-nb-stream", providedKey: "pk-1", apiKeyRecord: { id: "k-1", name: "Key" } },
      routing: { endpoint: { id: "ep-1" }, reqPath: "/v1/chat/completions" },
      currentAttempt: { modelId: "gpt-4o" },
      request: { headers: {} },
      body: { prompt: "hi" },
      startTime: Date.now(),
      stream: {
        streamedUsagePayload: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        promptTokens: 10,
        completionTokens: 5,
        accumulatedCompletionText: "streamed response",
        accumulatedReasoningText: "",
        accumulatedToolArgs: {},
        ttft: 45,
      },
      continuity: {
        promptTokens: 10,
        completionTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        accumulatedCompletionText: "streamed response",
        usageStatus: "success",
      },
      routingTrace: [],
      isLogInserted: true,
      calculateCostForTokens: () => 0.001,
    };

    const startTime = Date.now();
    const summary = await finalizeStreamLog(mockCtx, 200, { usageStatus: "success" });
    const elapsed = Date.now() - startTime;

    // finalizeStreamLog returns summary tokens immediately without awaiting DB
    expect(elapsed).toBeLessThan(50);
    expect(summary.promptTokens).toBe(10);
    expect(summary.completionTokens).toBe(5);
    expect(dbUpdateResolved).toBe(false);

    // Unblock the background update
    finishDbUpdate();
    updateSpy.mockRestore();

    await flushRequestLogQueue();

    const rows = await db.select().from(requestLogs).where(eq(requestLogs.id, reqId));
    expect(rows.length).toBe(1);
    expect(rows[0].usageStatus).toBe("success");
    expect(rows[0].statusCode).toBe(200);
  });

  it("chat log insert via logEmitter does not block caller and eventually lands in DB", async () => {
    const reqId = crypto.randomUUID();
    const clientSessionId = `test-sess-${crypto.randomUUID()}`;

    const startTime = Date.now();
    logEmitter.emit("chatLogInsert", {
      id: reqId,
      requestId: reqId,
      serverSessionId: reqId,
      clientSessionId,
      turnId: 0,
      userId: "user-chat-nb",
      clientName: "Test Client",
      model: "gpt-4o",
      inputText: JSON.stringify({ messages: [{ role: "user", content: "hello non-blocking" }] }),
      outputText: "world",
      inputTokens: 5,
      outputTokens: 2,
      latencyMs: 100,
      status: "success",
      createdAt: new Date().toISOString(),
    });
    const emitElapsed = Date.now() - startTime;

    // Emitting chatLogInsert returns synchronously in 0ms
    expect(emitElapsed).toBeLessThan(20);

    // Poll until background worker persists the row
    const deadline = Date.now() + 3000;
    let foundRow: any = null;
    while (Date.now() < deadline) {
      const rows = await db.select().from(chatLogs).where(eq(chatLogs.requestId, reqId));
      if (rows.length > 0) {
        foundRow = rows[0];
        break;
      }
      await new Promise((r) => setTimeout(r, 25));
    }

    expect(foundRow).not.toBeNull();
    expect(foundRow.outputText).toBe("world");
    expect(foundRow.clientSessionId).toBe(clientSessionId);
  });

  it("retries request log DB write once on transient error without throwing into caller", async () => {
    const reqId = crypto.randomUUID();
    let attempts = 0;

    const origInsert = realDb.insert.bind(realDb);
    const spy = vi.spyOn(realDb, "insert").mockImplementation((table: any) => {
      if (table === requestLogs) {
        attempts++;
        if (attempts === 1) {
          return {
            values: () => Promise.reject(new Error("Simulated transient DB error")),
          } as any;
        }
      }
      return origInsert(table);
    });

    // Caller does not wait and does not catch any error
    await expect(
      insertRequestLog({
        id: reqId,
        requestId: reqId,
        userId: "user-retry-test",
        model: "gpt-4o",
        usageStatus: "success",
        createdAt: new Date(),
      })
    ).resolves.toBeUndefined();

    await flushRequestLogQueue();
    spy.mockRestore();

    expect(attempts).toBe(2); // Attempted first, failed, retried once, succeeded
    const rows = await db.select().from(requestLogs).where(eq(requestLogs.id, reqId));
    expect(rows.length).toBe(1);
    expect(rows[0].userId).toBe("user-retry-test");
  });

  it("burst writes: never drops under pressure, all rows reliably flush", async () => {
    const burstCount = 50;
    const ids: string[] = [];

    for (let i = 0; i < burstCount; i++) {
      const id = crypto.randomUUID();
      ids.push(id);
      void insertRequestLog({
        id,
        requestId: id,
        userId: "user-burst",
        model: "burst-model",
        statusCode: 200,
        latencyMs: i,
        usageStatus: "success",
        createdAt: new Date(),
      });
    }

    // Wait for the background worker to flush all writes
    await flushRequestLogQueue();

    // Verify 100% of rows landed without any drop
    const rows = await db.select().from(requestLogs).where(eq(requestLogs.userId, "user-burst"));
    expect(rows.length).toBe(burstCount);
  });

  it("chat log insert retries once on transient failure and still lands", async () => {
    const reqId = crypto.randomUUID();
    let chatAttempts = 0;

    const origInsert = realDb.insert.bind(realDb);
    const spy = vi.spyOn(realDb, "insert").mockImplementation((table: any) => {
      if (table === chatLogs) {
        chatAttempts++;
        if (chatAttempts === 1) {
          return {
            values: () => Promise.reject(new Error("Transient chat DB error")),
          } as any;
        }
      }
      return origInsert(table);
    });

    logEmitter.emit("chatLogInsert", {
      id: reqId,
      requestId: reqId,
      serverSessionId: reqId,
      clientSessionId: `retry-sess-${reqId}`,
      turnId: 0,
      userId: "user-chat-retry",
      clientName: "Retry Client",
      model: "gpt-4o",
      inputText: "test retry",
      outputText: "retry ok",
      inputTokens: 1,
      outputTokens: 1,
      latencyMs: 10,
      status: "success",
      createdAt: new Date().toISOString(),
    });

    // Wait for the retry to succeed and row to land
    const deadline = Date.now() + 3000;
    let foundRow: any = null;
    while (Date.now() < deadline) {
      const rows = await db.select().from(chatLogs).where(eq(chatLogs.requestId, reqId));
      if (rows.length > 0) {
        foundRow = rows[0];
        break;
      }
      await new Promise((r) => setTimeout(r, 30));
    }

    spy.mockRestore();

    expect(chatAttempts).toBe(2);
    expect(foundRow).not.toBeNull();
    expect(foundRow.outputText).toBe("retry ok");
  });

  it("chat logs preserve turn ordering within the same clientSessionId in the background", async () => {
    const sessId = `ordered-session-${crypto.randomUUID()}`;
    const req1 = crypto.randomUUID();
    const req2 = crypto.randomUUID();

    // Emit turn 0 and turn 1 in quick succession
    logEmitter.emit("chatLogInsert", {
      id: req1,
      requestId: req1,
      serverSessionId: req1,
      clientSessionId: sessId,
      turnId: 0,
      userId: "user-ordered",
      clientName: "Order Client",
      model: "gpt-4o",
      inputText: "turn 0 question",
      outputText: "turn 0 answer",
      inputTokens: 5,
      outputTokens: 5,
      latencyMs: 20,
      status: "success",
      createdAt: new Date(Date.now() - 1000).toISOString(),
    });

    logEmitter.emit("chatLogInsert", {
      id: req2,
      requestId: req2,
      serverSessionId: req1,
      clientSessionId: sessId,
      turnId: 1,
      userId: "user-ordered",
      clientName: "Order Client",
      model: "gpt-4o",
      inputText: "turn 1 question",
      outputText: "turn 1 answer",
      inputTokens: 5,
      outputTokens: 5,
      latencyMs: 20,
      status: "success",
      createdAt: new Date().toISOString(),
    });

    // Wait until both turns land
    const deadline = Date.now() + 3000;
    let rows: any[] = [];
    while (Date.now() < deadline) {
      rows = await db.select().from(chatLogs).where(eq(chatLogs.clientSessionId, sessId));
      if (rows.length >= 2) break;
      await new Promise((r) => setTimeout(r, 30));
    }

    expect(rows.length).toBe(2);
    rows.sort((a, b) => a.turnId - b.turnId);
    expect(rows[0].outputText).toBe("turn 0 answer");
    expect(rows[1].outputText).toBe("turn 1 answer");
    expect(rows[0].turnId).toBe(0);
    expect(rows[1].turnId).toBe(1);
  });
});
