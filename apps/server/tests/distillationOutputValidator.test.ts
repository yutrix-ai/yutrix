import { describe, it, expect } from "vitest";
import {
  containsBusinessLeakage,
  validateDistillationOutput,
} from "../src/services/distillation/outputValidator";

describe("distillation outputValidator", () => {
  it("rejects paths and URLs in skill fragments", () => {
    expect(
      containsBusinessLeakage("/src/payment/order.ts handler"),
    ).toBe(true);
    expect(
      containsBusinessLeakage("see https://api.example.com/v1/orders"),
    ).toBe(true);
  });

  it("accepts abstract engineering traits", () => {
    expect(
      containsBusinessLeakage("prefers root-cause analysis before patching"),
    ).toBe(false);
  });

  it("validates well-formed dual output", () => {
    const result = validateDistillationOutput({
      routing: {
        action: "signal_adjust",
        adjustments: [
          {
            type: "weight_delta",
            taskType: "debug",
            token: "stacktrace",
            delta: 1,
            reason: "stack_present_debug_boost",
          },
        ],
      },
      skill: {
        capability: ["checks logs before code changes"],
        heuristic: [],
        workflow: ["bug: reproduce then locate"],
        persona: [],
      },
    });
    expect(result.ok).toBe(true);
  });

  it("rejects verbatim user content patterns", () => {
    const result = validateDistillationOutput({
      routing: {
        action: "confirm",
        adjustments: [],
      },
      skill: {
        capability: ["fix the 订单支付 white screen bug"],
        heuristic: [],
        workflow: [],
        persona: [],
      },
    });
    expect(result.ok).toBe(false);
  });
});
