import { describe, expect, it } from "vitest";
import {
  buildGoogleNativeRequest,
  googleGenerateContentToOpenAI,
  googleNativeStreamToOpenAIStream,
  googleGenAIStreamToOpenAIStream,
  googleNativeBaseUrlOrigin,
} from "../src/routes/gateway/googleNativeAdapter";

async function readStream(stream: ReadableStream): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value);
  }
  return out;
}

describe("Google native adapter", () => {
  it("builds a Gemini native request from an OpenAI tool conversation", () => {
    const request = buildGoogleNativeRequest({
      providerName: "Google AI Studio",
      providerProtocol: "openai",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      modelId: "gemma-4-31b-it",
      isStreaming: true,
      body: {
        model: "gemma-4-31b-it",
        max_tokens: 8192,
        stream: true,
        messages: [
          { role: "system", content: "You are helpful." },
          { role: "user", content: "List files" },
          {
            role: "assistant",
            content: [{ type: "thinking", thinking: "hidden" }],
            tool_calls: [
              {
                id: "toolu_1",
                type: "function",
                function: {
                  name: "Bash",
                  arguments: JSON.stringify({ command: "ls" }),
                },
              },
            ],
          },
          {
            role: "tool",
            tool_call_id: "toolu_1",
            content: "SKILL.md",
          },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "Bash",
              description: "Run shell",
              parameters: {
                $schema: "https://json-schema.org/draft/2020-12/schema",
                type: "object",
                additionalProperties: false,
                properties: {
                  command: { type: "string", default: "ls" },
                },
                required: ["command"],
              },
            },
          },
        ],
      },
    });

    expect(request?.baseUrl).toBe("https://generativelanguage.googleapis.com/v1beta");
    expect(request?.upstreamPath).toBe("/models/gemma-4-31b-it:streamGenerateContent?alt=sse");
    expect(request?.body).toMatchObject({
      systemInstruction: {
        parts: [{ text: "You are helpful." }],
      },
      generationConfig: {
        maxOutputTokens: 8192,
      },
      tools: [
        {
          functionDeclarations: [
            {
              name: "Bash",
              description: "Run shell",
              parameters: {
                type: "object",
                properties: {
                  command: { type: "string" },
                },
                required: ["command"],
              },
            },
          ],
        },
      ],
    });
    expect(request?.body.contents).toEqual([
      { role: "user", parts: [{ text: "List files" }] },
      {
        role: "model",
        parts: [{ functionCall: { name: "Bash", args: { command: "ls" } } }],
      },
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              name: "Bash",
              response: { value: "SKILL.md" },
            },
          },
        ],
      },
    ]);
  });

  it("converts Gemini function call responses to OpenAI tool calls", () => {
    const converted = googleGenerateContentToOpenAI(
      {
        responseId: "resp_1",
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: {
                    name: "Bash",
                    args: { command: "pwd" },
                  },
                },
              ],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 3,
          totalTokenCount: 13,
        },
      },
      "gemma-4-31b-it",
    );

    expect(converted.choices[0].message.content).toBeNull();
    expect(converted.choices[0].message.tool_calls[0]).toMatchObject({
      type: "function",
      function: {
        name: "Bash",
        arguments: JSON.stringify({ command: "pwd" }),
      },
    });
    expect(converted.choices[0].finish_reason).toBe("tool_calls");
    expect(converted.usage).toMatchObject({
      prompt_tokens: 10,
      completion_tokens: 3,
      total_tokens: 13,
    });
  });

  it("converts Gemini native SSE chunks to OpenAI SSE chunks", async () => {
    const encoder = new TextEncoder();
    const upstream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              candidates: [
                {
                  content: {
                    parts: [{ text: "hello" }],
                  },
                },
              ],
            })}\n\n`,
          ),
        );
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              candidates: [{ finishReason: "STOP" }],
              usageMetadata: {
                promptTokenCount: 5,
                candidatesTokenCount: 1,
                totalTokenCount: 6,
              },
            })}\n\n`,
          ),
        );
        controller.close();
      },
    });

    const text = await readStream(googleNativeStreamToOpenAIStream(upstream, "gemma-4-31b-it"));
    expect(text).toContain("\"object\":\"chat.completion.chunk\"");
    expect(text).toContain("\"content\":\"hello\"");
    expect(text).toContain("\"finish_reason\":\"stop\"");
    expect(text).toContain("\"prompt_tokens\":5");
    expect(text).toContain("data: [DONE]");
  });

  it("emits OpenAI-compatible role, split tool call, and terminal chunks when Gemini omits finishReason", async () => {
    const encoder = new TextEncoder();
    const upstream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              candidates: [
                {
                  content: {
                    parts: [
                      {
                        functionCall: {
                          name: "WebFetch",
                          args: { url: "https://opencode.ai" },
                        },
                      },
                    ],
                  },
                },
              ],
            })}\n\n`,
          ),
        );
        controller.close();
      },
    });

    const text = await readStream(googleNativeStreamToOpenAIStream(upstream, "gemma-4-31b-it"));
    const events = text
      .split("\n\n")
      .map((event) => event.trim())
      .filter((event) => event.startsWith("data: ") && event !== "data: [DONE]")
      .map((event) => JSON.parse(event.slice("data: ".length)));

    expect(events[0].choices[0].delta).toEqual({ role: "assistant" });
    expect(events[1].choices[0].delta.tool_calls[0]).toMatchObject({
      index: 0,
      type: "function",
      function: {
        name: "WebFetch",
        arguments: "",
      },
    });
    expect(events[2].choices[0].delta.tool_calls[0]).toMatchObject({
      index: 0,
      function: {
        arguments: JSON.stringify({ url: "https://opencode.ai" }),
      },
    });
    expect(events[3].choices[0].finish_reason).toBe("tool_calls");
    expect(text).toContain("data: [DONE]");
  });

  it("converts SDK AsyncGenerator stream into OpenAI-compatible SSE ReadableStream", async () => {
    async function* mockSdkStream() {
      yield {
        candidates: [
          {
            content: {
              parts: [{ text: "hello" }],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: {
          promptTokenCount: 5,
          candidatesTokenCount: 1,
          totalTokenCount: 6,
        },
      };
    }
    const stream = googleGenAIStreamToOpenAIStream(mockSdkStream(), "gemma-4-31b-it");
    const text = await readStream(stream);
    expect(text).toContain("\"object\":\"chat.completion.chunk\"");
    expect(text).toContain("\"content\":\"hello\"");
    expect(text).toContain("\"finish_reason\":\"stop\"");
    expect(text).toContain("\"prompt_tokens\":5");
    expect(text).toContain("data: [DONE]");
  });

  it("googleNativeBaseUrlOrigin returns origin-only URL (no version path)", () => {
    expect(googleNativeBaseUrlOrigin("https://generativelanguage.googleapis.com/v1beta/openai"))
      .toBe("https://generativelanguage.googleapis.com");
    expect(googleNativeBaseUrlOrigin("https://generativelanguage.googleapis.com/v1beta"))
      .toBe("https://generativelanguage.googleapis.com");
    expect(googleNativeBaseUrlOrigin("https://generativelanguage.googleapis.com"))
      .toBe("https://generativelanguage.googleapis.com");
    expect(googleNativeBaseUrlOrigin("https://custom-proxy.example.com/v1beta/openai"))
      .toBe("https://custom-proxy.example.com");
    expect(googleNativeBaseUrlOrigin("invalid-url"))
      .toBe("https://generativelanguage.googleapis.com");
  });

  it("merges consecutive messages of the same role in buildGoogleNativeRequest", () => {
    const request = buildGoogleNativeRequest({
      providerName: "Google AI Studio",
      providerProtocol: "openai",
      baseUrl: "https://generativelanguage.googleapis.com",
      modelId: "gemma-4-31b-it",
      isStreaming: false,
      body: {
        model: "gemma-4-31b-it",
        messages: [
          { role: "user", content: "hello" },
          { role: "user", content: "world" },
          { role: "assistant", tool_calls: [{ id: "c1", function: { name: "t1" } }, { id: "c2", function: { name: "t2" } }] },
          { role: "tool", tool_call_id: "c1", content: "r1" },
          { role: "tool", tool_call_id: "c2", content: "r2" }
        ]
      }
    });

    expect(request?.body.contents).toEqual([
      {
        role: "user",
        parts: [
          { text: "hello" },
          { text: "world" }
        ]
      },
      {
        role: "model",
        parts: [
          { functionCall: { name: "t1", args: {} } },
          { functionCall: { name: "t2", args: {} } }
        ]
      },
      {
        role: "user",
        parts: [
          { functionResponse: { name: "t1", response: { value: "r1" } } },
          { functionResponse: { name: "t2", response: { value: "r2" } } }
        ]
      }
    ]);
  });
});
