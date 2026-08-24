import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import fs from "fs";
import path from "path";
import { initTestDatabase, closeAndCleanup } from "./helpers/testDatabase";
import {
  LOOP_GUARD_DEFAULTS,
  LOOP_GUARD_FLOORS,
  LOOP_GUARD_SETTING_KEYS,
  applyLoopGuardRuntime,
  createLoopGuardStore,
  detectLoopStop,
  inspectContinuationLoop,
  peekLoopGuardRuntime,
  resetLoopGuardRuntimeForTests,
  resolveLoopGuardConfig,
} from "../src/services/loopGuard";

function grepToolBody(dir: string, toolCallId: string) {
  const content = JSON.stringify({
    kind: "foreground",
    exitCode: 0,
    stderr: { text: `grep: ${dir}: No such file or directory\n` },
    stdout: { text: "" },
  });
  return {
    messages: [
      { role: "user", content: "实现库存查询接口" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: toolCallId,
            type: "function",
            function: { name: "run_code", arguments: "{}" },
          },
        ],
      },
      { role: "tool", tool_call_id: toolCallId, content },
    ],
  };
}

function pingPongTurns(count: number) {
  const a = "err-a";
  const b = "err-b";
  return Array.from({ length: count }, (_, i) => ({
    kind: "continuation" as const,
    fingerprint: i % 2 === 0 ? a : b,
    isErrorClass: true,
    at: i,
  }));
}

function ceilingTurns(n: number) {
  return [
    { kind: "user_intent" as const, fingerprint: "u", isErrorClass: false, at: 0 },
    ...Array.from({ length: n }, (_, i) => ({
      kind: "continuation" as const,
      fingerprint: `p${i}`,
      isErrorClass: false,
      at: i + 1,
    })),
  ];
}

describe("resolveLoopGuardConfig (shipped map → config)", () => {
  it("missing keys resolve to factory defaults", () => {
    const config = resolveLoopGuardConfig({});
    expect(config).toEqual({ ...LOOP_GUARD_DEFAULTS });
    expect(config.enabled).toBe(true);
    expect(config.identicalErrorRepeats).toBe(5);
    expect(config.pingPongHalfCycles).toBe(8);
    expect(config.continuationCeiling).toBe(400);
    expect(config.continuationMaxAgeMs).toBe(2 * 60 * 60 * 1000);
  });

  it("clamps identical repeats below the floor", () => {
    const config = resolveLoopGuardConfig({
      [LOOP_GUARD_SETTING_KEYS.identicalErrorRepeats]: "2",
    });
    expect(config.identicalErrorRepeats).toBe(LOOP_GUARD_FLOORS.identicalErrorRepeats);
  });

  it("garbage and empty strings fall back to defaults", () => {
    const config = resolveLoopGuardConfig({
      [LOOP_GUARD_SETTING_KEYS.enabled]: "maybe",
      [LOOP_GUARD_SETTING_KEYS.identicalErrorRepeats]: "abc",
      [LOOP_GUARD_SETTING_KEYS.pingPongHalfCycles]: "",
      [LOOP_GUARD_SETTING_KEYS.continuationCeiling]: "5.5",
      [LOOP_GUARD_SETTING_KEYS.continuationMaxAgeHours]: "nope",
    });
    expect(config.enabled).toBe(LOOP_GUARD_DEFAULTS.enabled);
    expect(config.identicalErrorRepeats).toBe(LOOP_GUARD_DEFAULTS.identicalErrorRepeats);
    expect(config.pingPongHalfCycles).toBe(LOOP_GUARD_DEFAULTS.pingPongHalfCycles);
    expect(config.continuationCeiling).toBe(LOOP_GUARD_DEFAULTS.continuationCeiling);
    expect(config.continuationMaxAgeMs).toBe(LOOP_GUARD_DEFAULTS.continuationMaxAgeMs);
  });

  it("ceiling 0 and age 0 disable those signals", () => {
    const config = resolveLoopGuardConfig({
      [LOOP_GUARD_SETTING_KEYS.continuationCeiling]: "0",
      [LOOP_GUARD_SETTING_KEYS.continuationMaxAgeHours]: "0",
    });
    expect(config.continuationCeiling).toBe(0);
    expect(config.continuationMaxAgeMs).toBe(0);
    expect(detectLoopStop(ceilingTurns(400), 400, config)).toBeNull();
    const twoHours = LOOP_GUARD_DEFAULTS.continuationMaxAgeMs;
    expect(
      detectLoopStop(
        [
          { kind: "user_intent", fingerprint: "u", isErrorClass: false, at: 0 },
          { kind: "continuation", fingerprint: "c", isErrorClass: false, at: 10 },
        ],
        twoHours,
        config,
      ),
    ).toBeNull();
  });

  it("enable false prevents hard-stop including default ping-pong", () => {
    const config = resolveLoopGuardConfig({
      [LOOP_GUARD_SETTING_KEYS.enabled]: "false",
    });
    expect(config.enabled).toBe(false);
    expect(detectLoopStop(pingPongTurns(8), 8, config)).toBeNull();
  });

  it("factory defaults still trip ping-pong at 8", () => {
    const config = resolveLoopGuardConfig({});
    expect(detectLoopStop(pingPongTurns(7), 7, config)).toBeNull();
    expect(detectLoopStop(pingPongTurns(8), 8, config)?.reason).toBe("ping_pong");
  });
});

describe("inspectContinuationLoop honors resolved config", () => {
  it("does not trip when hard-stop is disabled", () => {
    const store = createLoopGuardStore();
    const config = resolveLoopGuardConfig({
      [LOOP_GUARD_SETTING_KEYS.enabled]: "false",
    });
    let last = null as ReturnType<typeof inspectContinuationLoop> | null;
    for (let i = 0; i < 8; i++) {
      last = inspectContinuationLoop({
        userId: "user-off",
        body: grepToolBody(i % 2 === 0 ? "../wx-api-client" : "../wx-domain", `call_${i}`),
        store,
        nowMs: i,
        config,
      });
    }
    expect(last?.shouldStop).toBe(false);
  });

  it("I/O-unavailable runtime fail-opens", () => {
    applyLoopGuardRuntime({ config: { ...LOOP_GUARD_DEFAULTS }, unavailable: true });
    try {
      const result = inspectContinuationLoop({
        userId: "user-io",
        body: grepToolBody("../wx-domain", "call_1"),
        store: createLoopGuardStore(),
        nowMs: 1,
      });
      expect(result.shouldStop).toBe(false);
      expect(result.failedOpen).toBe(true);
    } finally {
      resetLoopGuardRuntimeForTests();
    }
  });
});

describe("admin settings POST refreshes the live inspect path", () => {
  const dbFile = "data/promptgate_test_loop_guard_settings.sqlite";
  let client: any;
  const fastify = Fastify();

  beforeAll(async () => {
    resetLoopGuardRuntimeForTests();
    ({ client } = await initTestDatabase({ dbFilePath: dbFile }));
    const settingsRoutes = (await import("../src/routes/settings")).default;
    await fastify.register(require("@fastify/jwt"), { secret: "testsecret" });
    fastify.addHook("onRequest", async (request) => {
      request.jwtVerify = async () => {
        (request as any).user = { role: "admin", id: "admin" };
      };
    });
    await fastify.register(settingsRoutes);
    await fastify.ready();
  });

  beforeEach(() => {
    resetLoopGuardRuntimeForTests();
  });

  afterAll(async () => {
    resetLoopGuardRuntimeForTests();
    await closeAndCleanup(client, dbFile);
  });

  async function postLoopGuard(values: Record<string, string>) {
    const settings = Object.entries(values).map(([key, value]) => ({ key, value }));
    const response = await fastify.inject({
      method: "POST",
      url: "/api/admin/settings",
      payload: { settings },
    });
    expect(response.statusCode).toBe(200);
  }

  it("GET fills factory defaults when keys are absent", async () => {
    const response = await fastify.inject({ method: "GET", url: "/api/admin/settings" });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as Array<{ key: string; value: string }>;
    const map = Object.fromEntries(body.map((row) => [row.key, row.value]));
    expect(map[LOOP_GUARD_SETTING_KEYS.enabled]).toBe("true");
    expect(map[LOOP_GUARD_SETTING_KEYS.identicalErrorRepeats]).toBe("5");
    expect(map[LOOP_GUARD_SETTING_KEYS.pingPongHalfCycles]).toBe("8");
    expect(map[LOOP_GUARD_SETTING_KEYS.continuationCeiling]).toBe("400");
    expect(map[LOOP_GUARD_SETTING_KEYS.continuationMaxAgeHours]).toBe("2");
  });

  it("POST identical=2 is clamped to 3 on the live inspect path", async () => {
    await postLoopGuard({
      [LOOP_GUARD_SETTING_KEYS.enabled]: "true",
      [LOOP_GUARD_SETTING_KEYS.identicalErrorRepeats]: "2",
      [LOOP_GUARD_SETTING_KEYS.pingPongHalfCycles]: "8",
      [LOOP_GUARD_SETTING_KEYS.continuationCeiling]: "400",
      [LOOP_GUARD_SETTING_KEYS.continuationMaxAgeHours]: "2",
    });
    expect(peekLoopGuardRuntime().config.identicalErrorRepeats).toBe(3);

    const store = createLoopGuardStore();
    let last = null as ReturnType<typeof inspectContinuationLoop> | null;
    for (let i = 1; i <= 2; i++) {
      last = inspectContinuationLoop({
        userId: "user-clamp",
        body: grepToolBody("../wx-domain", `call_c${i}`),
        store,
        nowMs: i,
      });
    }
    expect(last?.shouldStop).toBe(false);
    last = inspectContinuationLoop({
      userId: "user-clamp",
      body: grepToolBody("../wx-domain", "call_c3"),
      store,
      nowMs: 3,
    });
    expect(last?.shouldStop).toBe(true);
    expect(last?.reason).toBe("identical_error");
  });

  it("POST ping-pong=20 does not trip at 8; enable=false never hard-stops", async () => {
    await postLoopGuard({
      [LOOP_GUARD_SETTING_KEYS.enabled]: "true",
      [LOOP_GUARD_SETTING_KEYS.identicalErrorRepeats]: "5",
      [LOOP_GUARD_SETTING_KEYS.pingPongHalfCycles]: "20",
      [LOOP_GUARD_SETTING_KEYS.continuationCeiling]: "400",
      [LOOP_GUARD_SETTING_KEYS.continuationMaxAgeHours]: "2",
    });
    const store = createLoopGuardStore();
    let last = null as ReturnType<typeof inspectContinuationLoop> | null;
    for (let i = 0; i < 8; i++) {
      last = inspectContinuationLoop({
        userId: "user-raised",
        body: grepToolBody(i % 2 === 0 ? "../wx-api-client" : "../wx-domain", `call_r${i}`),
        store,
        nowMs: i,
      });
    }
    expect(last?.shouldStop).toBe(false);

    await postLoopGuard({
      [LOOP_GUARD_SETTING_KEYS.enabled]: "false",
      [LOOP_GUARD_SETTING_KEYS.identicalErrorRepeats]: "5",
      [LOOP_GUARD_SETTING_KEYS.pingPongHalfCycles]: "8",
      [LOOP_GUARD_SETTING_KEYS.continuationCeiling]: "400",
      [LOOP_GUARD_SETTING_KEYS.continuationMaxAgeHours]: "2",
    });
    const offStore = createLoopGuardStore();
    for (let i = 0; i < 8; i++) {
      last = inspectContinuationLoop({
        userId: "user-disabled",
        body: grepToolBody(i % 2 === 0 ? "../wx-api-client" : "../wx-domain", `call_d${i}`),
        store: offStore,
        nowMs: i,
      });
    }
    expect(last?.shouldStop).toBe(false);
  });
});

describe("settings UI / copy / README", () => {
  const root = path.resolve(
    process.cwd().endsWith("server") ? path.join(process.cwd(), "../..") : process.cwd(),
  );

  it("Gateway settings card contains the enable switch and four numeric fields", () => {
    const src = fs.readFileSync(
      path.join(root, "apps/web/src/components/Settings/GatewaySettings.tsx"),
      "utf8",
    );
    expect(src).toContain("loopGuardEnabled");
    expect(src).toContain("loopGuardIdenticalErrorRepeats");
    expect(src).toContain("loopGuardPingPongHalfCycles");
    expect(src).toContain("loopGuardContinuationCeiling");
    expect(src).toContain("loopGuardContinuationMaxAgeHours");
    expect(src).toContain("Switch");
    expect(src).toContain('id="loopGuardEnabled"');
  });

  it("zh.json and en.json contain the new gateway-section strings", () => {
    const zh = JSON.parse(fs.readFileSync(path.join(root, "apps/web/src/locales/zh.json"), "utf8"));
    const en = JSON.parse(fs.readFileSync(path.join(root, "apps/web/src/locales/en.json"), "utf8"));
    expect(zh.settings.sections.gateway.loopGuardTitle).toBeTruthy();
    expect(en.settings.sections.gateway.loopGuardTitle).toBeTruthy();
    expect(zh.settings.sections.gateway.loopGuardEnabled).toBeTruthy();
    expect(en.settings.sections.gateway.loopGuardCeilingHint).toMatch(/0/);
  });

  it("READMEs document the loop guard and system settings tunables", () => {
    const en = fs.readFileSync(path.join(root, "README.md"), "utf8");
    const zh = fs.readFileSync(path.join(root, "README.zh-CN.md"), "utf8");
    expect(en.toLowerCase()).toContain("loop");
    expect(en).toMatch(/Session & Gateway Settings|system settings/i);
    expect(zh).toContain("工具循环熔断");
    expect(zh).toContain("会话与网关设置");
  });
});
