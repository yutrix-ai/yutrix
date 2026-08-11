import { describe, expect, it } from "vitest";
import {
  applyConstraintMutators,
  isStrictToolChoice,
  planConstraintRecovery,
} from "../src/routes/gateway/providerConstraintRecovery";

const ALIYUN_THINKING_TOOL_CHOICE_MSG =
  "<400> InternalError.Algo.InvalidParameter: The tool_choice parameter does not support being set to required or object in thinking mode";

describe("providerConstraintRecovery", () => {
  it("detects strict tool_choice forms", () => {
    expect(isStrictToolChoice("required")).toBe(true);
    expect(isStrictToolChoice({ type: "function", function: { name: "final_result" } })).toBe(true);
    expect(isStrictToolChoice("auto")).toBe(false);
    expect(isStrictToolChoice("none")).toBe(false);
    expect(isStrictToolChoice(undefined)).toBe(false);
  });

  it("plans disable-thinking first for thinking + required tool_choice errors", () => {
    const body = {
      model: "any-model",
      tool_choice: "required",
      tools: [{ type: "function", function: { name: "x" } }],
    };
    const plan = planConstraintRecovery({
      statusCode: 400,
      errorMessage: ALIYUN_THINKING_TOOL_CHOICE_MSG,
      body,
      alreadyApplied: new Set(),
    });
    expect(plan?.code).toBe("disable_thinking_for_strict_tool_choice");
    plan!.mutate(body);
    expect(body.enable_thinking).toBe(false);
    expect(body.tool_choice).toBe("required");
  });

  it("falls back to relaxing tool_choice after thinking disable already applied", () => {
    const body = {
      model: "any-model",
      tool_choice: "required",
      enable_thinking: false,
      tools: [{ type: "function", function: { name: "x" } }],
    };
    const plan = planConstraintRecovery({
      statusCode: 400,
      errorMessage: ALIYUN_THINKING_TOOL_CHOICE_MSG,
      body,
      alreadyApplied: new Set(["disable_thinking_for_strict_tool_choice"]),
    });
    expect(plan?.code).toBe("relax_strict_tool_choice");
    plan!.mutate(body);
    expect(body.tool_choice).toBe("auto");
  });

  it("relaxes object-form tool_choice when error forbids object form", () => {
    const body = {
      tool_choice: { type: "function", function: { name: "final_result" } },
    };
    const plan = planConstraintRecovery({
      statusCode: 400,
      errorMessage: "tool_choice object is not supported in thinking mode",
      body,
      alreadyApplied: new Set(["disable_thinking_for_strict_tool_choice"]),
    });
    expect(plan?.code).toBe("relax_strict_tool_choice");
    plan!.mutate(body);
    expect(body.tool_choice).toBe("auto");
  });

  it("does not rewrite unrelated 400s", () => {
    const body = { tool_choice: "required", messages: [] };
    const plan = planConstraintRecovery({
      statusCode: 400,
      errorMessage: "max_tokens must be positive",
      body,
      alreadyApplied: new Set(),
    });
    expect(plan).toBeNull();
  });

  it("does not treat 'tool_choice is required' as a forbid-strict signal", () => {
    const body = { tools: [{ type: "function", function: { name: "x" } }] };
    const plan = planConstraintRecovery({
      statusCode: 400,
      errorMessage: "Invalid parameter: tool_choice is required when tools are present",
      body: { ...body, tool_choice: "required" },
      alreadyApplied: new Set(),
    });
    expect(plan).toBeNull();
  });

  it("does not rewrite on generic invalid tool_choice without required/object ban", () => {
    const plan = planConstraintRecovery({
      statusCode: 400,
      errorMessage: "invalid tool_choice: function name 'nope' not found in tools",
      body: { tool_choice: "required" },
      alreadyApplied: new Set(),
    });
    expect(plan).toBeNull();
  });

  it("does not rewrite non-parameter statuses", () => {
    const plan = planConstraintRecovery({
      statusCode: 500,
      errorMessage: ALIYUN_THINKING_TOOL_CHOICE_MSG,
      body: { tool_choice: "required" },
      alreadyApplied: new Set(),
    });
    expect(plan).toBeNull();
  });

  it("does not loop when all strategies already applied", () => {
    const plan = planConstraintRecovery({
      statusCode: 400,
      errorMessage: ALIYUN_THINKING_TOOL_CHOICE_MSG,
      body: { tool_choice: "required" },
      alreadyApplied: new Set([
        "disable_thinking_for_strict_tool_choice",
        "relax_strict_tool_choice",
        "disable_thinking",
      ]),
    });
    expect(plan).toBeNull();
  });

  it("re-applies mutators onto a fresh outbound body", () => {
    const first = { tool_choice: "required" as any };
    const plan = planConstraintRecovery({
      statusCode: 400,
      errorMessage: "tool_choice required is not supported",
      body: first,
      alreadyApplied: new Set(["disable_thinking_for_strict_tool_choice"]),
    });
    expect(plan).not.toBeNull();

    const fresh = { model: "m", tool_choice: "required" as any, tools: [] };
    applyConstraintMutators(fresh, [plan!.mutate]);
    expect(fresh.tool_choice).toBe("auto");
  });
});
