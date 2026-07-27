import { describe, it, expect, beforeEach } from "vitest";
import { openRouterAdapter } from "../src/routes/gateway/providerAdapters/openRouterAdapter";
import { ProviderAdapterContext } from "../src/routes/gateway/providerAdapters/types";

describe("OpenRouter Adapter - Non-Stream Audit", () => {
  let state: any;
  let context: ProviderAdapterContext;

  beforeEach(() => {
    state = openRouterAdapter.createAttemptState({} as any);
    context = {
      rawBaseUrl: "https://openrouter.ai/api/v1",
      incomingProtocol: "openai",
      overrideModel: "test-model",
      apiKey: "test-key"
    } as ProviderAdapterContext;
  });

  describe("OpenAI format", () => {
    it("extracts reasoning_content to observation.reasoningText", () => {
      const responseCopy = {
        choices: [
          {
            message: {
              role: "assistant",
              content: "Hello",
              reasoning_content: "This is some reasoning.",
            },
          },
        ],
      };
      const obs = openRouterAdapter.observeNonStreamResponse(responseCopy, state, context);
      expect(obs).toBeDefined();
      if (obs) {
        expect(obs.meaningful).toBe(true);
        expect(obs.reasoningText).toBe("This is some reasoning.");
      }

      // Verify responseData.data remains unmodified
      expect(responseCopy.choices[0].message.reasoning_content).toBe("This is some reasoning.");
    });

    it("extracts reasoning to observation.reasoningText", () => {
      const responseCopy = {
        choices: [
          {
            message: {
              role: "assistant",
              content: "Hello",
              reasoning: "Thinking about it.",
            },
          },
        ],
      };
      const obs = openRouterAdapter.observeNonStreamResponse(responseCopy, state, context);
      expect(obs).toBeDefined();
      if (obs) {
        expect(obs.meaningful).toBe(true);
        expect(obs.reasoningText).toBe("Thinking about it.");
      }
    });

    it("extracts reasoning_details text fields to observation.reasoningText", () => {
      const responseCopy = {
        choices: [
          {
            message: {
              role: "assistant",
              content: "Hello",
              reasoning_details: [
                { type: "text", text: "Detail 1." },
                { type: "text", content: "Detail 2." },
                { type: "text", summary: "Detail 3." },
              ],
            },
          },
        ],
      };
      const obs = openRouterAdapter.observeNonStreamResponse(responseCopy, state, context);
      expect(obs).toBeDefined();
      if (obs) {
        expect(obs.meaningful).toBe(true);
        expect(obs.reasoningText).toBe("Detail 1.Detail 2.Detail 3.");
      }
    });

    it("does not record encrypted payloads from reasoning_details", () => {
      const responseCopy = {
        choices: [
          {
            message: {
              role: "assistant",
              content: "Hello",
              reasoning_details: [
                { type: "text", text: "Readable." },
                { type: "encrypted", signature: "sig123", ciphertext: "encrypted_data" },
                { encrypted: true, payload: "more_opaque_data" }
              ],
            },
          },
        ],
      };
      const obs = openRouterAdapter.observeNonStreamResponse(responseCopy, state, context);
      expect(obs).toBeDefined();
      if (obs) {
        expect(obs.meaningful).toBe(true);
        expect(obs.reasoningText).toBe("Readable.");
      }
    });
  });

  describe("Native Anthropic format", () => {
    beforeEach(() => {
      context.incomingProtocol = "anthropic";
    });

    it("extracts thinking block text", () => {
      const responseCopy = {
        content: [
          { type: "thinking", thinking: "Anthropic thinking block." },
          { type: "text", text: "Hello from Anthropic." }
        ]
      };
      const obs = openRouterAdapter.observeNonStreamResponse(responseCopy, state, context);
      expect(obs).toBeDefined();
      if (obs) {
        expect(obs.meaningful).toBe(true);
        expect(obs.reasoningText).toBe("Anthropic thinking block.");
      }

      // Ensure data remains unmodified
      expect(responseCopy.content[0].type).toBe("thinking");
    });

    it("handles redacted_thinking marking meaningful without recording text", () => {
      const responseCopy = {
        content: [
          { type: "redacted_thinking", data: "encrypted_stuff" },
          { type: "text", text: "Hello" }
        ]
      };
      const obs = openRouterAdapter.observeNonStreamResponse(responseCopy, state, context);
      expect(obs).toBeDefined();
      if (obs) {
        expect(obs.meaningful).toBe(true);
        expect(obs.reasoningText).toBeUndefined();
      }
    });

    it("handles both redacted_thinking and thinking together", () => {
      const responseCopy = {
        content: [
          { type: "redacted_thinking", data: "encrypted_stuff" },
          { type: "thinking", thinking: "But some text." },
          { type: "text", text: "Hello" }
        ]
      };
      const obs = openRouterAdapter.observeNonStreamResponse(responseCopy, state, context);
      expect(obs).toBeDefined();
      if (obs) {
        expect(obs.meaningful).toBe(true);
        expect(obs.reasoningText).toBe("But some text.");
      }
    });
  });
});
