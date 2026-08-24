import { beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { classifyGatewayRequestClass } from "../src/services/requestRoutingClass";
import { renderActionLogServerLine } from "../src/utils/actionLogTemplates";
import {
  LOOP_GUARD_DEFAULTS,
  buildLoopStopHttpPayload,
  createLoopGuardStore,
  detectLoopStop,
  fingerprintCurrentTurn,
  inspectContinuationLoop,
  isErrorClassPayload,
  maybeServeContinuationLoopStop,
  resetLoopGuardRuntimeForTests,
} from "../src/services/loopGuard";

function grepToolBody(dir: string, toolCallId: string) {
  const content = JSON.stringify(
    {
      kind: "foreground",
      exitCode: 0,
      signal: null,
      timedOut: false,
      aborted: false,
      timeoutMs: 60000,
      stdout: { text: "", truncated: false },
      stderr: {
        text: `grep: ${dir}: No such file or directory\n`,
        truncated: false,
      },
      sandbox: { mode: "danger-full-access", denied: false },
    },
    null,
    2,
  );
  return {
    model: "gemini-pro-agent",
    messages: [
      { role: "user", content: "实现库存查询接口" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: toolCallId,
            type: "function",
            function: {
              name: "run_code",
              arguments: JSON.stringify({ command: `grep foo ${dir}` }),
            },
          },
        ],
      },
      { role: "tool", tool_call_id: toolCallId, content },
    ],
  };
}

function runningPollBody(toolCallId: string) {
  return {
    messages: [
      { role: "user", content: "watch the job" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: toolCallId,
            type: "function",
            function: { name: "get_status", arguments: "{}" },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: toolCallId,
        content: JSON.stringify({ status: "running" }),
      },
    ],
  };
}

function anthropicGrepToolBody(dir: string, toolUseId: string) {
  const content = JSON.stringify(
    {
      kind: "foreground",
      exitCode: 0,
      stdout: { text: "", truncated: false },
      stderr: {
        text: `grep: ${dir}: No such file or directory\n`,
        truncated: false,
      },
    },
    null,
    2,
  );
  return {
    model: "claude-sonnet-4-5",
    messages: [
      { role: "user", content: "实现库存查询接口" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: toolUseId,
            name: "run_code",
            input: { command: `grep foo ${dir}` },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolUseId,
            content,
          },
        ],
      },
    ],
  };
}

function readFileBody(path: string, toolCallId: string) {
  return {
    messages: [
      { role: "user", content: "implement the API" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: toolCallId,
            type: "function",
            function: {
              name: "read_file",
              arguments: JSON.stringify({ path }),
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: toolCallId,
        content: JSON.stringify({
          path,
          lines: [{ number: 1, text: `package ${path}` }],
        }),
      },
    ],
  };
}

beforeEach(() => {
  resetLoopGuardRuntimeForTests();
});

describe("loop-guard fingerprint + error-class", () => {
  it("strips tool_call_id so the same ENOENT grep hashes equal", () => {
    const a = fingerprintCurrentTurn(grepToolBody("../wx-domain", "call_aaa"));
    const b = fingerprintCurrentTurn(grepToolBody("../wx-domain", "call_bbb"));
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.isErrorClass).toBe(true);
    expect(classifyGatewayRequestClass(grepToolBody("../wx-domain", "call_aaa")).requestClass)
      .toBe("tool_continuation");
  });

  it("strips Anthropic tool_use_id so the same ENOENT grep hashes equal", () => {
    const a = fingerprintCurrentTurn(anthropicGrepToolBody("../wx-domain", "toolu_01AAA"));
    const b = fingerprintCurrentTurn(anthropicGrepToolBody("../wx-domain", "toolu_01BBB"));
    expect(classifyGatewayRequestClass(anthropicGrepToolBody("../wx-domain", "toolu_01AAA")).requestClass)
      .toBe("tool_continuation");
    expect(a.kind).toBe("continuation");
    expect(a.isErrorClass).toBe(true);
    expect(a.fingerprint).toBe(b.fingerprint);
  });

  it("treats exitCode 0 + stderr No such file as error-class", () => {
    const fp = fingerprintCurrentTurn(grepToolBody("../wx-api-client", "call_1"));
    expect(fp.isErrorClass).toBe(true);
    expect(isErrorClassPayload(fp.payload)).toBe(true);
  });

  it("does not treat status:running as error-class", () => {
    const fp = fingerprintCurrentTurn(runningPollBody("call_run"));
    expect(fp.isErrorClass).toBe(false);
  });
});

describe("loop-guard pattern detector (shipped detectLoopStop)", () => {
  it("trips identical error fingerprint at 5, not 4", () => {
    const fp = fingerprintCurrentTurn(grepToolBody("../wx-domain", "call_x"));
    const mk = (i: number) => ({
      kind: "continuation" as const,
      fingerprint: fp.fingerprint,
      isErrorClass: true,
      at: i,
    });
    expect(detectLoopStop([mk(1), mk(2), mk(3), mk(4)], 4)).toBeNull();
    const hit = detectLoopStop([mk(1), mk(2), mk(3), mk(4), mk(5)], 5);
    expect(hit?.reason).toBe("identical_error");
  });

  it("trips ping-pong error fingerprints at 8 half-cycles, not 7", () => {
    const a = fingerprintCurrentTurn(grepToolBody("../wx-api-client", "call_a"));
    const b = fingerprintCurrentTurn(grepToolBody("../wx-domain", "call_b"));
    expect(a.fingerprint).not.toBe(b.fingerprint);
    const seq = [a, b, a, b, a, b, a, b].map((fp, i) => ({
      kind: "continuation" as const,
      fingerprint: fp.fingerprint,
      isErrorClass: true,
      at: i,
    }));
    expect(detectLoopStop(seq.slice(0, 7), 7)).toBeNull();
    expect(detectLoopStop(seq, 8)?.reason).toBe("ping_pong");
  });

  it("does not trip 150 diverse read_file paths", () => {
    const turns = Array.from({ length: 150 }, (_, i) => {
      const fp = fingerprintCurrentTurn(readFileBody(`src/File${i}.java`, `call_${i}`));
      return {
        kind: "continuation" as const,
        fingerprint: fp.fingerprint,
        isErrorClass: fp.isErrorClass,
        at: i,
      };
    });
    expect(new Set(turns.map((t) => t.fingerprint)).size).toBe(150);
    expect(detectLoopStop(turns, 150)).toBeNull();
  });

  it("does not trip identical non-error running polls", () => {
    const fp = fingerprintCurrentTurn(runningPollBody("call_1"));
    const turns = Array.from({ length: 12 }, (_, i) => ({
      kind: "continuation" as const,
      fingerprint: fp.fingerprint,
      isErrorClass: fp.isErrorClass,
      at: i,
    }));
    expect(detectLoopStop(turns, 12)).toBeNull();
  });

  it("trips 400 continuations since last user_intent", () => {
    const turns = [
      { kind: "user_intent" as const, fingerprint: "u", isErrorClass: false, at: 0 },
      ...Array.from({ length: LOOP_GUARD_DEFAULTS.continuationCeiling }, (_, i) => ({
        kind: "continuation" as const,
        fingerprint: `p${i}`,
        isErrorClass: false,
        at: i + 1,
      })),
    ];
    expect(detectLoopStop(turns.slice(0, 400), 399)).toBeNull();
    expect(detectLoopStop(turns, 400)?.reason).toBe("turn_ceiling");
  });

  it("trips 2 hours since last user_intent", () => {
    const twoHours = LOOP_GUARD_DEFAULTS.continuationMaxAgeMs;
    const turns = [
      { kind: "user_intent" as const, fingerprint: "u", isErrorClass: false, at: 0 },
      { kind: "continuation" as const, fingerprint: "c1", isErrorClass: false, at: 10 },
    ];
    expect(detectLoopStop(turns, twoHours - 1)).toBeNull();
    expect(detectLoopStop(turns, twoHours)?.reason).toBe("age_ceiling");
  });
});

describe("inspectContinuationLoop fail-open + sticky trip", () => {
  it("hard-stops ping-pong via the session store and stays stopped on retry", () => {
    const store = createLoopGuardStore();
    const userId = "user-loop";
    const dirs = ["../wx-api-client", "../wx-domain"] as const;
    let last: ReturnType<typeof inspectContinuationLoop> | null = null;
    for (let i = 0; i < 8; i++) {
      last = inspectContinuationLoop({
        userId,
        body: grepToolBody(dirs[i % 2], `call_${i}`),
        store,
        nowMs: i,
      });
    }
    expect(last?.shouldStop).toBe(true);
    expect(last?.reason).toBe("ping_pong");

    const retry = inspectContinuationLoop({
      userId,
      body: grepToolBody("../wx-api-client", "call_retry"),
      store,
      nowMs: 9,
    });
    expect(retry.shouldStop).toBe(true);
    expect(retry.reason).toBe("ping_pong");
  });

  it("hard-stops identical Anthropic tool_result errors at 5 despite unique tool_use_id", () => {
    const store = createLoopGuardStore();
    const userId = "user-anthropic-identical";
    let last: ReturnType<typeof inspectContinuationLoop> | null = null;
    for (let i = 1; i <= 5; i++) {
      last = inspectContinuationLoop({
        userId,
        body: anthropicGrepToolBody("../wx-domain", `toolu_01IDENT${i}`),
        store,
        nowMs: i,
      });
    }
    expect(last?.shouldStop).toBe(true);
    expect(last?.reason).toBe("identical_error");
  });

  it("hard-stops Anthropic ping-pong tool_result errors at 8 half-cycles", () => {
    const store = createLoopGuardStore();
    const userId = "user-anthropic-pong";
    const dirs = ["../wx-api-client", "../wx-domain"] as const;
    let last: ReturnType<typeof inspectContinuationLoop> | null = null;
    for (let i = 0; i < 8; i++) {
      last = inspectContinuationLoop({
        userId,
        body: anthropicGrepToolBody(dirs[i % 2], `toolu_01PONG${i}`),
        store,
        nowMs: i,
      });
    }
    expect(last?.shouldStop).toBe(true);
    expect(last?.reason).toBe("ping_pong");
  });

  it("maybeServeContinuationLoopStop returns 200 stop after a ping-pong trip", () => {
    const userId = `user-serve-${Date.now()}`;
    const dirs = ["../wx-api-client", "../wx-domain"] as const;
    for (let i = 0; i < 8; i++) {
      inspectContinuationLoop({
        userId,
        body: grepToolBody(dirs[i % 2], `call_serve_${i}`),
        nowMs: i,
      });
    }
    const payload: { status?: number; body?: any } = {};
    const served = maybeServeContinuationLoopStop({
      userId,
      body: grepToolBody("../wx-api-client", "call_serve_retry"),
      reply: {
        header() { return this; },
        code(status: number) {
          payload.status = status;
          return this;
        },
        send(bodyOut: any) {
          payload.body = bodyOut;
          return this;
        },
        raw: { headersSent: false, write() {}, end() {}, writeHead() {} },
      },
      incomingProtocol: "openai",
      modelId: "gemini-pro-agent",
    });
    expect(served).toBe(true);
    expect(payload.status).toBe(200);
    expect(payload.body?.choices?.[0]?.finish_reason).toBe("stop");
    expect(payload.status).not.toBe(429);
  });

  it("fails open when the store throws", () => {
    const store = {
      get() {
        throw new Error("boom");
      },
      set() {
        throw new Error("boom");
      },
    };
    const result = inspectContinuationLoop({
      userId: "u",
      body: grepToolBody("../wx-domain", "call_1"),
      store: store as any,
      nowMs: 1,
    });
    expect(result.shouldStop).toBe(false);
    expect(result.failedOpen).toBe(true);
  });
});

describe("loop-stop HTTP payload", () => {
  it("returns HTTP 200 with OpenAI stop, never 429/5xx", () => {
    const payload = buildLoopStopHttpPayload({
      protocol: "openai",
      streaming: false,
      modelId: "gemini-pro-agent",
      reason: "ping_pong",
      message: "stopped",
    });
    expect(payload.status).toBe(200);
    expect(payload.finishReason).toBe("stop");
    expect(payload.body.choices[0].finish_reason).toBe("stop");
    expect(payload.headers["x-yutrix-loop-stop"]).toBe("ping_pong");
  });

  it("returns HTTP 200 with Anthropic end_turn", () => {
    const payload = buildLoopStopHttpPayload({
      protocol: "anthropic",
      streaming: false,
      modelId: "claude",
      reason: "identical_error",
      message: "stopped",
    });
    expect(payload.status).toBe(200);
    expect(payload.finishReason).toBe("end_turn");
    expect(payload.body.stop_reason).toBe("end_turn");
  });

  it("renders loop-guard action log codes", () => {
    const stopped = renderActionLogServerLine(
      { level: "WARN", code: "request.loop_guard.stopped", requestId: "r1", reason: "ping_pong", modelId: "m", message: "x" } as any,
      "2026-08-22 00:00:00",
    );
    expect(stopped).toContain("Loop guard stopped");
    expect(stopped).toContain("ping_pong");
    const failed = renderActionLogServerLine(
      { level: "WARN", code: "request.loop_guard.error", requestId: "r1", error: "boom" } as any,
      "2026-08-22 00:00:00",
    );
    expect(failed).toContain("Loop guard failed open");
  });

  it("gateway executor wires stop before upstream and does not hop models on the stop path", () => {
    const root = path.resolve(
      process.cwd().endsWith("server") ? process.cwd() : path.join(process.cwd(), "apps/server"),
    );
    const src = fs.readFileSync(path.join(root, "src/routes/gateway/gatewayExecutor.ts"), "utf8");
    expect(src).toContain("maybeServeContinuationLoopStop");
    expect(src).toContain("loopStopServed");
    const stopIdx = src.indexOf("maybeServeContinuationLoopStop({");
    const fetchIdx = src.indexOf("await executeUpstreamFetch({");
    expect(stopIdx).toBeGreaterThan(0);
    expect(fetchIdx).toBeGreaterThan(stopIdx);
  });

  it("streams OpenAI chunks ending in stop, not an error event", () => {
    const payload = buildLoopStopHttpPayload({
      protocol: "openai",
      streaming: true,
      modelId: "gemini-pro-agent",
      reason: "turn_ceiling",
      message: "stopped",
    });
    expect(payload.status).toBe(200);
    const joined = payload.sseChunks.join("");
    expect(joined).toContain('"finish_reason":"stop"');
    expect(joined).not.toContain("429");
    expect(joined).toContain("[DONE]");
  });
});
