import { describe, expect, it } from "vitest";
import {
  applyProviderCompatibility,
  needsGeminiSchemaSanitize,
  sanitizeGeminiSchema,
} from "../src/routes/gateway/providerCompatibility";

describe("provider compatibility", () => {
  it("sanitizes Gemini tool schemas to the supported subset", () => {
    const schema = sanitizeGeminiSchema({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: ["object", "null"],
      title: "Command",
      additionalProperties: false,
      properties: {
        command: {
          type: "string",
          description: "Shell command",
          default: "ls",
          pattern: "^ls",
        },
        options: {
          type: "array",
          items: {
            type: "string",
            minLength: 1,
          },
        },
      },
      required: ["command"],
    });

    expect(schema).toEqual({
      type: "object",
      nullable: true,
      properties: {
        command: {
          type: "string",
          description: "Shell command",
        },
        options: {
          type: "array",
          items: {
            type: "string",
          },
        },
      },
      required: ["command"],
    });
  });

  it("applies Google OpenAI-compatible request normalizations", () => {
    const logs: any[] = [];
    const body = {
      model: "gemma-4-31b-it",
      max_tokens: 32000,
      stream: true,
      stream_options: { include_usage: true },
      tools: [
        {
          type: "function",
          function: {
            name: "bash",
            description: "Run shell commands",
            parameters: {
              $schema: "https://json-schema.org/draft/2020-12/schema",
              type: "object",
              additionalProperties: false,
              properties: {
                command: {
                  type: "string",
                  default: "ls",
                },
              },
              required: ["command"],
            },
          },
        },
      ],
    };

    applyProviderCompatibility(body, {
      providerName: "Google AI Studio",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      providerProtocol: "openai",
      modelId: "gemma-4-31b-it",
      baseActionLog: { requestId: "req-1" },
      logAction: (event: any) => logs.push(event),
    });

    expect(body.max_tokens).toBe(8192);
    expect(body.stream_options).toBeUndefined();
    expect(body.tools[0].function.parameters).toEqual({
      type: "object",
      properties: {
        command: {
          type: "string",
        },
      },
      required: ["command"],
    });
    expect(logs).toHaveLength(1);
    expect(logs[0].code).toBe("request.provider_compatibility");
  });

  it("does not alter non-Google OpenAI-compatible requests", () => {
    const body = {
      max_tokens: 32000,
      stream_options: { include_usage: true },
      tools: [
        {
          type: "function",
          function: {
            name: "search",
            parameters: {
              $schema: "https://json-schema.org/draft/2020-12/schema",
              type: "object",
              additionalProperties: false,
            },
          },
        },
      ],
    };
    const original = JSON.parse(JSON.stringify(body));

    applyProviderCompatibility(body, {
      providerName: "阿里Coding Plan",
      baseUrl: "https://example.test/v1",
      providerProtocol: "openai",
    });

    expect(body).toEqual(original);
  });

  it("coerces non-string enum values to strings, including nested properties/items", () => {
    const schema = sanitizeGeminiSchema({
      type: "object",
      properties: {
        rows: {
          type: "array",
          items: {
            type: "object",
            properties: {
              flags: {
                type: "object",
                properties: {
                  enabled: { type: "boolean", enum: [true, false] },
                  retries: { type: "integer", enum: [0, 1, 2] },
                  mode: { type: "string", enum: ["fast", null] },
                },
              },
            },
          },
        },
      },
    });

    expect(schema.properties.rows.items.properties.flags.properties.enabled.enum).toEqual([
      "true",
      "false",
    ]);
    expect(schema.properties.rows.items.properties.flags.properties.retries.enum).toEqual([
      "0",
      "1",
      "2",
    ]);
    expect(schema.properties.rows.items.properties.flags.properties.mode.enum).toEqual([
      "fast",
      null,
    ]);
  });

  it("detects Antigravity / Gemini surfaces and ignores first-party Anthropic", () => {
    expect(
      needsGeminiSchemaSanitize({
        providerName: "Antigravity_US2",
        baseUrl: "http://10.9.0.3:7862/antigravity/v1/messages",
        providerProtocol: "anthropic",
      }),
    ).toBe(true);
    expect(
      needsGeminiSchemaSanitize({
        providerName: "Google AI Studio",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
        providerProtocol: "openai",
      }),
    ).toBe(true);
    expect(
      needsGeminiSchemaSanitize({
        providerName: "Anthropic",
        baseUrl: "https://api.anthropic.com/v1",
        providerProtocol: "anthropic",
      }),
    ).toBe(false);
  });

  it("sanitizes Anthropic input_schema for Antigravity even when protocol is anthropic", () => {
    const body = {
      max_tokens: 32000,
      tools: [
        {
          name: "toggle",
          description: "Flip a flag",
          input_schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              enabled: { type: "boolean", enum: [true, false] },
            },
            required: ["enabled"],
          },
        },
      ],
    };

    const summary = applyProviderCompatibility(body, {
      providerName: "Antigravity_US2",
      baseUrl: "http://10.9.0.3:7862/antigravity/v1/messages",
      providerProtocol: "anthropic",
      modelId: "gemini-3.8-flash-high",
    });

    expect(summary).toContain("tools_schema");
    expect(body.max_tokens).toBe(32000);
    expect(body.tools[0].input_schema).toEqual({
      type: "object",
      properties: {
        enabled: { type: "boolean", enum: ["true", "false"] },
      },
      required: ["enabled"],
    });
  });

  it("does not coerce Anthropic→Anthropic tools for anthropic.com", () => {
    const body = {
      max_tokens: 32000,
      tools: [
        {
          name: "toggle",
          input_schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              enabled: { type: "boolean", enum: [true, false] },
            },
          },
        },
      ],
    };
    const original = JSON.parse(JSON.stringify(body));

    const summary = applyProviderCompatibility(body, {
      providerName: "Anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      providerProtocol: "anthropic",
    });

    expect(summary).toBeNull();
    expect(body).toEqual(original);
    expect(body.tools[0].input_schema.properties.enabled.enum).toEqual([true, false]);
  });
});
