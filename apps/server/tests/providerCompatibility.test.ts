import { describe, expect, it } from "vitest";
import {
  applyProviderCompatibility,
  isGoogleOpenAICompatibleProvider,
  resolveCompatibilityProfile,
  sanitizeGeminiSchema,
} from "../src/routes/gateway/providerCompatibility";

function productionNestedBooleanEnumSchema() {
  return {
    type: "object",
    properties: {
      windows: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            config: {
              type: "object",
              properties: {
                name: { type: "string" },
                enabled: {
                  type: "boolean",
                  enum: [true],
                },
              },
            },
          },
        },
      },
    },
  };
}

function antigravitySurface() {
  return {
    providerName: "Antigravity",
    baseUrl: "http://10.9.0.3:7862/antigravity/v1",
    providerProtocol: "openai",
    modelId: "gemini-3.8-flash-high",
  };
}

describe("compatibility profiles", () => {
  it("classifies official Google hosts as first-party", () => {
    expect(
      resolveCompatibilityProfile({
        providerName: "Google AI Studio",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
        providerProtocol: "openai",
        modelId: "gemma-4-31b-it",
      }),
    ).toBe("first_party_google_openai");
    expect(
      isGoogleOpenAICompatibleProvider({
        providerName: "Google AI Studio",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      }),
    ).toBe(true);
  });

  it("classifies Antigravity name/url as a Gemini schema proxy", () => {
    expect(resolveCompatibilityProfile(antigravitySurface())).toBe("gemini_schema_proxy");
    expect(isGoogleOpenAICompatibleProvider(antigravitySurface())).toBe(false);
    expect(
      resolveCompatibilityProfile({
        providerName: "Antigravity_US1",
        baseUrl: "http://10.8.0.200:7861/v1",
        providerProtocol: "openai",
        modelId: "gemini-3.7-flash-high",
      }),
    ).toBe("gemini_schema_proxy");
  });

  it("classifies antigravity path even when the provider name is custom", () => {
    expect(
      resolveCompatibilityProfile({
        providerName: "US-pool-1",
        baseUrl: "http://10.8.0.200:7861/antigravity/v1",
        providerProtocol: "openai",
        modelId: "gemini-3.7-flash-high",
      }),
    ).toBe("gemini_schema_proxy");
  });

  it("classifies gcli2api as a Gemini schema proxy", () => {
    expect(
      resolveCompatibilityProfile({
        providerName: "gcli2api",
        baseUrl: "http://gcli.local/v1",
        providerProtocol: "openai",
        modelId: "gemini-3.1-pro-high",
      }),
    ).toBe("gemini_schema_proxy");
  });

  it("does not treat gemini model names or Google branding as schema proxies", () => {
    expect(
      resolveCompatibilityProfile({
        providerName: "Gemini Relay",
        baseUrl: "http://10.0.0.8:8080/v1",
        providerProtocol: "openai",
        modelId: "gemini-3.8-flash-high",
      }),
    ).toBe("none");
    expect(
      resolveCompatibilityProfile({
        providerName: "OPENAI",
        baseUrl: "http://10.9.0.3:7862/v1",
        providerProtocol: "openai",
        modelId: "gemini-3.8-flash-high",
      }),
    ).toBe("none");
    expect(
      resolveCompatibilityProfile({
        providerName: "Google Compatible Proxy",
        baseUrl: "https://gateway.example.com/v1",
        providerProtocol: "openai",
        modelId: "custom-model",
      }),
    ).toBe("none");
    expect(
      resolveCompatibilityProfile({
        providerName: "Gemini via Alibaba",
        baseUrl: "https://api.aliyun.com/v1",
        providerProtocol: "openai",
        modelId: "gemini-2.5",
      }),
    ).toBe("none");
  });

  it("does not treat lookalike hosts as first-party Google", () => {
    expect(
      resolveCompatibilityProfile({
        providerName: "evil",
        baseUrl: "https://evilgoogleapis.com/v1",
        providerProtocol: "openai",
        modelId: "gpt-4.1",
      }),
    ).toBe("none");
  });

  it("skips non-OpenAI protocols and unrelated providers", () => {
    expect(
      resolveCompatibilityProfile({
        ...antigravitySurface(),
        providerProtocol: "anthropic",
      }),
    ).toBe("none");
    expect(
      resolveCompatibilityProfile({
        providerName: "阿里Coding Plan",
        baseUrl: "https://example.test/v1",
        providerProtocol: "openai",
        modelId: "qwen-plus",
      }),
    ).toBe("none");
  });
});

describe("sanitizeGeminiSchema", () => {
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

  it("drops boolean enums and keeps boolean type — never stringifies true", () => {
    const schema = sanitizeGeminiSchema({
      type: "boolean",
      enum: [true, false],
    });

    expect(schema.type).toBe("boolean");
    expect(schema.enum).toBeUndefined();
    expect(JSON.stringify(schema)).not.toContain('"true"');
    expect(JSON.stringify(schema)).not.toContain('"false"');
  });

  it("infers boolean from a singleton true enum and hints the const constraint", () => {
    const schema = sanitizeGeminiSchema({
      enum: [true],
    });

    expect(schema.type).toBe("boolean");
    expect(schema.enum).toBeUndefined();
    expect(schema.description).toContain("true");
  });

  it("lifts JSON Schema const:true into a boolean field", () => {
    const schema = sanitizeGeminiSchema({
      const: true,
    });

    expect(schema.type).toBe("boolean");
    expect(schema.enum).toBeUndefined();
    expect(schema.const).toBeUndefined();
  });

  it("drops integer enums and keeps a numeric type", () => {
    const schema = sanitizeGeminiSchema({
      type: "integer",
      enum: [1, 2, 80],
    });

    expect(schema.type).toBe("integer");
    expect(schema.enum).toBeUndefined();
    expect(schema.description).toContain("80");
  });

  it("keeps all-string enums intact", () => {
    expect(
      sanitizeGeminiSchema({
        type: "string",
        enum: ["daylight", "cool", "warm"],
      }),
    ).toEqual({
      type: "string",
      enum: ["daylight", "cool", "warm"],
    });
  });

  it("drops mixed enums without inventing a type or stringifying", () => {
    const schema = sanitizeGeminiSchema({
      enum: [true, "yes"],
    });

    expect(schema.enum).toBeUndefined();
    expect(schema.type).toBeUndefined();
    expect(schema.description).toBeTruthy();
    expect(JSON.stringify(schema)).not.toMatch(/"enum":\["true"/);
  });

  it("treats null in a boolean enum as nullable", () => {
    const schema = sanitizeGeminiSchema({
      type: "boolean",
      enum: [true, null],
    });

    expect(schema).toMatchObject({
      type: "boolean",
      nullable: true,
    });
    expect(schema.enum).toBeUndefined();
  });

  it("sanitizes the production nested function_declarations enum path", () => {
    const schema = sanitizeGeminiSchema(productionNestedBooleanEnumSchema());
    const enabled = schema.properties.windows.items.properties.config.properties.enabled;

    expect(enabled).toEqual({
      type: "boolean",
      description: expect.stringContaining("true"),
    });
    expect(enabled.enum).toBeUndefined();
  });

  it("recurses tuple items and ignores cyclic schemas", () => {
    const tuple = sanitizeGeminiSchema({
      type: "array",
      items: [{ enum: [true] }, { type: "string", enum: ["a"] }],
    });
    expect(tuple.items[0].type).toBe("boolean");
    expect(tuple.items[0].enum).toBeUndefined();
    expect(tuple.items[1].enum).toEqual(["a"]);

    const cyclic: any = { type: "object", properties: {} };
    cyclic.properties.self = cyclic;
    expect(() => sanitizeGeminiSchema(cyclic)).not.toThrow();
  });

  it("drops malformed enums and unsupported string formats without throwing", () => {
    expect(sanitizeGeminiSchema({ type: "string", enum: "true" }).enum).toBeUndefined();
    expect(sanitizeGeminiSchema({ type: "string", enum: [] }).enum).toBeUndefined();
    expect(
      sanitizeGeminiSchema({
        type: "string",
        format: "uri",
      }),
    ).toEqual({ type: "string" });
    expect(
      sanitizeGeminiSchema({
        type: "string",
        format: "date-time",
      }),
    ).toEqual({ type: "string", format: "date-time" });
    expect(sanitizeGeminiSchema(null)).toBeNull();
    expect(sanitizeGeminiSchema("x")).toBe("x");
  });
});

describe("applyProviderCompatibility", () => {
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
    expect(logs[0].message).toContain("max_tokens");
    expect(logs[0].message).toContain("tools_schema");
  });

  it("sanitizes Antigravity tools without clamping tokens or dropping stream_options", () => {
    const body = {
      model: "gemini-3.8-flash-high",
      max_tokens: 32000,
      max_completion_tokens: 32000,
      stream: true,
      stream_options: { include_usage: true },
      tool_choice: "auto",
      tools: [
        {
          type: "function",
          function: {
            name: "computer_get_window_state",
            parameters: productionNestedBooleanEnumSchema(),
          },
        },
        { type: "custom", name: "leave-me" },
        {
          type: "function",
          function: {
            name: "broken",
          },
        },
      ],
    };

    const summary = applyProviderCompatibility(body, antigravitySurface());

    expect(summary).toContain("tools_schema(3)");
    expect(summary).not.toContain("max_tokens");
    expect(summary).not.toContain("stream_options");
    expect(body.max_tokens).toBe(32000);
    expect(body.max_completion_tokens).toBe(32000);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.tool_choice).toBe("auto");
    expect(
      body.tools[0].function.parameters.properties.windows.items.properties.config.properties.enabled,
    ).toEqual({
      type: "boolean",
      description: expect.stringContaining("true"),
    });
    expect(body.tools[1]).toEqual({ type: "custom", name: "leave-me" });
    expect(body.tools[2].function.name).toBe("broken");
  });

  it("does not rewrite Google-branded transparent proxies on unofficial hosts", () => {
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
              properties: {
                flag: { enum: [true] },
              },
            },
          },
        },
      ],
    };
    const original = JSON.parse(JSON.stringify(body));

    const summary = applyProviderCompatibility(body, {
      providerName: "Google AI Studio",
      baseUrl: "http://10.9.0.3:7862/v1",
      providerProtocol: "openai",
      modelId: "gemini-3.8-flash-high",
    });

    expect(summary).toBeNull();
    expect(body).toEqual(original);
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

    const summary = applyProviderCompatibility(body, {
      providerName: "阿里Coding Plan",
      baseUrl: "https://example.test/v1",
      providerProtocol: "openai",
      modelId: "qwen-plus",
    });

    expect(summary).toBeNull();
    expect(body).toEqual(original);
  });

  it("is safe to call unconditionally for empty/malformed payloads", () => {
    expect(applyProviderCompatibility(null, antigravitySurface())).toBeNull();
    expect(applyProviderCompatibility("x", antigravitySurface())).toBeNull();
    expect(applyProviderCompatibility({}, antigravitySurface())).toBeNull();

    const body = { tools: null, max_tokens: 32000 };
    expect(applyProviderCompatibility(body, antigravitySurface())).toBeNull();
    expect(body.max_tokens).toBe(32000);

    const throwingTool: any = {
      type: "function",
      function: { name: "x" },
    };
    Object.defineProperty(throwingTool.function, "parameters", {
      get() {
        throw new Error("boom");
      },
      enumerable: true,
    });
    const resilient = { tools: [throwingTool], max_tokens: 16000 };
    expect(() => applyProviderCompatibility(resilient, antigravitySurface())).not.toThrow();
    expect(resilient.max_tokens).toBe(16000);
  });
});
