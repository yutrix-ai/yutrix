import { describe, expect, it } from "vitest";
import { classifyGatewayRequestClass } from "../src/services/requestRoutingClass";
import {
  classifyStrategyTask,
  extractCurrentUserInputForRouting,
  resolveStrategyRoutingDecision,
} from "../src/services/strategyRouting";
import type { AttemptState } from "../src/routes/gateway/types";

const flashAttempt: AttemptState = {
  providerId: "prov-flash",
  providerProtocol: "openai",
  modelId: "gemini-3.7-flash-high",
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
      providerProtocol: "openai",
      modelId: "gemini-pro-agent",
      enabled: true,
    },
    {
      taskType: "code",
      providerId: "prov-code",
      providerProtocol: "openai",
      modelId: "gemini-3.1-pro-high",
      enabled: true,
    },
    {
      taskType: "general",
      providerId: "prov-flash",
      providerProtocol: "openai",
      modelId: "gemini-3.7-flash-high",
      enabled: true,
    },
  ]),
  providerId: "prov-flash",
  modelId: "gemini-3.7-flash-high",
  promptPolicyId: null,
};

function codingAskWithHarnessWrapper() {
  return {
    model: "gemini-3.7-flash-high",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              "<system-reminder>\nThe following workspace instructions may be relevant.\n" +
              "When API returns 500 with \"服务调用失败\", the error originates in a domain service.\n" +
              "Check logs if the request keeps failing with not found.\n</system-reminder>",
          },
          {
            type: "text",
            text:
              "Instructions from: CLAUDE.md\nDebugging Downstream Errors\n" +
              "When API returns 500 with error, check logs. 失败时请看 stack.",
          },
          {
            type: "text",
            text: "@src/main/java/com/hr/spark/api/stockinquiry/StockInquiryController.java 实现其中的接口",
          },
        ],
      },
    ],
  };
}

function realDebugPaste() {
  return {
    model: "gemini-3.7-flash-high",
    messages: [
      {
        role: "user",
        content: "接口报错了，帮我排查一下\nthis function throws an error",
      },
    ],
  };
}

function toolContinuationBody() {
  return {
    model: "gemini-3.7-flash-high",
    messages: [
      { role: "user", content: "实现其中的接口" },
      { role: "assistant", content: "calling tool" },
      {
        role: "tool",
        tool_call_id: "call_1",
        content: "grep: ../wx-domain: No such file or directory",
      },
    ],
  };
}

describe("protocol_error is continuation-only", () => {
  it("does not classify a harness-wrapped coding user_intent as protocol_error/debug", async () => {
    const body = codingAskWithHarnessWrapper();
    expect(classifyGatewayRequestClass(body).requestClass).toBe("user_intent");

    const text = extractCurrentUserInputForRouting(body);
    const classified = classifyStrategyTask(text, false);
    expect(classified.reasons).not.toContain("protocol_error");
    expect(classified.taskType).not.toBe("debug");

    const decision = await resolveStrategyRoutingDecision({
      route: strategyRoute,
      body,
      currentAttempt: flashAttempt,
      incomingProtocol: "openai",
    });
    expect(decision?.taskType).not.toBe("debug");
    expect(decision?.reasons || []).not.toContain("protocol_error");
  });

  it("still classifies a real debug user_intent paste as debug", async () => {
    const body = realDebugPaste();
    expect(classifyGatewayRequestClass(body).requestClass).toBe("user_intent");
    const classified = classifyStrategyTask(
      extractCurrentUserInputForRouting(body),
      false,
    );
    expect(classified.taskType).toBe("debug");

    const decision = await resolveStrategyRoutingDecision({
      route: strategyRoute,
      body,
      currentAttempt: flashAttempt,
      incomingProtocol: "openai",
    });
    expect(decision?.taskType).toBe("debug");
    expect(decision?.reasons || []).not.toContain("continuation_request");
  });

  it("keeps tool_continuation sticky and does not reclassify", async () => {
    const body = toolContinuationBody();
    expect(classifyGatewayRequestClass(body).requestClass).toBe("tool_continuation");

    const decision = await resolveStrategyRoutingDecision({
      route: strategyRoute,
      body,
      currentAttempt: flashAttempt,
      incomingProtocol: "openai",
      previousModelId: flashAttempt.modelId,
      isContinuation: true,
    });
    expect(decision?.applied).toBe(false);
    expect(decision?.reasons).toContain("continuation_request");
    expect(decision?.skipReason).toBe("already_on_target");
    expect(decision?.newAttempt).toBeUndefined();
  });

  it("exposes protocol_error only when allowProtocolError is set", () => {
    const text = extractCurrentUserInputForRouting(codingAskWithHarnessWrapper());
    const gated = classifyStrategyTask(text, false);
    expect(gated.reasons).not.toContain("protocol_error");

    const allowed = classifyStrategyTask(text, false, { allowProtocolError: true });
    expect(allowed.reasons).toContain("protocol_error");
    expect(allowed.taskType).toBe("debug");
  });
});
