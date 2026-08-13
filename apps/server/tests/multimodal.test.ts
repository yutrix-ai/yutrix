import { describe, expect, it } from "vitest";
import {
  normalizeImageBlock,
  normalizeOpenAIContentParts,
  NormalizedLogInfo
} from "../src/utils/multimodal";
import {
  adaptRequestProtocol
} from "../src/routes/gateway/protocolAdapter";
import {
  extractTextFromContent,
  extractLastAssistantContent
} from "../src/utils/chatText";
import {
  computeContentHash,
  fingerprintLogInput,
  normalizeChatLogTurn,
  normalizeAssistantResponseToComparableText,
  looksLikeContinuationRequest,
  looksLikeClientSidecarText,
  looksLikeClientSidecarRequestRaw,
  detectAIClient,
  extractTitleRequestSubjectText,
  extractEmbeddedTaskPromptText,
  extractEmbeddedPromptCandidatesFromOutput
} from "../src/utils/chatTurns";

describe("multimodal image normalization", () => {
  it("keeps standard OpenAI image_url intact and detects it (without setting normalized)", () => {
    const logInfo: NormalizedLogInfo = { detected: false, normalized: false, details: [] };
    const block = {
      type: "image_url",
      image_url: { url: "data:image/png;base64,iVBORw0KGgoAAAANS" }
    };
    const res = normalizeImageBlock(block, logInfo);
    expect(res).toBe(block); // strict reference equality, no copy or rewrite
    expect(logInfo.detected).toBe(true);
    expect(logInfo.normalized).toBe(false); // not rewritten
    expect(logInfo.details).toEqual([
      {
        from: "image_url",
        to: "image_url",
        mediaType: "image/png",
        isDataUrl: true
      }
    ]);
  });

  it("converts Anthropic base64 image to OpenAI image_url and sets normalized flag", () => {
    const logInfo: NormalizedLogInfo = { detected: false, normalized: false, details: [] };
    const block = {
      type: "image",
      source: {
        type: "base64",
        media_type: "image/jpeg",
        data: "abc"
      }
    };
    const res = normalizeImageBlock(block, logInfo);
    expect(res).toEqual({
      type: "image_url",
      image_url: {
        url: "data:image/jpeg;base64,abc"
      }
    });
    expect(logInfo.detected).toBe(true);
    expect(logInfo.normalized).toBe(true);
    expect(logInfo.details).toEqual([
      {
        from: "image (anthropic)",
        to: "image_url",
        mediaType: "image/jpeg",
        isDataUrl: true
      }
    ]);
  });

  it("converts Anthropic URL image to OpenAI image_url", () => {
    const logInfo: NormalizedLogInfo = { detected: false, normalized: false, details: [] };
    const block = {
      type: "image",
      source: {
        type: "url",
        url: "https://example.com/image.png"
      }
    };
    const res = normalizeImageBlock(block, logInfo);
    expect(res).toEqual({
      type: "image_url",
      image_url: {
        url: "https://example.com/image.png"
      }
    });
    expect(logInfo.detected).toBe(true);
    expect(logInfo.normalized).toBe(true);
    expect(logInfo.details[0]).toMatchObject({
      from: "image (anthropic-url)",
      to: "image_url",
      mediaType: "url",
      isDataUrl: false
    });
  });

  it("keeps Anthropic non-image block as-is", () => {
    const logInfo: NormalizedLogInfo = { detected: false, normalized: false, details: [] };
    const block = {
      type: "image",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: "abc"
      }
    };
    const res = normalizeImageBlock(block, logInfo);
    expect(res).toBe(block);
    expect(logInfo.detected).toBe(false);
    expect(logInfo.normalized).toBe(false);
  });

  it("converts AI SDK image blocks starting with image/", () => {
    const logInfo: NormalizedLogInfo = { detected: false, normalized: false, details: [] };
    const block = {
      type: "image",
      image: "abc",
      mimeType: "image/png"
    };
    const res = normalizeImageBlock(block, logInfo);
    expect(res).toEqual({
      type: "image_url",
      image_url: {
        url: "data:image/png;base64,abc"
      }
    });
    expect(logInfo.detected).toBe(true);
    expect(logInfo.normalized).toBe(true);
  });

  it("keeps AI SDK URL image blocks as URLs instead of wrapping them as base64", () => {
    const logInfo: NormalizedLogInfo = { detected: false, normalized: false, details: [] };
    const block = {
      type: "image",
      image: "https://example.com/photo.webp",
      mimeType: "image/webp"
    };
    const res = normalizeImageBlock(block, logInfo);
    expect(res).toEqual({
      type: "image_url",
      image_url: {
        url: "https://example.com/photo.webp"
      }
    });
    expect(logInfo.detected).toBe(true);
    expect(logInfo.normalized).toBe(true);
    expect(logInfo.details[0]).toMatchObject({
      from: "image (ai-sdk)",
      mediaType: "url",
      isDataUrl: false
    });
  });

  it("keeps AI SDK image blocks as-is if mimeType does not start with image/", () => {
    const logInfo: NormalizedLogInfo = { detected: false, normalized: false, details: [] };
    const block = {
      type: "image",
      image: "abc",
      mimeType: "application/octet-stream"
    };
    const res = normalizeImageBlock(block, logInfo);
    expect(res).toBe(block);
    expect(logInfo.detected).toBe(false);
    expect(logInfo.normalized).toBe(false);
  });

  it("converts AI SDK file blocks starting with image/", () => {
    const logInfo: NormalizedLogInfo = { detected: false, normalized: false, details: [] };
    const block = {
      type: "file",
      data: "abc",
      mimeType: "image/webp"
    };
    const res = normalizeImageBlock(block, logInfo);
    expect(res).toEqual({
      type: "image_url",
      image_url: {
        url: "data:image/webp;base64,abc"
      }
    });
    expect(logInfo.detected).toBe(true);
    expect(logInfo.normalized).toBe(true);
  });

  it("keeps AI SDK file blocks as-is if mimeType does not start with image/", () => {
    const logInfo: NormalizedLogInfo = { detected: false, normalized: false, details: [] };
    const block = {
      type: "file",
      data: "abc",
      mimeType: "application/pdf"
    };
    const res = normalizeImageBlock(block, logInfo);
    expect(res).toBe(block);
    expect(logInfo.detected).toBe(false);
    expect(logInfo.normalized).toBe(false);
  });

  it("converts OpenAI Responses-style input_image image_url to chat image_url", () => {
    const logInfo: NormalizedLogInfo = { detected: false, normalized: false, details: [] };
    const block = {
      type: "input_image",
      image_url: "data:image/png;base64,abc"
    };
    const res = normalizeImageBlock(block, logInfo);
    expect(res).toEqual({
      type: "image_url",
      image_url: {
        url: "data:image/png;base64,abc"
      }
    });
    expect(logInfo.detected).toBe(true);
    expect(logInfo.normalized).toBe(true);
    expect(logInfo.details[0]).toMatchObject({
      from: "input_image",
      to: "image_url",
      mediaType: "image/png",
      isDataUrl: true
    });
  });

  it("converts string image_url blocks to object image_url blocks", () => {
    const logInfo: NormalizedLogInfo = { detected: false, normalized: false, details: [] };
    const block = {
      type: "image_url",
      image_url: "https://example.com/image.jpg"
    };
    const res = normalizeImageBlock(block, logInfo);
    expect(res).toEqual({
      type: "image_url",
      image_url: {
        url: "https://example.com/image.jpg"
      }
    });
    expect(logInfo.detected).toBe(true);
    expect(logInfo.normalized).toBe(true);
  });

  it("normalizes array messages while keeping text intact", () => {
    const logInfo: NormalizedLogInfo = { detected: false, normalized: false, details: [] };
    const content = [
      { type: "text", text: "hello" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "xyz" } }
    ];
    const res = normalizeOpenAIContentParts(content, logInfo);
    expect(res[0]).toEqual({ type: "text", text: "hello" });
    expect(res[1]).toEqual({
      type: "image_url",
      image_url: { url: "data:image/png;base64,xyz" }
    });
    expect(logInfo.detected).toBe(true);
    expect(logInfo.normalized).toBe(true);
  });
});

describe("protocol adapter image logging", () => {
  it("does not log when standard OpenAI image input needs no rewrite", () => {
    const logEvents: any[] = [];
    const body = {
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
        ],
      }],
    };

    const { logInfo } = adaptRequestProtocol(
      body,
      "openai",
      false,
      false,
      "qwen3.7-plus",
      { requestId: "req-1", providerName: "羊毛" },
      (event: any) => logEvents.push(event),
    );

    expect(logInfo.detected).toBe(true);
    expect(logInfo.normalized).toBe(false);
    expect(logEvents).toEqual([]);
  });

  it("logs only when image input is actually normalized", () => {
    const logEvents: any[] = [];
    const body = {
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image_url", image_url: "data:image/png;base64,abc" },
        ],
      }],
    };

    const { logInfo } = adaptRequestProtocol(
      body,
      "openai",
      false,
      false,
      "qwen3.7-plus",
      { requestId: "req-1", providerName: "羊毛" },
      (event: any) => logEvents.push(event),
    );

    expect(logInfo.detected).toBe(true);
    expect(logInfo.normalized).toBe(true);
    expect(logEvents).toHaveLength(1);
    expect(logEvents[0].code).toBe("request.image_normalized");
  });

  it("strips response-only reasoning metadata from OpenAI message history", () => {
    const logEvents: any[] = [];
    const body = {
      messages: [
        {
          role: "assistant",
          content: "visible answer",
          reasoning_content: "private reasoning",
          reasoning: "provider reasoning",
          extra_content: { google: { thought: true } },
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "lookup", arguments: "{}" },
            },
          ],
        },
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: "hidden" },
            { type: "text", text: "visible block" },
          ],
        },
      ],
    };

    const { finalBody } = adaptRequestProtocol(
      body,
      "openai",
      false,
      true,
      "gemini-2.5-pro",
      { requestId: "req-1", providerName: "Google" },
      (event: any) => logEvents.push(event),
    );

    expect(finalBody.messages[0]).toMatchObject({
      role: "assistant",
      content: "visible answer",
      tool_calls: body.messages[0].tool_calls,
    });
    expect(finalBody.messages[0].reasoning_content).toBeUndefined();
    expect(finalBody.messages[0].reasoning).toBeUndefined();
    expect(finalBody.messages[0].extra_content).toBeUndefined();
    expect(finalBody.messages[1].content).toBe("visible block");
    expect(finalBody.model).toBe("gemini-2.5-pro");
  });

  it("uses null assistant content when adapting Anthropic tool_use to OpenAI tool_calls", () => {
    const body = {
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "97sajsr7",
              name: "Bash",
              input: { command: "ls -a" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "97sajsr7",
              content: ".:\nSKILL.md",
              cache_control: { type: "ephemeral" },
            },
          ],
        },
      ],
      tools: [
        {
          name: "Bash",
          description: "Run a shell command",
          input_schema: {
            type: "object",
            properties: { command: { type: "string" } },
          },
        },
      ],
    };

    const { finalBody } = adaptRequestProtocol(
      body,
      "anthropic",
      false,
      false,
      "gemma-4-31b-it",
      { requestId: "req-1", providerName: "Google" },
      () => {},
    );

    expect(finalBody.messages).toEqual([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "97sajsr7",
            type: "function",
            function: {
              name: "Bash",
              arguments: JSON.stringify({ command: "ls -a" }),
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "97sajsr7",
        content: ".:\nSKILL.md",
      },
    ]);
  });

  it("drops Anthropic thinking blocks when adapting tool history to OpenAI-compatible upstreams", () => {
    const body = {
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "private chain of thought",
              signature: "anthropic-signature",
            },
            {
              type: "tool_use",
              id: "toolu_1",
              name: "Bash",
              input: { command: "pwd" },
            },
          ],
        },
      ],
    };

    const { finalBody } = adaptRequestProtocol(
      body,
      "anthropic",
      false,
      false,
      "gemma-4-31b-it",
      { requestId: "req-1", providerName: "Google" },
      () => {},
    );

    expect(finalBody.messages).toEqual([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "toolu_1",
            type: "function",
            function: {
              name: "Bash",
              arguments: JSON.stringify({ command: "pwd" }),
            },
          },
        ],
      },
    ]);
  });

  it("collapses Anthropic text blocks and strips cache_control for OpenAI-compatible upstreams", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "<system-reminder>context</system-reminder>\n\n" },
            {
              type: "text",
              text: "请静默检查当前目录状态",
              cache_control: { type: "ephemeral" },
            },
          ],
        },
      ],
    };

    const { finalBody } = adaptRequestProtocol(
      body,
      "anthropic",
      false,
      false,
      "gemma-4-31b-it",
      { requestId: "req-1", providerName: "Google" },
      () => {},
    );

    expect(finalBody.messages[0]).toEqual({
      role: "user",
      content: "<system-reminder>context</system-reminder>\n\n请静默检查当前目录状态",
    });
  });

  it("hoists Anthropic system-like messages into one leading OpenAI system message", () => {
    const body = {
      system: [{ type: "text", text: "base system" }],
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "hello" }],
        },
        {
          role: "system",
          content: [{ type: "text", text: "late system reminder" }],
        },
      ],
    };

    const { finalBody } = adaptRequestProtocol(
      body,
      "anthropic",
      false,
      false,
      "gemma-4-31b-it",
      { requestId: "req-1", providerName: "Google" },
      () => {},
    );

    expect(finalBody.messages).toEqual([
      {
        role: "system",
        content: "base system\n\nlate system reminder",
      },
      {
        role: "user",
        content: "hello",
      },
    ]);
  });

  it("normalizes OpenAI assistant tool call history content to null", () => {
    const body = {
      messages: [
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "Read", arguments: "{\"file_path\":\"SKILL.md\"}" },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_1",
          content: "1\t# Skill",
        },
      ],
    };

    const { finalBody } = adaptRequestProtocol(
      body,
      "openai",
      false,
      false,
      "gemma-4-31b-it",
      { requestId: "req-1", providerName: "Google" },
      () => {},
    );

    expect(finalBody.messages[0].content).toBeNull();
    expect(finalBody.messages[1].content).toBe("1\t# Skill");
  });
});

describe("session merge text extraction", () => {
  it("keeps assistant content string unchanged", () => {
    const content = " Hello world!   ";
    expect(extractTextFromContent(content)).toBe("Hello world!");
  });

  it("extracts text from text block array", () => {
    const content = [{ type: "text", text: " Hello extract! " }];
    expect(extractTextFromContent(content)).toBe("Hello extract!");
  });

  it("extracts text and ignores image_url in mixed block arrays", () => {
    const content = [
      { type: "text", text: "Part 1" },
      { type: "image_url", image_url: { url: "data:image/png;base64,..." } },
      { type: "text", text: "Part 2" }
    ];
    expect(extractTextFromContent(content)).toBe("Part 1\nPart 2");
  });

  it("extracts assistant content from chat messages history", () => {
    const messages = [
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Response" },
          { type: "image_url", image_url: { url: "..." } }
        ]
      },
      { role: "user", content: "next turn" }
    ];
    expect(extractLastAssistantContent(messages)).toBe("Response");
  });
});

describe("chat turn normalization", () => {
  it("uses the latest user message instead of a trailing system message", () => {
    const request = {
      messages: [
        { role: "system", content: "system policy" },
        { role: "user", content: "那我想要查询所有的数据呢" },
        { role: "system", content: "client runtime note" }
      ]
    };

    const normalized = normalizeChatLogTurn(JSON.stringify(request), "好的");

    expect(normalized.inputText).toBe("那我想要查询所有的数据呢");
    expect(normalized.inputFingerprint).toBe(fingerprintLogInput("那我想要查询所有的数据呢"));
  });

  it("keeps the same turn fingerprint when runtime context changes", () => {
    const firstRequest = {
      messages: [
        { role: "system", content: "policy v1" },
        { role: "user", content: "执行计划" },
        { role: "system", content: "runtime trace: a" }
      ]
    };
    const secondRequest = {
      messages: [
        { role: "system", content: "policy v2" },
        { role: "assistant", content: "第一段返回" },
        { role: "user", content: "执行计划" },
        { role: "system", content: "runtime trace: b" }
      ]
    };

    const first = normalizeChatLogTurn(JSON.stringify(firstRequest), "第一段返回");
    const second = normalizeChatLogTurn(JSON.stringify(secondRequest), "第二段返回");

    expect(first.inputText).toBe("执行计划");
    expect(second.inputText).toBe("执行计划");
    expect(first.inputFingerprint).toBe(second.inputFingerprint);
  });

  it("hashes assistant replies by comparable visible content", () => {
    const previousAssistant = "可以通过 includeDeleted 参数实现。";
    const request = {
      messages: [
        { role: "user", content: "怎么查询所有数据" },
        { role: "assistant", content: previousAssistant },
        { role: "user", content: "继续" }
      ]
    };
    const response = `<think>内部推理不参与关联</think>\n${previousAssistant}`;

    const normalized = normalizeChatLogTurn(JSON.stringify(request), response);

    expect(normalized.previousAssistantHash).toBe(computeContentHash(previousAssistant));
    expect(normalized.responseHash).toBe(computeContentHash(previousAssistant));
    expect(normalizeAssistantResponseToComparableText(response)).toBe(previousAssistant);
  });

  it("extracts the original user prompt from Cursor-style title requests", () => {
    const titleRequest = [
      { role: "user", content: "Generate a title for this conversation:\n" },
      { role: "user", content: "review昨日提交的代码" }
    ];

    const subject = extractTitleRequestSubjectText(JSON.stringify(titleRequest));

    expect(subject).toBe("review昨日提交的代码");
    expect(fingerprintLogInput(subject)).toBe(fingerprintLogInput("review昨日提交的代码"));
  });

  it("extracts a subagent prompt embedded in task tool calls", () => {
    const taskPrompt = "I need you to do a thorough code review of yesterday's git commits.";
    const outputText = `<think>planning</think>\n<tool_calls>${JSON.stringify([
      {
        id: "call_1cc80c975aa74a28a8d18a3b",
        type: "function",
        function: {
          name: "task",
          arguments: JSON.stringify({
            description: "Review yesterday's code changes",
            subagent_type: "general",
            prompt: taskPrompt
          })
        }
      }
    ])}</tool_calls>`;

    expect(extractEmbeddedTaskPromptText(outputText)).toBe(taskPrompt);
  });

  it("extracts embedded prompt candidates from non-task tool calls", () => {
    const prompt = "Please inspect the latest CI failure and explain the root cause.";
    const outputText = JSON.stringify({
      choices: [{
        message: {
          tool_calls: [{
            id: "call_generic",
            type: "function",
            function: {
              name: "spawn_worker",
              arguments: JSON.stringify({ instructions: prompt })
            }
          }]
        }
      }]
    });

    expect(extractEmbeddedPromptCandidatesFromOutput(outputText)).toContain(prompt);
  });
});

describe("continuation request detection", () => {
  it("tool results are detected as continuation", () => {
    const input = '[{"role":"tool","content":"file content...","tool_call_id":"call_abc123"}]';
    expect(looksLikeContinuationRequest(input)).toBe(true);
  });

  it("multiple tool results are detected as continuation", () => {
    const input = '[{"role":"tool","content":"result1","tool_call_id":"call_1"},{"role":"tool","content":"result2","tool_call_id":"call_2"}]';
    expect(looksLikeContinuationRequest(input)).toBe(true);
  });

  it("title generation (Augment) is detected as continuation", () => {
    const input = 'You are coming up with a succinct title for a coding session based on...';
    expect(looksLikeContinuationRequest(input)).toBe(true);
  });

  it("title generation (Cursor) is detected as continuation", () => {
    const input = '[{"role":"user","content":"Generate a title for this conversation:\\n"}]';
    expect(looksLikeContinuationRequest(input)).toBe(true);
  });

  it("session tag is NOT detected as continuation", () => {
    const input = '[{"type":"text","text":"<session>\\nnew task\\n</session>"}]';
    expect(looksLikeContinuationRequest(input)).toBe(false);
  });

  it("plain user message is NOT detected as continuation", () => {
    const input = '请帮我修改这个文件';
    expect(looksLikeContinuationRequest(input)).toBe(false);
  });

  it("system-reminder with user content is NOT detected as continuation", () => {
    const input = '[{"type":"text","text":"<system-reminder>\\ncontext\\n</system-reminder>"},{"type":"text","text":"user question"}]';
    expect(looksLikeContinuationRequest(input)).toBe(false);
  });

  it("pure continuation prompt is detected as continuation", () => {
    expect(looksLikeContinuationRequest("继续")).toBe(true);
    expect(looksLikeContinuationRequest("continue")).toBe(true);
    expect(looksLikeContinuationRequest("go on")).toBe(true);
  });

  it("continuation prompt with extra user text is NOT detected as continuation", () => {
    expect(looksLikeContinuationRequest("继续，改成圆形")).toBe(false);
    expect(looksLikeContinuationRequest("continue generating the code")).toBe(false);
  });

  it("null/empty input is NOT detected as continuation", () => {
    expect(looksLikeContinuationRequest(null)).toBe(false);
    expect(looksLikeContinuationRequest("")).toBe(false);
  });
});

const SIDECAR_STAGE1 =
  "Stage 1 does NOT apply user intent or ALLOW exceptions — stage 2 will handle those.\n" +
  "Respond with <severity>N</severity> ONLY. Grade HARM ONLY — do NOT reduce for user intent. No other text.";

describe("client sidecar detection", () => {
  it("detects a harm-classifier envelope regardless of protocol wrapper", () => {
    const embedded =
      "AttributeError: 'NoneType' object has no attribute 'review_pass'\n" +
      SIDECAR_STAGE1;
    expect(looksLikeClientSidecarText(embedded)).toBe(true);

    const anthropicBody = {
      model: "claude-sonnet",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "<transcript>\nAttributeError: boom\n</transcript>\n" + SIDECAR_STAGE1 },
        ],
      }],
    };
    const openaiBody = {
      model: "gpt-4o",
      messages: [{
        role: "user",
        content: "<transcript>\nAttributeError: boom\n</transcript>\n" + SIDECAR_STAGE1,
      }],
    };
    expect(looksLikeClientSidecarRequestRaw(anthropicBody)).toBe(true);
    expect(looksLikeClientSidecarRequestRaw(openaiBody)).toBe(true);
  });

  it("does not treat a real debug paste as a sidecar", () => {
    expect(looksLikeClientSidecarText(
      "AttributeError: 'NoneType' object has no attribute 'review_pass'\n为什么模型这么笨，调用工具都能出错",
    )).toBe(false);
    expect(looksLikeClientSidecarRequestRaw({
      messages: [{ role: "user", content: "接口报错了，帮我排查一下" }],
    })).toBe(false);
  });

  it("does not treat a transcript review request as a sidecar", () => {
    expect(looksLikeClientSidecarText(
      "review this transcript and build a parser for AttributeError stacks",
    )).toBe(false);
  });

  it("still finds the envelope after a long prefix (markers sit at the end)", () => {
    const huge = "AttributeError: fail\n".repeat(2000) + SIDECAR_STAGE1;
    expect(looksLikeClientSidecarText(huge)).toBe(true);
  });
});

describe("AI client heuristic detection", () => {
  it("detects Claude Code from User-Agent or x-anthropic-client or path", () => {
    expect(detectAIClient({ "user-agent": "claude-code/1.0.0" }, {}, "/v1/messages")).toBe("Claude Code");
    expect(detectAIClient({ "x-anthropic-client": "claude-code" }, {}, "/v1/messages")).toBe("Claude Code");
    expect(detectAIClient({}, {}, "/v0/messages")).toBe("Claude Code");
  });

  it("detects Cursor from User-Agent or x-cursor-client", () => {
    expect(detectAIClient({ "user-agent": "Cursor/1.0.0" }, {}, "/v1/chat/completions")).toBe("Cursor");
    expect(detectAIClient({ "x-cursor-client": "true" }, {}, "/v1/chat/completions")).toBe("Cursor");
  });

  it("detects Augment Code from User-Agent", () => {
    expect(detectAIClient({ "user-agent": "Augment/1.0.0" }, {}, "/v1/chat/completions")).toBe("Augment Code");
  });

  it("detects OpenCode and Xcode from User-Agent", () => {
    expect(detectAIClient({ "user-agent": "OpenCode/2.0.0" }, {}, "/v1/chat/completions")).toBe("Codex CLI");
    expect(detectAIClient({ "user-agent": "CopilotForXcode/1.0" }, {}, "/v1/chat/completions")).toBe("Xcode");
  });

  it("detects clients from prompt contents/system instructions", () => {
    const bodyClaude = {
      messages: [{ role: "system", content: "You are Claude Code, a CLI assistant" }]
    };
    expect(detectAIClient({}, bodyClaude, "/v1/chat/completions")).toBe("Claude Code");

    const bodyCursor = {
      messages: [{ role: "system", content: "You are an expert AI programming assistant (Cursor)" }]
    };
    expect(detectAIClient({}, bodyCursor, "/v1/chat/completions")).toBe("Cursor");

    const bodyOpenCode = {
      messages: [{ role: "user", content: "Help me set up OpenCode settings" }]
    };
    expect(detectAIClient({}, bodyOpenCode, "/v1/chat/completions")).toBe("Codex CLI");
  });

  it("does NOT detect Claude Code from general prompt content unless explicitly instructed 'you are'", () => {
    const bodyClaudeMd = {
      messages: [{ role: "user", content: "This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository." }]
    };
    expect(detectAIClient({}, bodyClaudeMd, "/v1/chat/completions")).toBeNull();
  });

  it("detects Cline and Roo Code from prompt contents/system instructions", () => {
    const bodyCline = {
      messages: [{ role: "system", content: "You are Cline, a highly skilled software engineer..." }]
    };
    expect(detectAIClient({}, bodyCline, "/v1/chat/completions")).toBe("Cline");

    const bodyRoo = {
      messages: [{ role: "system", content: "You are Roo, a seasoned developer..." }]
    };
    expect(detectAIClient({}, bodyRoo, "/v1/chat/completions")).toBe("Roo Code");
  });
});
