import { extractTextFromContent } from "./chatText";
import {
  computeContentHash,
  stableStringify,
  looksLikeChatMessage,
  looksLikeContentBlock,
  stripReasoningMarkers,
  tryParseJson
} from "./chatTurnsUtils";
import { TurnInputSelection } from "./chatTurnsTypes";

export function getMessagesFromParsedRequest(parsed: any): any[] {
  if (!parsed) return [];
  if (Array.isArray(parsed)) {
    if (parsed.every(looksLikeChatMessage)) return parsed;
    if (parsed.every(looksLikeContentBlock)) {
      return [{ role: "user", content: parsed }];
    }
    return [];
  }
  if (Array.isArray(parsed.messages)) return parsed.messages;
  if (Array.isArray(parsed.contents)) return parsed.contents;
  return [];
}

export function selectCurrentInputMessages(messages: any[]): TurnInputSelection {
  if (messages.length === 0) return { messages: [], startIndex: -1 };

  let lastAssistantIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") {
      lastAssistantIndex = i;
      break;
    }
  }

  const suffixStart = lastAssistantIndex + 1;
  const suffix = messages.slice(suffixStart);

  for (let i = 0; i < suffix.length; i++) {
    if (suffix[i]?.role === "user") {
      const absoluteIndex = suffixStart + i;
      const selected = [suffix[i]];

      for (const following of suffix.slice(i + 1)) {
        if (following?.role && following.role !== "system") {
          selected.push(following);
        }
      }

      return { messages: selected, startIndex: absoluteIndex };
    }
  }

  const nonSystemSuffix = suffix.filter((message) => message?.role !== "system");
  if (nonSystemSuffix.length > 0) {
    const first = nonSystemSuffix[0];
    return {
      messages: nonSystemSuffix,
      startIndex: messages.findIndex((message) => message === first),
    };
  }

  return {
    messages: [messages[messages.length - 1]],
    startIndex: messages.length - 1,
  };
}

export function normalizeToolCalls(toolCalls: any[]): string {
  return stableStringify(
    toolCalls.map((toolCall) => ({
      type: toolCall.type || "function",
      name: toolCall.function?.name || toolCall.name,
      arguments: toolCall.function?.arguments || toolCall.input || toolCall.arguments,
    })),
  );
}

export function normalizeAssistantMessageToComparableText(message: any): string {
  if (!message) return "";

  if (Array.isArray(message.content)) {
    const toolBlocks = message.content.filter((block: any) => block?.type === "tool_use");
    if (toolBlocks.length > 0) {
      return stableStringify(
        toolBlocks.map((block: any) => ({
          type: block.type,
          name: block.name,
          input: block.input,
        })),
      );
    }
  }

  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    return normalizeToolCalls(message.tool_calls);
  }

  const textContent = extractTextFromContent(message.content);
  if (textContent) return stripReasoningMarkers(textContent);

  return "";
}

export function extractPreviousAssistantText(messages: any[], currentStartIndex: number): string | null {
  const searchStart = currentStartIndex >= 0 ? currentStartIndex - 1 : messages.length - 1;
  for (let i = searchStart; i >= 0; i--) {
    if (messages[i]?.role === "assistant") {
      const text = normalizeAssistantMessageToComparableText(messages[i]);
      return text || null;
    }
  }
  return null;
}

export function extractTextFromResponsesOutput(output: any): string {
  if (typeof output === "string") return output;
  if (!Array.isArray(output)) return "";

  return output
    .map((item) => {
      if (typeof item === "string") return item;
      if (Array.isArray(item?.content)) {
        return item.content
          .map((part: any) => part?.text || part?.content || "")
          .filter(Boolean)
          .join("\n");
      }
      return item?.text || item?.content || "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

export function extractConversationRoot(messages: any[]): string | null {
  if (messages.length === 0) return null;

  const rootParts: string[] = [];

  // Extract system prompt (first system message)
  for (const msg of messages) {
    if (msg?.role === "system") {
      const text = extractTextFromContent(msg.content);
      if (text) rootParts.push(`system:${text}`);
      break;
    }
  }

  // Extract first user message
  for (const msg of messages) {
    if (msg?.role === "user") {
      const text = extractTextFromContent(msg.content);
      if (text) rootParts.push(`user:${text}`);
      break;
    }
  }

  if (rootParts.length === 0) return null;
  return computeContentHash(rootParts.join("\n"));
}

export function normalizeAssistantResponseToComparableText(text: string | null | undefined): string {
  if (!text) return "";

  const parsed = tryParseJson(text);
  if (!parsed) {
    // Plain text mode (from streaming responses)
    let stripped = stripReasoningMarkers(text);

    // Extract <tool_calls> tag content for hash computation
    const toolCallsMatch = text.match(/<tool_calls>([\s\S]*?)<\/tool_calls>/);
    if (toolCallsMatch) {
      // Remove <tool_calls> from text comparison
      stripped = stripped.replace(/<tool_calls>[\s\S]*?<\/tool_calls>/gi, "").trim();
      if (!stripped) {
        // Only tool_calls, no text → use tool_calls content for hash
        try {
          const toolCalls = JSON.parse(toolCallsMatch[1]);
          return normalizeToolCalls(toolCalls);
        } catch { /* fallback to empty */ }
      }
    }
    return stripped;
  }

  const choice = parsed.choices?.[0];
  if (choice?.message) {
    if (Array.isArray(choice.message.tool_calls) && choice.message.tool_calls.length > 0) {
      return normalizeToolCalls(choice.message.tool_calls);
    }
    const content = extractTextFromContent(choice.message.content);
    if (content) return stripReasoningMarkers(content);
  }

  if (choice?.text) return stripReasoningMarkers(String(choice.text));

  if (Array.isArray(parsed.content)) {
    const toolBlocks = parsed.content.filter((block: any) => block?.type === "tool_use");
    if (toolBlocks.length > 0) {
      return stableStringify(
        toolBlocks.map((block: any) => ({
          type: block.type,
          name: block.name,
          input: block.input,
        }))
      );
    }

    const content = extractTextFromContent(parsed.content);
    if (content) return stripReasoningMarkers(content);
  }

  if (parsed.content && typeof parsed.content === "string") {
    return stripReasoningMarkers(parsed.content);
  }

  if (parsed.output_text) return stripReasoningMarkers(String(parsed.output_text));

  const outputText = extractTextFromResponsesOutput(parsed.output);
  if (outputText) return stripReasoningMarkers(outputText);

  return "";
}
