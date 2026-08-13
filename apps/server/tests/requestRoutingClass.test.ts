import { describe, expect, it } from "vitest";
import {
  classifyGatewayRequestClass,
  extractClientRequestedModel,
  isClientNamedSmallFastModel,
  selectStickyModelFromLogRows,
  shouldRecordStrategyRoutingHop,
} from "../src/services/requestRoutingClass";
import { classifyStrategyTask, extractCurrentUserInputForRouting, resolveStrategyRoutingDecision } from "../src/services/strategyRouting";
import type { AttemptState } from "../src/routes/gateway/types";

const SIDECAR_STAGE1 =
  "Stage 1 does NOT apply user intent or ALLOW exceptions — stage 2 will handle those.\n" +
  "Respond with <severity>N</severity> ONLY. Grade HARM ONLY — do NOT reduce for user intent. No other text.";

const LIVE_STACK =
  "AttributeError: 'NoneType' object has no attribute 'review_pass'\n" +
  "Failed to parse tool call arguments as JSON\n" +
  "接口报错了，帮我排查一下";

function sidecarEnvelope(stack = LIVE_STACK) {
  return `<transcript>\n${stack}\n</transcript>\n${SIDECAR_STAGE1}`;
}

function anthropicSidecarBody(model = "gemini-3.6-flash-tiered") {
  return {
    model,
    messages: [{
      role: "user",
      content: [{ type: "text", text: sidecarEnvelope() }],
    }],
  };
}

function openaiSidecarBody(model = "gemini-3.6-flash-tiered") {
  return {
    model,
    messages: [{ role: "user", content: sidecarEnvelope() }],
  };
}

function debugUserBody(model?: string) {
  return {
    ...(model ? { model } : {}),
    messages: [{ role: "user", content: LIVE_STACK }],
  };
}

const flashAttempt: AttemptState = {
  providerId: "prov-flash",
  providerProtocol: "anthropic",
  modelId: "gemini-3.6-flash-tiered",
  promptPolicyId: null,
  isFallback: false,
  fallbackReason: "",
  targetIndex: 0,
};

const strategyRoute = {
  strategyRoutingEnabled: true,
  strategyRoutingRules: JSON.stringify([
    {
      taskType: "debug",
      providerId: "prov-debug",
      providerProtocol: "anthropic",
      modelId: "gemini-3.1-pro-high",
      enabled: true,
    },
    {
      taskType: "general",
      providerId: "prov-flash",
      providerProtocol: "anthropic",
      modelId: "gemini-3.6-flash-tiered",
      enabled: true,
    },
  ]),
  providerId: "prov-flash",
  modelId: "gemini-3.6-flash-tiered",
  promptPolicyId: null,
};

describe("classifyGatewayRequestClass", () => {
  it("marks Anthropic and OpenAI Stage-1 envelopes as client_sidecar", () => {
    expect(classifyGatewayRequestClass(anthropicSidecarBody()).requestClass).toBe("client_sidecar");
    expect(classifyGatewayRequestClass(openaiSidecarBody()).requestClass).toBe("client_sidecar");
    expect(classifyGatewayRequestClass(anthropicSidecarBody()).reasons).toContain("client_sidecar");
  });

  it("still finds sidecar after a long traceback prefix", () => {
    const huge = {
      messages: [{
        role: "user",
        content: "AttributeError: fail\n".repeat(2000) + SIDECAR_STAGE1,
      }],
    };
    expect(classifyGatewayRequestClass(huge).requestClass).toBe("client_sidecar");
  });

  it("marks tool-result turns as tool_continuation", () => {
    const body = {
      messages: [
        { role: "user", content: "fix the parser" },
        { role: "assistant", content: "calling tool" },
        { role: "tool", content: "file content...", tool_call_id: "call_1" },
      ],
    };
    expect(classifyGatewayRequestClass(body).requestClass).toBe("tool_continuation");
  });

  it("marks a real user debug paste as user_intent", () => {
    expect(classifyGatewayRequestClass(debugUserBody()).requestClass).toBe("user_intent");
  });
});

describe("strategy decision stays off debug for sidecar", () => {
  it("does not classify sidecar+traceback as debug (Anthropic + OpenAI)", () => {
    for (const body of [anthropicSidecarBody(), openaiSidecarBody()]) {
      const text = extractCurrentUserInputForRouting(body);
      const classified = classifyStrategyTask(text, false);
      expect(classified.taskType).toBe("general");
      expect(classified.reasons).toContain("client_sidecar");
    }
  });

  it("still classifies the same traceback without the envelope as debug", () => {
    expect(classifyStrategyTask(extractCurrentUserInputForRouting(debugUserBody()), false).taskType)
      .toBe("debug");
  });

  it("resolveStrategyRoutingDecision skips sidecar without applying a debug target", async () => {
    const decision = await resolveStrategyRoutingDecision({
      route: strategyRoute,
      body: anthropicSidecarBody(),
      currentAttempt: flashAttempt,
      incomingProtocol: "anthropic",
      previousModelId: "gemini-3.1-pro-high",
      isContinuation: true,
    });
    expect(decision).toMatchObject({
      applied: false,
      skipReason: "client_sidecar",
      taskType: "general",
    });
    expect(decision?.newAttempt).toBeUndefined();
  });
});

describe("client-named small/fast model is not upgraded", () => {
  it("recognizes haiku / mini / flash-lite aliases and not the route default flash-tiered", () => {
    expect(isClientNamedSmallFastModel("claude-haiku-4-5")).toBe(true);
    expect(isClientNamedSmallFastModel("haiku")).toBe(true);
    expect(isClientNamedSmallFastModel("gpt-4o-mini")).toBe(true);
    expect(isClientNamedSmallFastModel("gemini-2.5-flash-lite")).toBe(true);
    expect(isClientNamedSmallFastModel("gemini-3.6-flash-tiered")).toBe(false);
    expect(isClientNamedSmallFastModel("gemini-3.1-pro-high")).toBe(false);
    expect(isClientNamedSmallFastModel(null)).toBe(false);
  });

  it("extracts the client model field from OpenAI and Anthropic bodies", () => {
    expect(extractClientRequestedModel(openaiSidecarBody("claude-haiku-4-5"))).toBe("claude-haiku-4-5");
    expect(extractClientRequestedModel(anthropicSidecarBody("haiku"))).toBe("haiku");
  });

  it("does not apply a debug strategy hop when the client named haiku", async () => {
    const decision = await resolveStrategyRoutingDecision({
      route: strategyRoute,
      body: debugUserBody("claude-haiku-4-5"),
      currentAttempt: flashAttempt,
      incomingProtocol: "anthropic",
    });
    expect(decision?.applied).toBe(false);
    expect(decision?.skipReason).toBe("client_named_small_model");
    expect(decision?.newAttempt).toBeUndefined();
  });
});

describe("sticky lookup skips sidecar rows", () => {
  it("returns the last non-sidecar main-task model", () => {
    const sidecarInput = JSON.stringify(anthropicSidecarBody());
    const mainInput = JSON.stringify(debugUserBody());
    const model = selectStickyModelFromLogRows([
      { model: "gemini-3.6-flash-tiered", inputText: sidecarInput },
      { model: "gemini-3.1-pro-high", inputText: mainInput },
      { model: "gemini-3.1-pro-high", inputText: mainInput },
    ]);
    expect(model).toBe("gemini-3.1-pro-high");
  });

  it("returns null when every recent row is a sidecar", () => {
    expect(selectStickyModelFromLogRows([
      { model: "gemini-3.6-flash-tiered", inputText: JSON.stringify(openaiSidecarBody()) },
    ])).toBeNull();
  });
});

describe("routing-trace hops only on a real model/provider change", () => {
  it("does not record a hop when stay/skip keeps the same target", () => {
    expect(shouldRecordStrategyRoutingHop(
      { providerId: "prov-flash", modelId: "gemini-3.6-flash-tiered" },
      { providerId: "prov-flash", modelId: "gemini-3.6-flash-tiered" },
    )).toBe(false);
  });

  it("records a hop only when provider or model actually changes", () => {
    expect(shouldRecordStrategyRoutingHop(
      { providerId: "prov-flash", modelId: "gemini-3.6-flash-tiered" },
      { providerId: "prov-debug", modelId: "gemini-3.1-pro-high" },
    )).toBe(true);
  });
});
