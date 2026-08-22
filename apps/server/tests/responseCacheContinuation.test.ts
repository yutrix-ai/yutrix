import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { eq } from "drizzle-orm";
import { initTestDatabase, closeAndCleanup } from "./helpers/testDatabase";
import { normalizeChatLogTurn } from "../src/utils/chatTurns";
import { evaluateResponseCacheWrite } from "../src/services/loopGuard";

const dbFile = "data/promptgate_test_cache_continuation.sqlite";

function continuationBody() {
  return {
    model: "gemini-pro-agent",
    messages: [
      { role: "user", content: "实现接口" },
      { role: "assistant", content: "ok" },
      {
        role: "tool",
        tool_call_id: "call_1",
        content: "grep: ../wx-domain: No such file or directory",
      },
    ],
  };
}

function userIntentBody() {
  return {
    model: "gpt-test",
    messages: [{ role: "user", content: "hello cacheable" }],
  };
}

describe("evaluateResponseCacheWrite (shipped create gate)", () => {
  it("rejects tool_continuation input text", () => {
    const inputText = normalizeChatLogTurn(JSON.stringify(continuationBody()), null).inputText!;
    const gate = evaluateResponseCacheWrite(inputText);
    expect(gate.ok).toBe(false);
    expect(gate.status).toBe(400);
  });

  it("allows a real user_intent input", () => {
    const inputText = normalizeChatLogTurn(JSON.stringify(userIntentBody()), null).inputText!;
    expect(evaluateResponseCacheWrite(inputText).ok).toBe(true);
  });

  it("admin cache route uses the write gate", () => {
    const root = path.resolve(
      process.cwd().endsWith("server") ? process.cwd() : path.join(process.cwd(), "apps/server"),
    );
    const src = fs.readFileSync(path.join(root, "src/routes/cache.ts"), "utf8");
    expect(src).toContain("evaluateResponseCacheWrite");
  });
});

describe("checkAndServeCachedResponse skips tool_continuation", () => {
  let db: any;
  let client: any;
  let responseCache: any;
  let checkAndServeCachedResponse: (...args: any[]) => Promise<boolean>;

  beforeAll(async () => {
    ({ db, client } = await initTestDatabase({ dbFilePath: dbFile }));
    ({ responseCache } = await import("../src/db/schema"));
    ({ checkAndServeCachedResponse } = await import("../src/routes/gateway/cache"));
  });

  afterAll(async () => {
    await closeAndCleanup(client, dbFile);
  });

  it("does not serve a matching cache row for a continuation body", async () => {
    const body = continuationBody();
    const normalized = normalizeChatLogTurn(JSON.stringify(body), null);
    const inputHash = crypto.createHash("md5").update(normalized.inputText as string).digest("hex");
    const now = new Date();
    await db.insert(responseCache).values({
      id: crypto.randomUUID(),
      inputHash,
      inputText: normalized.inputText,
      responseText: "should-not-serve",
      model: "gemini-pro-agent",
      hitCount: 0,
      createdAt: now,
      updatedAt: now,
    });

    const payload: { status?: number; body?: any } = {};
    const served = await checkAndServeCachedResponse(
      { headers: {}, log: { warn() {} } },
      {
        code(status: number) {
          payload.status = status;
          return this;
        },
        send(bodyOut: any) {
          payload.body = bodyOut;
          return this;
        },
        raw: { write() {}, end() {} },
      },
      body,
      {
        providedKey: "pg_test",
        apiKeyRecord: {
          id: "key-1",
          userId: "user-1",
          name: "t",
          keyPrefix: "pg_t",
          concurrencyLimit: 2,
        },
        userId: "user-1",
        isSystemKey: false,
      },
      {
        incomingProtocol: "openai",
        reqPath: "/v1/chat/completions",
        endpoint: { id: "ep" },
        route: { id: "rt", endpointId: "ep" },
        subdomainRecord: null,
      },
      {
        providerId: "prov",
        providerProtocol: "openai",
        modelId: "gemini-pro-agent",
        promptPolicyId: null,
        isFallback: false,
        fallbackReason: "",
        targetIndex: 0,
      },
      {
        requestId: crypto.randomUUID(),
        userId: "user-1",
        apiKeyPrefix: "pg_t",
        host: "localhost",
        path: "/v1/chat/completions",
        routeName: "t",
      },
      Date.now(),
      null,
    );

    expect(served).toBe(false);
    expect(payload.body).toBeUndefined();
  });
});
