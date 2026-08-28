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
    expect(body.thinking).toEqual({ type: "disabled" });
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

const REASONING_PASSBACK_MSG =
  "The `reasoning_content` in the thinking mode must be passed back to the API.";

function passbackBody(overrides: Record<string, unknown> = {}) {
  return {
    model: "any-model",
    tools: [{ type: "function", function: { name: "glob" } }],
    tool_choice: "auto",
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "list files" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_649011",
            type: "function",
            function: { name: "glob", arguments: "{\"pattern\":\"*\"}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_649011", content: "ok" },
    ],
    ...overrides,
  };
}

describe("thinking-mode passback recovery (vendor-neutral)", () => {
  it("disables thinking and strips foreign reasoning_content instead of filling empties", () => {
    const body = passbackBody({
      messages: [
        { role: "user", content: "q" },
        {
          role: "assistant",
          content: "answer",
          reasoning_content: "other-model chain",
        },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_1", type: "function", function: { name: "read" } }],
        },
      ],
    });
    const plan = planConstraintRecovery({
      statusCode: 400,
      errorMessage: REASONING_PASSBACK_MSG,
      body,
      alreadyApplied: new Set(),
    });
    expect(plan).not.toBeNull();
    expect(plan?.summary).toContain("strip");
    plan!.mutate(body);
    expect(body.enable_thinking).toBe(false);
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.reasoning_effort).toBe("none");
    expect(body.messages[1].reasoning_content).toBeUndefined();
    expect(body.messages[2].reasoning_content).toBeUndefined();
  });

  it("also recovers on 422", () => {
    const body = passbackBody();
    const plan = planConstraintRecovery({
      statusCode: 422,
      errorMessage: REASONING_PASSBACK_MSG,
      body,
      alreadyApplied: new Set(),
    });
    expect(plan).not.toBeNull();
  });

  it("does not produce a second plan after the rewrite code is recorded", () => {
    const body = passbackBody();
    const first = planConstraintRecovery({
      statusCode: 400,
      errorMessage: REASONING_PASSBACK_MSG,
      body,
      alreadyApplied: new Set(),
    });
    expect(first).not.toBeNull();
    const second = planConstraintRecovery({
      statusCode: 400,
      errorMessage: REASONING_PASSBACK_MSG,
      body,
      alreadyApplied: new Set([first!.code]),
    });
    expect(second).toBeNull();
  });

  it("writes thinking.type=disabled even when thinking was undefined", () => {
    const body = {
      model: "any-model",
      enable_thinking: true,
    };
    const plan = planConstraintRecovery({
      statusCode: 400,
      errorMessage: "thinking mode is not supported",
      body,
      alreadyApplied: new Set(),
    });
    expect(plan).not.toBeNull();
    plan!.mutate(body);
    expect(body.enable_thinking).toBe(false);
    expect(body.thinking).toEqual({ type: "disabled" });
  });

  it("strips an existing reasoning_content so thinking-off is consistent", () => {
    const body = passbackBody({
      messages: [
        { role: "user", content: "q" },
        {
          role: "assistant",
          content: "answer",
          reasoning_content: "keep this chain",
        },
      ],
    });
    const plan = planConstraintRecovery({
      statusCode: 400,
      errorMessage: REASONING_PASSBACK_MSG,
      body,
      alreadyApplied: new Set(),
    });
    expect(plan).not.toBeNull();
    plan!.mutate(body);
    expect(body.messages[1].reasoning_content).toBeUndefined();
  });

  it("leaves null bodies, non-object messages, and non-assistant roles alone", () => {
    expect(
      planConstraintRecovery({
        statusCode: 400,
        errorMessage: REASONING_PASSBACK_MSG,
        body: null,
        alreadyApplied: new Set(),
      }),
    ).toBeNull();

    const body = passbackBody({
      messages: [
        null,
        "skip-me",
        { role: "user", content: "q" },
        { role: "assistant", content: null, tool_calls: [] },
      ],
    });
    const plan = planConstraintRecovery({
      statusCode: 400,
      errorMessage: REASONING_PASSBACK_MSG,
      body,
      alreadyApplied: new Set(),
    });
    expect(plan).not.toBeNull();
    expect(() => plan!.mutate(body)).not.toThrow();
    expect(body.messages[0]).toBeNull();
    expect(body.messages[1]).toBe("skip-me");
    expect(body.messages[2].reasoning_content).toBeUndefined();
    expect(body.messages[3].reasoning_content).toBeUndefined();
  });

  it("strips reasoning_content even when tools are absent", () => {
    const body = {
      model: "any-model",
      messages: [{ role: "assistant", content: "hi", reasoning_content: "chain" }],
    };
    const plan = planConstraintRecovery({
      statusCode: 400,
      errorMessage: REASONING_PASSBACK_MSG,
      body,
      alreadyApplied: new Set(),
    });
    expect(plan).not.toBeNull();
    plan!.mutate(body);
    expect(body.enable_thinking).toBe(false);
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.messages[0].reasoning_content).toBeUndefined();
  });

  it("re-applies disable+strip onto a freshly built outbound body", () => {
    const first = passbackBody();
    const plan = planConstraintRecovery({
      statusCode: 400,
      errorMessage: REASONING_PASSBACK_MSG,
      body: first,
      alreadyApplied: new Set(),
    });
    expect(plan).not.toBeNull();

    const fresh = passbackBody({
      model: "m",
      messages: [
        { role: "user", content: "q" },
        { role: "assistant", content: "a", reasoning_content: "foreign" },
      ],
    });
    applyConstraintMutators(fresh, [plan!.mutate]);
    expect(fresh.enable_thinking).toBe(false);
    expect(fresh.thinking).toEqual({ type: "disabled" });
    expect(fresh.messages[1].reasoning_content).toBeUndefined();
  });
});
