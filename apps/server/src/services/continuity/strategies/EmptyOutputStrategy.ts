import { ContinuityStrategy, ContinuityContext, ContinuityDecision } from "../types";

function hasValidContentOrActionInPayload(parsedData: any): boolean {
  if (!parsedData || typeof parsedData !== "object") return false;

  const checkBlocks = (blocks: any[]): boolean => {
    if (!Array.isArray(blocks)) return false;
    for (const b of blocks) {
      if (!b) continue;
      if (typeof b === "string" && b.trim().length > 0) return true;
      if (typeof b === "object") {
        if (b.type === "tool_use" || b.type === "thinking" || b.type === "redacted_thinking") return true;
        if (typeof b.text === "string" && b.text.trim().length > 0) return true;
        if (typeof b.thinking === "string" && b.thinking.trim().length > 0) return true;
        if (b.tool_calls || b.function) return true;
      }
    }
    return false;
  };

  // 1. Check choices[0].message
  const message = parsedData.choices?.[0]?.message;
  if (message) {
    if (message.tool_calls && message.tool_calls.length > 0) return true;
    if (message.reasoning_content && message.reasoning_content.trim().length > 0) return true;
    if (typeof message.content === "string" && message.content.trim().length > 0) return true;
    if (Array.isArray(message.content) && checkBlocks(message.content)) return true;
  }

  // 2. Check top-level content (Anthropic style)
  if (typeof parsedData.content === "string" && parsedData.content.trim().length > 0) return true;
  if (Array.isArray(parsedData.content) && checkBlocks(parsedData.content)) return true;

  return false;
}

export class EmptyOutputStrategy implements ContinuityStrategy {
  name = "EmptyOutput";
  maxRetries = 2;

  async evaluate(context: ContinuityContext): Promise<ContinuityDecision> {
    const { responseData, originalBody, accumulatedCompletionText, streamResult } = context;

    // Check if responseData is valid and 200 OK
    if (!responseData || responseData.status >= 400) {
      return { shouldIntervene: false };
    }

    // For any streaming response (native stream or fake stream),
    // do not trigger empty output intervention before stream chunks finish flowing (streamResult).
    if (responseData?.isStream && !streamResult) {
      return { shouldIntervene: false };
    }

    // If stream already sent meaningful output to client or resulted in a terminal error, do not intervene.
    if (streamResult?.meaningfulClientOutputSent || streamResult?.terminalError) {
      return { shouldIntervene: false };
    }

    let parsedData = responseData?.data;

    // Check if the payload already contains valid text, reasoning, or tool actions
    if (hasValidContentOrActionInPayload(parsedData)) {
      return { shouldIntervene: false };
    }

    let textToCheck = accumulatedCompletionText || "";
    if (responseData?.isFakeStream && responseData?.fakeStreamText) {
      textToCheck = responseData.fakeStreamText;
    } else if (!parsedData && responseData?.isFakeStream && textToCheck) {
      try { parsedData = JSON.parse(textToCheck); } catch (_) {}
      if (hasValidContentOrActionInPayload(parsedData)) {
        return { shouldIntervene: false };
      }
    }

    // Check embedded tags in text
    if (textToCheck && (textToCheck.includes("<tool_calls>") || textToCheck.includes("\"tool_calls\""))) {
      return { shouldIntervene: false };
    }

    // Extract reasoning tags <reasoning> or <think>
    let reasoningText = "";
    if (parsedData?.choices?.[0]?.message?.reasoning_content) {
      reasoningText += parsedData.choices[0].message.reasoning_content;
    }
    if (textToCheck) {
      const rMatches = textToCheck.matchAll(/<reasoning>([\s\S]*?)<\/reasoning>/g);
      for (const m of rMatches) { reasoningText += m[1].trim(); }
      const tMatches = textToCheck.matchAll(/<think>([\s\S]*?)<\/think>/g);
      for (const m of tMatches) { reasoningText += m[1].trim(); }
    }

    let cleanVisibleText = textToCheck
      .replace(/<reasoning>[\s\S]*?<\/reasoning>/g, "")
      .replace(/<think>[\s\S]*?<\/think>/g, "")
      .trim();

    // Condition for 0-Token Empty Output hit:
    // visible text is empty, reasoning text is empty, and NO valid content/action blocks exist.
    const isEmptyOutputHit = cleanVisibleText === "" && reasoningText.trim() === "";

    if (isEmptyOutputHit) {
      const injectPrompt = "[System Guard Note]: The previous response was empty. Please continue processing the task and output the requested result.";
      const modifiedBody = { ...originalBody };

      if (modifiedBody.messages && Array.isArray(modifiedBody.messages)) {
        modifiedBody.messages = [...modifiedBody.messages];
        modifiedBody.messages.push({ role: "user", content: injectPrompt });
      } else if (modifiedBody.prompt && typeof modifiedBody.prompt === "string") {
        modifiedBody.prompt += "\n\n[System Guard Note]: The previous response was empty. Please continue processing the task.\n\nAssistant:";
      }

      return {
        shouldIntervene: true,
        strategyName: this.name,
        modifiedBody,
      };
    }

    return { shouldIntervene: false };
  }

  async onExhausted(context: ContinuityContext): Promise<any> {
    const { responseData } = context;
    const fallbackMsg = "\n\n*(系统提示：模型响应结果为空 [0-Token]，已自动终止等待。请轻微调整提示词或重试)*";

    if (responseData.data?.choices?.[0]?.message) {
      responseData.data.choices[0].message.content = (responseData.data.choices[0].message.content || "") + fallbackMsg;
    } else if (responseData.data?.content && Array.isArray(responseData.data.content)) {
      responseData.data.content.push({ type: "text", text: fallbackMsg });
    } else if (responseData.data) {
      responseData.data.response = (responseData.data.response || "") + fallbackMsg;
    }

    return responseData;
  }
}
