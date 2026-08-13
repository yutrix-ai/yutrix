import { describe, expect, it } from "vitest";
import { adaptRequestProtocol } from "../src/routes/gateway/protocolAdapter";
import { isFirstPartyAnthropicSurface } from "../src/routes/gateway/anthropicOutboundProfile";

function claudeCodeBody(model = "claude-sonnet-4") {
  return {
    model,
    max_tokens: 32000,
    stream: true,
    system: [
      { type: "text", text: "You are Claude Code.", cache_control: { type: "ephemeral" } },
    ],
    tools: [
      {
        name: "bash",
        description: "Run a shell command",
        input_schema: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
        },
        cache_control: { type: "ephemeral" },
        defer_loading: true,
      },
    ],
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "I should list files first.",
            signature: "sig-abc",
            thoughtSignature: "sig-abc",
            cache_control: { type: "ephemeral" },
          },
          {
            type: "text",
            text: "Let me look.",
            cache_control: { type: "ephemeral" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: "ok",
            cache_control: { type: "ephemeral" },
          },
        ],
      },
    ],
  };
}

const noopLog = () => {};

function adaptAnthropicToAnthropic(
  body: any,
  outbound: { hostname?: string; pathname?: string; rawBaseUrl?: string },
  modelId = body.model,
) {
  return adaptRequestProtocol(
    body,
    "anthropic",
    true,
    true,
    modelId,
    {},
    noopLog,
    undefined,
    outbound,
  );
}

describe("isFirstPartyAnthropicSurface", () => {
  it("treats official Anthropic hosts as first-party", () => {
    expect(isFirstPartyAnthropicSurface({ hostname: "api.anthropic.com" })).toBe(true);
    expect(isFirstPartyAnthropicSurface({ rawBaseUrl: "https://api.anthropic.com/v1" })).toBe(true);
  });

  it("treats self-hosted antigravity /v1/messages as compatible, not first-party", () => {
    expect(isFirstPartyAnthropicSurface({
      hostname: "10.8.0.200",
      pathname: "/antigravity/v1",
      rawBaseUrl: "http://10.8.0.200:7861/antigravity/v1",
    })).toBe(false);
    expect(isFirstPartyAnthropicSurface({
      hostname: "proxy.internal",
      pathname: "/v1/messages",
      rawBaseUrl: "http://proxy.internal/v1",
    })).toBe(false);
  });
});

describe("adaptRequestProtocol Anthropic outbound profiles", () => {
  it("keeps thinking, signatures, and cache_control for first-party Anthropic", () => {
    const { finalBody } = adaptAnthropicToAnthropic(
      claudeCodeBody(),
      { hostname: "api.anthropic.com", rawBaseUrl: "https://api.anthropic.com" },
    );

    const thinking = finalBody.messages[0].content.find((b: any) => b.type === "thinking");
    expect(thinking).toMatchObject({
      type: "thinking",
      thinking: "I should list files first.",
      signature: "sig-abc",
    });
    expect(thinking.cache_control).toEqual({ type: "ephemeral" });
    expect(finalBody.messages[0].content[1].cache_control).toEqual({ type: "ephemeral" });
    expect(finalBody.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(finalBody.tools[0].cache_control).toEqual({ type: "ephemeral" });
    expect(finalBody.tools[0].defer_loading).toBe(true);
    expect(finalBody.tools[0].input_schema).toBeDefined();
  });

  it("reduces Claude Code dialect on a non-first-party Anthropic host", () => {
    const { finalBody } = adaptAnthropicToAnthropic(
      claudeCodeBody("gemini-3.6-flash-high"),
      {
        hostname: "10.8.0.200",
        pathname: "/antigravity/v1",
        rawBaseUrl: "http://10.8.0.200:7861/antigravity/v1",
      },
      "gemini-3.6-flash-high",
    );

    const blocks = finalBody.messages[0].content;
    expect(blocks.some((b: any) => b.type === "thinking")).toBe(false);
    expect(blocks[0]).toEqual({ type: "text", text: "I should list files first." });
    expect(blocks[1]).toEqual({ type: "text", text: "Let me look." });
    expect(JSON.stringify(finalBody)).not.toContain("cache_control");
    expect(finalBody.tools).toEqual([
      {
        name: "bash",
        description: "Run a shell command",
        input_schema: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
        },
      },
    ]);
    expect(finalBody.max_tokens).toBeGreaterThanOrEqual(1);
  });

  it("drops empty thinking blocks on the compatible profile", () => {
    const body = {
      model: "gemini-3.6-flash-high",
      messages: [{
        role: "assistant",
        content: [
          { type: "thinking", thinking: "   ", signature: "x" },
          { type: "text", text: "hi" },
        ],
      }],
    };
    const { finalBody } = adaptAnthropicToAnthropic(body, {
      hostname: "gcli.local",
      pathname: "/antigravity/v1/messages",
      rawBaseUrl: "http://gcli.local/antigravity/v1",
    });
    expect(finalBody.messages[0].content).toEqual([{ type: "text", text: "hi" }]);
    expect(finalBody.max_tokens).toBeGreaterThanOrEqual(1);
  });

  it("does not force Anthropic clients onto Chat Completions when both URLs would be filled", () => {
    const { finalBody } = adaptAnthropicToAnthropic(
      claudeCodeBody("gemini-3.6-flash-high"),
      {
        hostname: "10.8.0.200",
        pathname: "/antigravity/v1",
        rawBaseUrl: "http://10.8.0.200:7861/antigravity/v1",
      },
    );
    expect(finalBody.messages[0].role).toBe("assistant");
    expect(finalBody.tools[0].input_schema).toBeDefined();
    expect(finalBody.tools[0].type).toBeUndefined();
    expect(finalBody.tools[0].function).toBeUndefined();
    expect(Array.isArray(finalBody.messages[0].content)).toBe(true);
  });

  it("does not rewrite model ids; that stays in provider/route config", () => {
    const compatible = adaptAnthropicToAnthropic(
      claudeCodeBody("gemini-3.1-pro-high"),
      {
        hostname: "10.8.0.200",
        pathname: "/antigravity/v1",
        rawBaseUrl: "http://10.8.0.200:7861/antigravity/v1",
      },
      "gemini-3.1-pro-high",
    );
    expect(compatible.finalBody.model).toBe("gemini-3.1-pro-high");

    const tiered = adaptAnthropicToAnthropic(
      claudeCodeBody("gemini-3.6-flash-tiered"),
      {
        hostname: "10.8.0.200",
        pathname: "/antigravity/v1",
        rawBaseUrl: "http://10.8.0.200:7861/antigravity/v1",
      },
      "gemini-3.6-flash-tiered",
    );
    expect(tiered.finalBody.model).toBe("gemini-3.6-flash-tiered");
  });

  it("does not rewrite generic OpenAI model ids on the OpenAI adapt path", () => {
    const { finalBody } = adaptRequestProtocol(
      {
        model: "gpt-4o",
        messages: [{ role: "user", content: "hi" }],
      },
      "openai",
      false,
      false,
      "gpt-4o",
      {},
      noopLog,
      undefined,
      { hostname: "api.openai.com", rawBaseUrl: "https://api.openai.com/v1" },
    );
    expect(finalBody.model).toBe("gpt-4o");
  });
});
