import { describe, expect, it } from "vitest";
import {
  buildUpstreamRequestDiagnostic,
  findBodyAnomalies,
} from "../src/routes/gateway/diagnostics";

function call(id: string, name = "bash", args = "{}") {
  return { id, type: "function", function: { name, arguments: args } };
}

const tools = [
  { type: "function", function: { name: "bash", parameters: { type: "object" } } },
  { type: "function", function: { name: "read", parameters: { type: "object" } } },
];

describe("findBodyAnomalies", () => {
  it("reports nothing for a well-formed tool conversation", () => {
    const body = {
      tools,
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
        { role: "assistant", content: null, tool_calls: [call("a"), call("b", "read")] },
        { role: "tool", tool_call_id: "a", content: "ok" },
        { role: "tool", tool_call_id: "b", content: "ok" },
        { role: "assistant", content: "done" },
        { role: "user", content: "next" },
      ],
    };
    expect(findBodyAnomalies(body)).toEqual([]);
  });

  it("flags tool call/result pairing problems", () => {
    const body = {
      tools,
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: null, tool_calls: [call("a"), call("b")] },
        { role: "tool", tool_call_id: "a", content: "ok" },
        { role: "user", content: "interrupt" },
        { role: "tool", tool_call_id: "b", content: "late" },
        { role: "tool", tool_call_id: "call_162420", content: "orphan" },
        { role: "assistant", content: null, tool_calls: [call("a"), call("c", "webfetch")] },
      ],
    };
    const types = findBodyAnomalies(body).map((a) => `${a.type}@${a.index}`);
    expect(types).toEqual([
      "missing_tool_result@1",
      "tool_result_out_of_order@4",
      "orphan_tool_result@5",
      "duplicate_tool_call_id@6",
      "undeclared_tool_call@6",
      "missing_tool_result@6",
      "missing_tool_result@6",
    ]);
  });

  it("flags empty turns and unparsable tool arguments", () => {
    const body = {
      messages: [
        { role: "user", content: "" },
        { role: "assistant", content: null },
        { role: "assistant", content: null, tool_calls: [call("a", "bash", "{\"cmd\":")] },
        { role: "tool", tool_call_id: "a", content: [] },
      ],
    };
    const anomalies = findBodyAnomalies(body);
    expect(anomalies.map((a) => `${a.type}@${a.index}`)).toEqual([
      "empty_content@0",
      "empty_content@1",
      "tool_call_bad_arguments@2",
      "empty_content@3",
    ]);
    expect(anomalies[2].excerpt).toContain("cmd");
  });

  it("flags lone surrogates and NUL chars with path and escaped excerpt", () => {
    const body = {
      messages: [
        { role: "user", content: "fine" },
        { role: "tool", tool_call_id: "x", content: `bash out \uD83D tail` },
        { role: "user", content: "a\u0000b" },
      ],
    };
    const anomalies = findBodyAnomalies(body).filter((a) => a.path);
    expect(anomalies).toEqual([
      { type: "lone_surrogate", path: "$.messages[1].content", excerpt: expect.stringContaining("\\ud83d") },
      { type: "nul_char", path: "$.messages[2].content", excerpt: expect.stringContaining("\\u0000") },
    ]);
  });

  it("does not flag valid surrogate pairs", () => {
    expect(findBodyAnomalies({ messages: [{ role: "user", content: "emoji 😀" }] })).toEqual([]);
  });

  it("caps the list", () => {
    const messages = Array.from({ length: 50 }, (_, i) => ({ role: "tool", tool_call_id: `x${i}`, content: "o" }));
    expect(findBodyAnomalies({ messages })).toHaveLength(20);
  });
});

describe("buildUpstreamRequestDiagnostic anomalies", () => {
  it("puts anomalies right after meta so truncation keeps them", () => {
    const text = buildUpstreamRequestDiagnostic(
      { messages: [{ role: "tool", tool_call_id: "ghost", content: "o" }] },
      { upstreamPath: "/chat/completions" },
    );
    const parsed = JSON.parse(text);
    expect(Object.keys(parsed).slice(0, 2)).toEqual(["upstreamPath", "anomalies"]);
    expect(parsed.anomalies).toEqual([{ type: "orphan_tool_result", index: 0, detail: "tool_call_id=ghost" }]);
  });

  it("omits payload analysis for capacity/5xx diagnostics", () => {
    const text = buildUpstreamRequestDiagnostic({ messages: [] }, { upstreamPath: "/x" }, true);
    expect(JSON.parse(text)).toEqual({ upstreamPath: "/x" });
  });
});
