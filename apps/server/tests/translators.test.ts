import { describe, expect, it } from "vitest";
import { googleGemmaTranslator } from "../src/routes/gateway/translators/googleGemmaTranslator";
import type { TranslatorState, TranslatorContext } from "../src/routes/gateway/translators/types";
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

describe("googleGemmaTranslator", () => {
  describe("translateStreamChunk", () => {
    it("safely ignores non-Google model contexts", () => {
      const state: TranslatorState = {};
      const context: TranslatorContext = {
        modelId: "gpt-4o",
        providerProtocol: "openai",
      };
      const chunk = {
        choices: [
          {
            delta: {
              content: "<thought>this should not be translated since context is openai</thought>",
            },
          },
        ],
      };

      const modified = googleGemmaTranslator.translateStreamChunk(chunk, state, context);
      expect(modified).toBe(false);
      // Content must remain untouched
      expect(chunk.choices[0].delta.content).toContain("<thought>");
    });

    it("detects Google thought metadata even through OpenAI-compatible providers", () => {
      const state: TranslatorState = {};
      const context: TranslatorContext = {
        modelId: "gemini-2.5-pro",
        providerProtocol: "openai",
      };
      const chunk = {
        choices: [
          {
            delta: {
              content: "<thought>thinking...",
              extra_content: { google: { thought: true } },
            },
          },
        ],
      };

      const modified = googleGemmaTranslator.translateStreamChunk(chunk, state, context);
      expect(modified).toBe(true);
      expect(state.isGoogleGemmaStream).toBe(true);
      expect(chunk.choices[0].delta.reasoning_content).toBe("thinking...");
      expect((chunk.choices[0].delta as any).content).toBeUndefined();
      expect((chunk.choices[0].delta as any).extra_content).toBeUndefined();
    });

    it("splits same-chunk thought tags for OpenAI-compatible Gemini models", () => {
      const state: TranslatorState = {};
      const context: TranslatorContext = {
        modelId: "gemini-2.5-pro",
        providerProtocol: "openai",
      };
      const chunk = {
        choices: [
          {
            delta: {
              content: "<thought>private reasoning</thought>visible answer",
            },
          },
        ],
      };

      const modified = googleGemmaTranslator.translateStreamChunk(chunk, state, context);
      expect(modified).toBe(true);
      expect(chunk.choices[0].delta.reasoning_content).toBe("private reasoning");
      expect(chunk.choices[0].delta.content).toBe("visible answer");
    });

    it("splits thought tags across OpenAI-compatible Gemini stream chunks", () => {
      const state: TranslatorState = {};
      const context: TranslatorContext = {
        modelId: "gemini-2.5-pro",
        providerProtocol: "openai",
      };
      const chunk1 = {
        choices: [
          {
            delta: {
              content: "<thought>private",
            },
          },
        ],
      };
      const chunk2 = {
        choices: [
          {
            delta: {
              content: " reasoning</thought>visible answer",
            },
          },
        ],
      };

      const modified1 = googleGemmaTranslator.translateStreamChunk(chunk1, state, context);
      const modified2 = googleGemmaTranslator.translateStreamChunk(chunk2, state, context);

      expect(modified1).toBe(true);
      expect(chunk1.choices[0].delta.reasoning_content).toBe("private");
      expect((chunk1.choices[0].delta as any).content).toBeUndefined();
      expect(modified2).toBe(true);
      expect(chunk2.choices[0].delta.reasoning_content).toBe(" reasoning");
      expect(chunk2.choices[0].delta.content).toBe("visible answer");
    });

    it("activates on Google context and translates reasoning_content", () => {
      const state: TranslatorState = {};
      const context: TranslatorContext = {
        modelId: "gemma-4-31b-it",
        providerProtocol: "google",
      };

      // First chunk: contains extra_content thought flag
      const chunk1 = {
        choices: [
          {
            delta: {
              content: "<thought>thinking...",
              extra_content: { google: { thought: true } },
            },
          },
        ],
      };

      const modified1 = googleGemmaTranslator.translateStreamChunk(chunk1, state, context);
      expect(modified1).toBe(true);
      expect(state.isGoogleGemmaStream).toBe(true);
      expect(chunk1.choices[0].delta.reasoning_content).toBe("thinking...");
      expect((chunk1.choices[0].delta as any).content).toBeUndefined();

      // Second chunk: standard content chunk but in Gemma stream (strips closing tag)
      const chunk2 = {
        choices: [
          {
            delta: {
              content: "</thought>Hello world!",
            },
          },
        ],
      };

      const modified2 = googleGemmaTranslator.translateStreamChunk(chunk2, state, context);
      expect(modified2).toBe(true);
      expect(chunk2.choices[0].delta.content).toBe("Hello world!");
    });
  });

  describe("translateNonStreamMessage", () => {
    it("extracts reasoning and content for Google models", () => {
      const context: TranslatorContext = {
        modelId: "gemma-4-31b-it",
        providerProtocol: "google",
      };

      // Case 1: thought tags inside content
      const msg1 = {
        role: "assistant",
        content: "<thought>\nI am thinking.\n</thought>\nThis is my final answer.",
      };

      const modified1 = googleGemmaTranslator.translateNonStreamMessage(msg1, context);
      expect(modified1).toBe(true);
      expect(msg1.content).toBe("This is my final answer.");
      expect((msg1 as any).reasoning_content).toBe("\nI am thinking.\n");

      // Case 2: entire message is flagged as thought
      const msg2 = {
        role: "assistant",
        content: "<thought>pure thought</thought>",
        extra_content: { google: { thought: true } },
      };

      const modified2 = googleGemmaTranslator.translateNonStreamMessage(msg2, context);
      expect(modified2).toBe(true);
      expect(msg2.content).toBe("");
      expect((msg2 as any).reasoning_content).toBe("pure thought");
      expect((msg2 as any).extra_content).toBeUndefined();
    });

    it("keeps translated non-stream reasoning out of fake stream content", async () => {
      const context: TranslatorContext = {
        modelId: "gemini-2.5-pro",
        providerProtocol: "openai",
      };
      const data = {
        choices: [
          {
            message: {
              role: "assistant",
              content: "<thought>private reasoning</thought>visible answer",
            },
          },
        ],
      };

      const msg = data.choices[0].message;
      const modified = googleGemmaTranslator.translateNonStreamMessage(msg, context);
      const { fakeStream, textToEmit } = createFakeStreamFromData(data, context.modelId!);
      const payload = await readStreamText(fakeStream);

      expect(modified).toBe(true);
      expect(textToEmit).toBe("visible answer");
      expect(payload).toContain("\"reasoning_content\":\"private reasoning\"");
      expect(payload).toContain("\"content\":\"visible answer\"");
      expect(payload).not.toContain("<thought>");
    });

    it("does not modify non-Google messages", () => {
      const context: TranslatorContext = {
        modelId: "gpt-4",
        providerProtocol: "openai",
      };

      const msg = {
        role: "assistant",
        content: "<thought>pure thought</thought>",
      };

      const modified = googleGemmaTranslator.translateNonStreamMessage(msg, context);
      expect(modified).toBe(false);
      expect(msg.content).toBe("<thought>pure thought</thought>");
      expect((msg as any).reasoning_content).toBeUndefined();
    });
  });
});
