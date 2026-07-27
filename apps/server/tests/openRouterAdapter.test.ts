import { describe, expect, it } from "vitest";
import { openRouterAdapter } from "../src/routes/gateway/providerAdapters/openRouterAdapter";
import { parseAndNormalizeUrl } from "../src/routes/gateway/providerAdapters/urlMatcher";
import { adaptRequestProtocol } from "../src/routes/gateway/protocolAdapter";
import { createFakeStreamFromData } from "../src/routes/gateway/upstream";

async function readStreamText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }

  text += decoder.decode();
  return text;
}

describe("openRouterAdapter core capabilities", () => {
  const context = {
    providerId: "openrouter-p",
    providerName: "OpenRouter",
    providerProtocol: "openai",
    rawBaseUrl: "https://openrouter.ai/api/v1",
    normalizedBaseUrl: "https://openrouter.ai/api/v1",
    hostname: "openrouter.ai",
    pathname: "/api/v1",
    modelId: "meta-llama/llama-3",
    incomingProtocol: "openai",
    requestPath: "/v1/chat/completions"
  };

  it("matches OpenRouter URL formats correctly", () => {
    expect(openRouterAdapter.match(context)).toBe(true);

    const fullUrlCtx = {
      ...context,
      rawBaseUrl: "https://openrouter.ai/api/v1/chat/completions"
    };
    expect(openRouterAdapter.match(fullUrlCtx)).toBe(true);

    const lowercaseHostCtx = {
      ...context,
      rawBaseUrl: "https://OPENROUTER.AI/api/v1"
    };
    expect(openRouterAdapter.match(lowercaseHostCtx)).toBe(true);

    const invalidHostCtx = {
      ...context,
      rawBaseUrl: "https://openrouter.ai.example.com/api/v1"
    };
    expect(openRouterAdapter.match(invalidHostCtx)).toBe(false);
  });

  describe("Request Policy and Sanitization", () => {
    it("exempts assistant history fields (reasoning, reasoning_details) from deletion", () => {
      const policy = openRouterAdapter.getRequestPolicy!(context);
      expect(policy.exemptAssistantHistoryFields).toContain("reasoning");
      expect(policy.exemptAssistantHistoryFields).toContain("reasoning_details");

      const body = {
        messages: [
          {
            role: "assistant",
            content: "some text",
            reasoning: "assistant thinking",
            reasoning_details: [{ type: "text", text: "thought text" }]
          },
          {
            role: "user",
            content: "hello",
            reasoning: "user thinking (should be deleted)",
            reasoning_details: [{ type: "text", text: "opaque user detail" }]
          }
        ]
      };

      const { finalBody } = adaptRequestProtocol(
        body,
        "openai",
        false,
        false,
        context.modelId,
        {},
        () => {},
        policy
      );

      // Assistant message reasoning and details preserved
      expect(finalBody.messages[0].reasoning).toBe("assistant thinking");
      expect(finalBody.messages[0].reasoning_details).toStrictEqual([{ type: "text", text: "thought text" }]);

      // User message reasoning and details deleted
      expect(finalBody.messages[1].reasoning).toBeUndefined();
      expect(finalBody.messages[1].reasoning_details).toBeUndefined();
    });

    it("ensures normal OpenAI providers still delete these fields under normal policy", () => {
      const body = {
        messages: [
          {
            role: "assistant",
            content: "some text",
            reasoning: "assistant thinking",
            reasoning_details: [{ type: "text", text: "thought text" }]
          }
        ]
      };

      const { finalBody } = adaptRequestProtocol(
        body,
        "openai",
        false,
        false,
        "gpt-4o",
        {},
        () => {}
        // No policy passed
      );

      expect(finalBody.messages[0].reasoning).toBeUndefined();
      expect(finalBody.messages[0].reasoning_details).toBeUndefined();
    });
  });

  describe("Observation and Meaningful Signal Extraction", () => {
    it("extracts reasoning_content and details from stream delta copies", () => {
      const state = openRouterAdapter.createAttemptState!(context);

      // Chunk 1: reasoning_content only
      const chunk1 = {
        choices: [{
          delta: { reasoning_content: "thinking 1" }
        }]
      };
      const obs1 = openRouterAdapter.observeStreamChunk!(chunk1, state, context);
      expect(obs1?.meaningful).toBe(true);
      expect(obs1?.reasoningText).toBe("thinking 1");
      expect(state.hadMeaningfulAdapterEvent).toBe(true);

      // Chunk 2: reasoning + details
      const chunk2 = {
        choices: [{
          delta: {
            reasoning: "thinking 2",
            reasoning_details: [{ type: "text", text: "detailed thought" }]
          }
        }]
      };
      const obs2 = openRouterAdapter.observeStreamChunk!(chunk2, state, context);
      expect(obs2?.meaningful).toBe(true);
      expect(obs2?.reasoningText).toBe("thinking 2detailed thought");

      // Chunk 3: opaque metadata (signature, encrypted data) must not be extracted
      const chunk3 = {
        choices: [{
          delta: {
            reasoning_details: { signature: "xyz123", payload: "opaque" }
          }
        }]
      };
      const obs3 = openRouterAdapter.observeStreamChunk!(chunk3, state, context);
      expect(obs3?.meaningful).toBe(true); // Still meaningful because reasoning_details is present
      expect(obs3?.reasoningText).toBeUndefined(); // Opaque details excluded
    });
  });

  describe("Stream Error Classification", () => {
    it("classifies top-level error and finish_reason: error correctly", () => {
      const state = openRouterAdapter.createAttemptState!(context);

      // Top level HTTP 200 stream error chunk
      const errorChunk = {
        error: {
          code: 429,
          type: "rate_limit",
          message: "Too many requests"
        }
      };

      const obs1 = openRouterAdapter.observeStreamChunk!(errorChunk, state, context);
      expect(obs1?.terminalError).toMatchObject({
        statusCode: 429,
        code: "429",
        errorType: "rate_limit",
        message: "Too many requests",
      });
      expect(state.terminalError).toBeDefined();

      // choices finish_reason error
      const finishReasonErrorChunk = {
        choices: [{
          index: 0,
          delta: {
            error: {
              code: 500,
              type: "server_error",
              message: "Upstream crashed"
            }
          },
          finish_reason: "error"
        }]
      };

      const state2 = openRouterAdapter.createAttemptState!(context);
      const obs2 = openRouterAdapter.observeStreamChunk!(finishReasonErrorChunk, state2, context);
      expect(obs2?.terminalError).toMatchObject({
        statusCode: 500,
        message: "Upstream crashed"
      });
      expect(state2.terminalError).toBeDefined();
    });
  });

  describe("Fake Stream Preservation", () => {
    it("retains all reasoning, tools, finish_reason, and usage in fake stream", async () => {
      const nonStreamData = {
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: "final text content",
            reasoning: "nonstream thinking",
            reasoning_details: [{ type: "text", text: "nonstream details" }]
          },
          finish_reason: "stop"
        }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 20,
          total_tokens: 30
        }
      };

      const policy = openRouterAdapter.getRequestPolicy!(context);
      const fakeStreamPolicy = policy.preserveFakeStreamFields
        ? { preserveFields: policy.preserveFakeStreamFields }
        : undefined;
      const { fakeStream, textToEmit } = createFakeStreamFromData(nonStreamData, context.modelId, "openai", fakeStreamPolicy);
      const payload = await readStreamText(fakeStream);

      expect(textToEmit).toBe("final text content");
      expect(payload).toContain('"reasoning":"nonstream thinking"');
      expect(payload).toContain('"reasoning_details":[{"type":"text","text":"nonstream details"}]');
      expect(payload).toContain('"content":"final text content"');
      expect(payload).toContain('"finish_reason":"stop"');
      expect(payload).toContain('"usage":{"prompt_tokens":10,"completion_tokens":20,"total_tokens":30}');
    });
  });
});

describe("openRouterAdapter §3: mid-stream error handling", () => {
  const context = {
    providerId: "openrouter-p",
    providerName: "OpenRouter",
    providerProtocol: "openai",
    rawBaseUrl: "https://openrouter.ai/api/v1",
    normalizedBaseUrl: "https://openrouter.ai/api/v1",
    hostname: "openrouter.ai",
    pathname: "/api/v1",
    modelId: "meta-llama/llama-3",
    incomingProtocol: "openai",
    requestPath: "/v1/chat/completions",
  };

  it("preserves real 429 from official combined format", () => {
    const state = openRouterAdapter.createAttemptState!(context);
    const chunk = {
      error: {
        code: 429,
        message: "Rate limit exceeded",
        metadata: { error_type: "rate_limit_exceeded" },
      },
      choices: [{
        delta: { content: "" },
        finish_reason: "error",
      }],
    };
    openRouterAdapter.observeStreamChunk!(chunk, state, context);
    expect(state.terminalError).toBeDefined();
    expect(state.terminalError.statusCode).toBe(429);
    expect(state.terminalError.errorType).toBe("rate_limit_exceeded");
    expect(state.terminalError.message).toBe("Rate limit exceeded");
  });

  it("uses metadata.error_type as canonical errorType", () => {
    const state = openRouterAdapter.createAttemptState!(context);
    const chunk = {
      error: {
        code: 503,
        message: "Provider overloaded",
        metadata: { error_type: "provider_overloaded" },
      },
    };
    openRouterAdapter.observeStreamChunk!(chunk, state, context);
    expect(state.terminalError.errorType).toBe("provider_overloaded");
  });

  it("finish_reason error only (no top-level error) uses generic 502", () => {
    const state = openRouterAdapter.createAttemptState!(context);
    const chunk = {
      choices: [{
        delta: {},
        finish_reason: "error",
      }],
    };
    openRouterAdapter.observeStreamChunk!(chunk, state, context);
    expect(state.terminalError).toMatchObject({
      statusCode: 502
    });
  });

  it("choice.error as fallback when no top-level error", () => {
    const state = openRouterAdapter.createAttemptState!(context);
    const chunk = {
      choices: [{
        delta: {},
        error: { code: 503, message: "Provider down" },
        finish_reason: "error",
      }],
    };
    openRouterAdapter.observeStreamChunk!(chunk, state, context);
    expect(state.terminalError).toBeDefined();
    expect(state.terminalError.statusCode).toBe(503);
    expect(state.terminalError.message).toBe("Provider down");
  });

  it("string code preserved as-is", () => {
    const state = openRouterAdapter.createAttemptState!(context);
    const chunk = {
      error: {
        code: "rate_limited",
        message: "Rate limited",
      },
    };
    openRouterAdapter.observeStreamChunk!(chunk, state, context);
    expect(state.terminalError.code).toBe("rate_limited");
  });

  it("missing code defaults to 502", () => {
    const state = openRouterAdapter.createAttemptState!(context);
    const chunk = {
      error: {
        message: "Something went wrong",
      },
    };
    openRouterAdapter.observeStreamChunk!(chunk, state, context);
    expect(state.terminalError.statusCode).toBe(502);
  });

  it("provider_overloaded maps to 503", () => {
    const state = openRouterAdapter.createAttemptState!(context);
    const chunk = {
      error: {
        message: "Overloaded",
        metadata: { error_type: "provider_overloaded" },
      },
    };
    openRouterAdapter.observeStreamChunk!(chunk, state, context);
    expect(state.terminalError.statusCode).toBe(503);
  });

  it("provider_unavailable maps to 503", () => {
    const state = openRouterAdapter.createAttemptState!(context);
    const chunk = {
      error: {
        message: "Unavailable",
        metadata: { error_type: "provider_unavailable" },
      },
    };
    openRouterAdapter.observeStreamChunk!(chunk, state, context);
    expect(state.terminalError.statusCode).toBe(503);
  });

  it("rate_limit_exceeded maps to 429", () => {
    const state = openRouterAdapter.createAttemptState!(context);
    const chunk = {
      error: {
        message: "Rate limited",
        metadata: { error_type: "rate_limit_exceeded" },
      },
    };
    openRouterAdapter.observeStreamChunk!(chunk, state, context);
    expect(state.terminalError.statusCode).toBe(429);
  });

  it("does not put raw error object in state.terminalError", () => {
    const state = openRouterAdapter.createAttemptState!(context);
    const chunk = {
      error: {
        code: 500,
        message: "Server error",
        metadata: { error_type: "upstream_error" },
      },
    };
    openRouterAdapter.observeStreamChunk!(chunk, state, context);
    const keys = Object.keys(state.terminalError).sort();
    expect(keys).toContain("code");
    expect(keys).toContain("errorType");
    expect(keys).toContain("message");
    expect(keys).toContain("statusCode");
  });
});

describe("openRouterAdapter classifyUpstreamError", () => {
  const context = {
    providerId: "openrouter-p",
    providerName: "OpenRouter",
    providerProtocol: "openai",
    rawBaseUrl: "https://openrouter.ai/api/v1",
    normalizedBaseUrl: "https://openrouter.ai/api/v1",
    hostname: "openrouter.ai",
    pathname: "/api/v1",
    modelId: "meta-llama/llama-3",
    incomingProtocol: "openai",
    requestPath: "/v1/chat/completions"
  };

  it("should precisely match Nvidia ResourceExhausted capacity errors", () => {
    const err = {
      message: "Upstream error from Nvidia: ResourceExhausted: Worker local total request limit reached (79/32)",
    };

    const result = openRouterAdapter.classifyUpstreamError!(
      { rawError: err, phase: "http" },
      context
    );

    expect(result).toBeDefined();
    expect(result?.statusCode).toBe(503);
    expect(result?.code).toBe("provider_capacity_exhausted");
    expect(result?.errorType).toBe("provider_overloaded");
    expect(result?.retryable).toBe(true);
    expect(result?.retryClass).toBe("provider_capacity");
    expect(result?.upstreamProvider).toBe("Nvidia");
    expect(result?.message).toContain("79/32");
  });

  it("should handle case variations and fallback upstreamProvider extraction", () => {
    const err = {
      message: "Upstream error from FOO: resource exhausted! local total request limit",
    };

    const result = openRouterAdapter.classifyUpstreamError!(
      { rawError: err, phase: "stream" },
      context
    );

    expect(result?.statusCode).toBe(503);
    expect(result?.upstreamProvider).toBe("FOO");
  });

  it("should prefer metadata.provider_name for upstream provider", () => {
    const err = {
      message: "Upstream error from FOO: ResourceExhausted: Worker local total request limit reached",
      metadata: {
        provider_name: "RealProvider"
      }
    };

    const result = openRouterAdapter.classifyUpstreamError!(
      { rawError: err, phase: "stream" },
      context
    );

    expect(result?.upstreamProvider).toBe("RealProvider");
  });

  it("should correctly classify authentication errors without retries", () => {
    const err = {
      type: "authentication",
      message: "Invalid API Key",
    };

    const result = openRouterAdapter.classifyUpstreamError!(
      { rawError: err, phase: "http" },
      context
    );

    expect(result?.statusCode).toBe(401);
    expect(result?.retryClass).toBe("authentication");
    expect(result?.retryable).toBe(true);
  });

  it("should correctly generate safeMetadata and sanitize non-whitelist fields", () => {
    const err = {
      type: "upstream_error",
      code: 400,
      message: "Something went wrong",
      metadata: {
        provider_name: "Google",
        secret_key: "sk-12345",
        model: "gemini-pro",
        request_id: "req-123"
      }
    };

    const result = openRouterAdapter.classifyUpstreamError!(
      { rawError: err, phase: "stream" },
      context
    );

    expect(result?.retryable).toBe(false);
    expect(result?.retryClass).toBe("unknown");
    expect(result?.fingerprint).toBeDefined();

    const safe = result?.safeMetadata;
    expect(safe?.provider_name).toBe("Google");
    expect(safe?.model).toBe("gemini-pro");
    expect(safe?.request_id).toBe("req-123");
    expect((safe as any)?.secret_key).toBeUndefined();
    expect(safe?._metadataKeys).toContain("secret_key");
  });

  it("should not use non-number codes as HTTP status codes", () => {
    const err = {
      code: "invalid_request_error",
      type: "invalid_request_error",
      message: "Bad request"
    };

    const result = openRouterAdapter.classifyUpstreamError!(
      { rawError: err, phase: "stream" },
      context
    );

    expect(result?.statusCode).toBe(502);
    expect(result?.code).toBe("invalid_request_error");
  });
});
