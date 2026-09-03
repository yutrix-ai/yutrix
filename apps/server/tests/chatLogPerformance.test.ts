import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import { initTestDatabase, closeAndCleanup } from "./helpers/testDatabase";
import {
  getSessions,
  getRequests,
  getSessionTurns,
  getUsers,
  getModels,
} from "../src/controllers/chatLogController";

const dbFile = `data/promptgate-test-chatlog-perf-${crypto.randomUUID()}.sqlite`;

function mockReq(query: Record<string, any> = {}, params: Record<string, any> = {}) {
  return { query, params, raw: { on() {} } } as any;
}
function mockReply() {
  return {
    header() { return this; },
    send(v: any) { return v; },
  } as any;
}

describe("Chat log list performance (bounded scan + truncated preview)", () => {
  let db: any;
  let client: any;
  let chatLogs: any;
  let users: any;
  let providerModels: any;

  beforeAll(async () => {
    ({ db, client } = await initTestDatabase({ dbFilePath: dbFile }));
    const schema = await import("../src/db/schema");
    chatLogs = schema.chatLogs;
    users = schema.users;
    providerModels = schema.providerModels;

    const now = Date.now();
    await db.insert(users).values([
      {
        id: "user-perf-1",
        username: "perf-user-1",
        passwordHash: "x",
        role: "user",
        status: "active",
        createdAt: new Date(now),
        updatedAt: new Date(now),
      },
      {
        id: "user-perf-deleted",
        username: "perf-deleted",
        passwordHash: "x",
        role: "user",
        status: "deleted",
        createdAt: new Date(now),
        updatedAt: new Date(now),
      },
    ]);

    await db.insert(providerModels).values({
      id: "pm-perf-1",
      providerId: "prov-perf",
      modelId: "gpt-perf-test",
      displayName: "GPT Perf",
      enabled: true,
      active: true,
      createdAt: new Date(now),
    });

    // Seed many sessions with large blobs to exercise scan + truncation
    const rows: any[] = [];
    const bigInput = "IN_" + "A".repeat(4000);
    const bigOutput = "OUT_" + "B".repeat(4000);
    for (let s = 0; s < 40; s++) {
      const sid = `sess-${String(s).padStart(3, "0")}`;
      for (let t = 0; t < 3; t++) {
        rows.push({
          id: crypto.randomUUID(),
          requestId: crypto.randomUUID(),
          serverSessionId: sid,
          clientSessionId: `client-${s}`,
          turnId: t,
          userId: "user-perf-1",
          clientName: "perf-client",
          detectedClient: "perf",
          model: s % 2 === 0 ? "gpt-perf-test" : "other-model",
          inputText: bigInput,
          outputText: bigOutput,
          inputTokens: 10,
          outputTokens: 20,
          latencyMs: 5,
          sessionTitle: s % 5 === 0 ? `Title ${s}` : null,
          createdAt: new Date(now - s * 60_000 - t * 1000),
        });
      }
    }
    // Insert in chunks
    for (let i = 0; i < rows.length; i += 40) {
      await db.insert(chatLogs).values(rows.slice(i, i + 40));
    }
  }, 60000);

  afterAll(async () => {
    await closeAndCleanup(client, dbFile);
  });

  it("getSessions uses bounded scan and returns paginated sessions with truncated firstInputText", async () => {
    const result = await getSessions(
      mockReq({ page: "1", limit: "10" }),
      mockReply(),
    );

    expect(result.data.length).toBeLessThanOrEqual(10);
    expect(result.pagination.hasMore).toBe(true);
    expect(result.pagination.rowsScanned).toBeGreaterThan(0);
    expect(result.pagination.rowsScanned).toBeLessThanOrEqual(20000);

    for (const session of result.data) {
      if (session.firstInputText) {
        expect(session.firstInputText.length).toBeLessThanOrEqual(500);
      }
    }

    // Most recent sessions first
    expect(result.data[0].serverSessionId).toBe("sess-000");
  });

  it("getSessions page 2 continues from bounded scan without full-table GROUP BY", async () => {
    const page1 = await getSessions(mockReq({ page: "1", limit: "5" }), mockReply());
    const page2 = await getSessions(mockReq({ page: "2", limit: "5" }), mockReply());

    expect(page1.data.length).toBe(5);
    expect(page2.data.length).toBe(5);
    const ids1 = new Set(page1.data.map((s: any) => s.serverSessionId));
    for (const s of page2.data) {
      expect(ids1.has(s.serverSessionId)).toBe(false);
    }
  });

  it("getRequests truncates input/output previews and uses hasMore instead of full COUNT", async () => {
    const result = await getRequests(
      mockReq({ page: "1", limit: "15" }),
      mockReply(),
    );

    expect(result.data.length).toBe(15);
    expect(result.pagination.hasMore).toBe(true);
    for (const row of result.data) {
      if (row.inputText) expect(row.inputText.length).toBeLessThanOrEqual(500);
      if (row.outputText) expect(row.outputText.length).toBeLessThanOrEqual(500);
    }
  });

  it("getUsers reads users table (excludes deleted) without scanning chat_logs", async () => {
    const result = await getUsers(mockReq(), mockReply());
    const ids = result.data.map((u: any) => u.id);
    expect(ids).toContain("user-perf-1");
    expect(ids).not.toContain("user-perf-deleted");
  });

  it("getModels uses provider_models + recent slice (includes enabled model)", async () => {
    const result = await getModels(mockReq(), mockReply());
    expect(result.data).toContain("gpt-perf-test");
  });

  it("getSessionTurns returns full-fidelity text for a specific session", async () => {
    const result = await getSessionTurns(
      mockReq({}, { sessionId: "sess-000" }),
      mockReply(),
    );
    expect(result.data.length).toBeGreaterThanOrEqual(1);
    const turn = result.data[0];
    expect(turn.inputText.length).toBeGreaterThan(500);
    expect(turn.outputText.length).toBeGreaterThan(500);
  });
});
