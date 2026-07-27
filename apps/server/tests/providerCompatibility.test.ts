import { describe, expect, it } from "vitest";
import {
  applyProviderCompatibility,
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
});
