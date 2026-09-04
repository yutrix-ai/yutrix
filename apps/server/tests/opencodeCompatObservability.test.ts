import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import {
  attachOpencodeGatewayMeta,
  buildOpencodeCompatChannelLog,
  toAnthropicMessage,
  toOpenAICompletion,
} from "../src/opencode/protocol";
import { detectProviderUsagePresence } from "../src/utils/gatewayContent";
import { resolveRoundUsage, commitRoundUsage, updateResponseDataUsage } from "../src/routes/gateway/continuityHelper";
import { replaceUninterpolatedI18nParams } from "../../web/src/utils/actionLogI18nFallback";
import { renderActionLogServerLine } from "../src/utils/actionLogTemplates";

vi.mock("../src/db", () => ({
  db: {
    update: () => ({
      set: () => ({
        where: () => ({
          execute: () => Promise.resolve(),
        }),
      }),
    }),
  },
}));

vi.mock("../src/routes/gateway/logging", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    isAuditExemptUser: vi.fn().mockResolvedValue(false),
  };
});

vi.mock("../src/services/requestLogService", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    updateRequestLog: vi.fn().mockResolvedValue(true),
  };
});

vi.mock("../src/utils/tokenizer", () => ({
  exactEstimateTokens: async (text: string) => Math.max(0, Math.ceil(String(text || "").length / 4)),
  estimateTokensFallback: (text: string) => Math.max(0, Math.ceil(String(text || "").length / 4)),
}));

function emptyContinuity() {
  return {
    accumulatedCompletionText: "",
    hiddenContinuityText: "",
    forwardedStreamText: "",
    promptTokens: 0,
    completionTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    usageStatus: "success" as const,
    committedRoundIds: new Set<string>(),
    hasStartedContinuity: false,
    hasForwardedStreamMaterial: false,
    streamRoundCount: 1,
  };
}

describe("OpenCode compat observability", () => {
  it("attaches provider/baseLog/queueMs/latency like executeUpstreamFetch success", () => {
    const sessionResult = {
      status: 200,
      data: toOpenAICompletion("gpt-4o", "ses_1", "Hello from sidecar"),
      isStream: false as const,
      responseProtocol: "openai" as const,
      sidecarNonStream: true as const,
    };
    const provider = { name: "Wool OpenRouter", id: "prov-1" };
    const attached = attachOpencodeGatewayMeta(sessionResult, {
      provider,
      baseLog: { requestId: "req-1" },
      queueMs: 12,
      latencyMs: 88,
    });

    expect(attached.provider).toBe(provider);
    expect(attached.provider.name).toBe("Wool OpenRouter");
    expect(attached.baseLog).toEqual({ requestId: "req-1" });
    expect(attached.queueMs).toBe(12);
    expect(attached.latencyMs).toBe(88);
    expect(attached.rawProviderUsage.inputProvided).toBe(false);
    expect(attached.rawProviderUsage.outputProvided).toBe(false);
    expect(attached.data.choices[0].message.content).toBe("Hello from sidecar");
  });

  it("does not advertise Session API zeros as provider-reported usage", () => {
    const openai = toOpenAICompletion("m", "ses_x", "assistant reply text");
    const anthropic = toAnthropicMessage("m", "ses_x", "assistant reply text");
    expect(openai.usage).toBeUndefined();
    expect(anthropic.usage).toBeUndefined();
    expect(detectProviderUsagePresence(openai)).toEqual({
      inputProvided: false,
      outputProvided: false,
      cacheReadProvided: false,
      cacheWriteProvided: false,
    });
    expect(detectProviderUsagePresence(anthropic)).toEqual({
      inputProvided: false,
      outputProvided: false,
      cacheReadProvided: false,
      cacheWriteProvided: false,
    });
  });

  it("estimates usage when OpenCode text is present and commits continuity", async () => {
    const ctx: any = {
      currentAttempt: { modelId: "gpt-4o" },
      activeModelConfig: {},
      activeProvider: {},
      continuity: emptyContinuity(),
    };
    const prompt = "Please summarize the following paragraph in one sentence.";
    const assistant = "This is a reasonably long assistant reply used to estimate tokens.";
    const responseData: any = attachOpencodeGatewayMeta(
      {
        status: 200,
        data: toOpenAICompletion("gpt-4o", "ses_est", assistant),
        isStream: false,
        responseProtocol: "openai",
        sidecarNonStream: true,
      },
      { provider: { name: "Wool OpenRouter" } },
    );
    const roundBody = { messages: [{ role: "user", content: prompt }] };

    const roundUsage = await resolveRoundUsage(ctx, responseData, roundBody);
    expect(roundUsage.inputTokens).toBeGreaterThan(0);
    expect(roundUsage.outputTokens).toBeGreaterThan(0);
    expect(roundUsage.totalTokens).toBeGreaterThan(0);
    expect(roundUsage.inputSource).toBe("estimated");
    expect(roundUsage.outputSource).toBe("estimated");
    expect(roundUsage.usageStatus).toBe("estimated");

    commitRoundUsage(ctx, responseData, roundUsage, "round-opencode");
    updateResponseDataUsage(ctx, responseData);

    expect(ctx.continuity.promptTokens).toBeGreaterThan(0);
    expect(ctx.continuity.completionTokens).toBeGreaterThan(0);
    expect(responseData.data.usage).toBeDefined();
    expect(responseData.data.usage.prompt_tokens).toBeGreaterThan(0);
    expect(responseData.data.usage.completion_tokens).toBeGreaterThan(0);
    expect(responseData.data.usage.total_tokens).toBeGreaterThan(0);
  });

  it("buildOpencodeCompatChannelLog is ops-shaped (sidecar/sandbox, no secrets)", () => {
    const event = buildOpencodeCompatChannelLog({
      baseActionLog: { requestId: "req-abc", path: "/v1/chat/completions" },
      providerName: "Wool OpenRouter",
      modelId: "gpt-4o",
    });
    expect(event.code).toBe("opencode.compat_channel");
    expect(event.providerName).toBe("Wool OpenRouter");
    expect(event.modelId).toBe("gpt-4o");
    expect(event.requestId).toBe("req-abc");
    expect(event.channel).toBe("sidecar");
    expect(event.sandbox).toBe(true);
    expect(JSON.stringify(event)).not.toMatch(/sk-|password|secret|apiKey/i);

    const line = renderActionLogServerLine(event as any, "2026-09-04 00:00:00");
    expect(line).toContain("OpenCode compat channel");
    expect(line).toContain("provider=Wool OpenRouter");
    expect(line).toContain("path=sidecar");
    expect(line).toContain("sandbox=on");
  });

  it("completed action log params include provider name from attached OpenCode result", async () => {
    const { handleGatewayResponse } = await import("../src/routes/gateway/gatewayResponder");
    const { logEmitter } = await import("../src/utils/events");
    const audits: any[] = [];
    const onAudit = (payload: any) => audits.push(payload);
    logEmitter.on("chatLogInsert", onAudit);

    const logAction = vi.fn();
    const mockReply = {
      raw: { headersSent: false },
      code: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
    };
    const assistant = "Sidecar assistant text for audit.";
    const ctx: any = {
      request: { headers: {} },
      reply: mockReply,
      body: { messages: [{ role: "user", content: "hello world from client" }] },
      startTime: Date.now() - 40,
      auth: { userId: "u1", apiKeyRecord: { id: "k1", name: "API Client" }, providedKey: "pg_hidden" },
      routing: { incomingProtocol: "openai", reqPath: "/v1/chat/completions" },
      baseActionLog: { requestId: "req-opencode-1" },
      reqLogId: "log-opencode-1",
      currentAttempt: { modelId: "gpt-4o", isFallback: false, fallbackReason: "" },
      calculateCostForTokens: vi.fn().mockReturnValue(0),
      stream: { promptTokens: 0, completionTokens: 0 },
      routingTrace: [],
      clientDisconnected: false,
      continuity: {
        ...emptyContinuity(),
        promptTokens: 11,
        completionTokens: 7,
        usageStatus: "estimated",
      },
    };
    const responseData = attachOpencodeGatewayMeta(
      {
        status: 200,
        data: toOpenAICompletion("gpt-4o", "ses_log", assistant),
        isStream: false,
        responseProtocol: "openai",
        sidecarNonStream: true,
      },
      { provider: { name: "Wool OpenRouter" }, queueMs: 3, latencyMs: 40 },
    );

    await handleGatewayResponse(ctx, responseData, logAction);
    await new Promise((r) => setTimeout(r, 20));

    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({
      code: "request.completed",
      providerName: "Wool OpenRouter",
      modelId: "gpt-4o",
      promptTokens: 11,
      completionTokens: 7,
      totalTokens: 18,
    }));
    expect(mockReply.send).toHaveBeenCalledWith(expect.objectContaining({
      choices: [expect.objectContaining({
        message: expect.objectContaining({ content: assistant }),
      })],
    }));

    const audit = audits.find((a) => a.id === "log-opencode-1");
    expect(audit).toBeTruthy();
    expect(audit.outputText).toContain(assistant);
    expect(audit.inputTokens).toBe(11);
    expect(audit.outputTokens).toBe(7);

    logEmitter.off("chatLogInsert", onAudit);
  });
});

describe("OpenCode gateway wiring (static)", () => {
  it("executor attaches OpenCode meta and logs compat channel before Session API", () => {
    const src = readFileSync(join(process.cwd(), "src/routes/gateway/gatewayExecutor.ts"), "utf8");
    expect(src).toMatch(/shouldRouteViaOpencode\(activeModelConfig\)/);
    expect(src).toMatch(/buildOpencodeCompatChannelLog/);
    expect(src).toMatch(/attachOpencodeGatewayMeta/);
    expect(src).toMatch(/executeOpencodeSessionApi/);
    expect(src).toMatch(/providerName:\s*provider\.name/);
    expect(src).toMatch(/latencyMs:\s*Date\.now\(\)\s*-\s*attemptStartProcessingMs/);
  });
});

describe("action log i18n missing-param fallback", () => {
  it("replaces leftover {{providerName}} with dash", () => {
    const raw =
      "Request completed requestId=req-1 provider={{providerName}} model=gpt-4o tokens(in/out/total)={{promptTokens}}/1/1";
    const rendered = replaceUninterpolatedI18nParams(raw);
    expect(rendered).not.toContain("{{providerName}}");
    expect(rendered).not.toContain("{{promptTokens}}");
    expect(rendered).toContain("provider=-");
    expect(rendered).toContain("tokens(in/out/total)=-/1/1");
  });

  it("renderer applies the fallback after i18next.t (static + regression)", () => {
    const rendererPath = existsSync(join(process.cwd(), "../web/src/utils/actionLogRenderer.ts"))
      ? join(process.cwd(), "../web/src/utils/actionLogRenderer.ts")
      : join(process.cwd(), "apps/web/src/utils/actionLogRenderer.ts");
    const src = readFileSync(rendererPath, "utf8");
    expect(src).toMatch(/replaceUninterpolatedI18nParams\(i18next\.t\(/);

    const template =
      "Request completed provider={{providerName}} model={{modelId}} tokens(in/out/total)={{promptTokens}}/{{completionTokens}}/{{totalTokens}}";
    const params: Record<string, unknown> = { modelId: "gpt-4o" };
    let interpolated = template;
    for (const [key, value] of Object.entries(params)) {
      interpolated = interpolated.replaceAll(`{{${key}}}`, String(value));
    }
    const line = replaceUninterpolatedI18nParams(interpolated);
    expect(line).not.toMatch(/\{\{providerName\}\}/);
    expect(line).toContain("provider=-");
    expect(line).toContain("model=gpt-4o");
    expect(line).toContain("tokens(in/out/total)=-/-/-");
  });

  it("locale files define opencode.compat_channel", () => {
    const enPath = existsSync(join(process.cwd(), "../web/src/locales/en.json"))
      ? join(process.cwd(), "../web/src/locales/en.json")
      : join(process.cwd(), "apps/web/src/locales/en.json");
    const zhPath = existsSync(join(process.cwd(), "../web/src/locales/zh.json"))
      ? join(process.cwd(), "../web/src/locales/zh.json")
      : join(process.cwd(), "apps/web/src/locales/zh.json");
    const en = JSON.parse(readFileSync(enPath, "utf8"));
    const zh = JSON.parse(readFileSync(zhPath, "utf8"));
    expect(en.logs.code.opencode.compat_channel).toMatch(/OpenCode compat channel/);
    expect(zh.logs.code.opencode.compat_channel).toMatch(/OpenCode 兼容通道/);
  });
});
