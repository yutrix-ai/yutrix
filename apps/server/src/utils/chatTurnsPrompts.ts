import { extractTextFromContent } from "./chatText";
import {
  EMBEDDED_PROMPT_KEYS,
  isRecord,
  looksLikeChatMessage,
  looksLikeTitleGenerationText,
  parseToolCallArguments,
  tryParseJson
} from "./chatTurnsUtils";
import { getMessagesFromParsedRequest } from "./chatTurnsFormatter";

function addPromptCandidate(candidates: string[], text: string, minLength = 20) {
  const trimmed = text.trim();
  if (!trimmed || looksLikeTitleGenerationText(trimmed)) return;

  const effectiveMinLength = /[\u4e00-\u9fff]/.test(trimmed)
    ? Math.min(minLength, 6)
    : minLength;
  if (trimmed.length < effectiveMinLength) return;
  if (!candidates.includes(trimmed)) candidates.push(trimmed);
}

function collectPromptCandidatesFromValue(value: any, candidates: string[], keyHint?: string) {
  if (value === null || value === undefined) return;

  const normalizedKey = keyHint?.toLowerCase();
  if (typeof value === "string") {
    if (normalizedKey && EMBEDDED_PROMPT_KEYS.has(normalizedKey)) {
      addPromptCandidate(candidates, value);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      if (looksLikeChatMessage(item)) {
        const text = extractTextFromContent(item.content);
        if (item.role === "user") {
          addPromptCandidate(candidates, text);
        }
      } else {
        collectPromptCandidatesFromValue(item, candidates, keyHint);
      }
    }
    return;
  }

  if (!isRecord(value)) return;

  for (const [key, nested] of Object.entries(value)) {
    collectPromptCandidatesFromValue(nested, candidates, key);
  }
}

function extractToolCallsFromAssistantOutput(outputText: string): any[] {
  const toolCalls: any[] = [];
  const parsed = tryParseJson(outputText);

  const choiceToolCalls = parsed?.choices?.[0]?.message?.tool_calls;
  if (Array.isArray(choiceToolCalls)) {
    toolCalls.push(...choiceToolCalls);
  }

  if (Array.isArray(parsed?.content)) {
    toolCalls.push(...parsed.content.filter((block: any) => block?.type === "tool_use"));
  }

  const toolCallsPattern = /<tool_calls>([\s\S]*?)<\/tool_calls>/gi;
  let match: RegExpExecArray | null;
  while ((match = toolCallsPattern.exec(outputText)) !== null) {
    try {
      const parsedToolCalls = JSON.parse(match[1]);
      if (Array.isArray(parsedToolCalls)) {
        toolCalls.push(...parsedToolCalls);
      }
    } catch {
      // Ignore malformed audit-only tool call blocks.
    }
  }

  return toolCalls;
}

function extractPromptCandidatesFromToolCalls(toolCalls: any[]): string[] {
  const candidates: string[] = [];
  for (const toolCall of toolCalls) {
    const args = parseToolCallArguments(
      toolCall?.function?.arguments || toolCall?.arguments || toolCall?.input,
    );
    collectPromptCandidatesFromValue(args, candidates);
  }

  return candidates;
}

export function extractEmbeddedPromptCandidatesFromOutput(outputText: string | null | undefined): string[] {
  if (!outputText) return [];
  return extractPromptCandidatesFromToolCalls(extractToolCallsFromAssistantOutput(outputText));
}

export function extractEmbeddedTaskPromptText(outputText: string | null | undefined): string | null {
  return extractEmbeddedPromptCandidatesFromOutput(outputText)[0] || null;
}

export function extractEmbeddedPromptCandidatesFromInput(inputText: string | null | undefined): string[] {
  if (!inputText) return [];

  const candidates: string[] = [];
  const parsed = tryParseJson(inputText);
  const messages = getMessagesFromParsedRequest(parsed);
  if (messages.length > 0) {
    const textMessages = messages
      .map((message) => ({
        role: message?.role,
        text: extractTextFromContent(message?.content).trim(),
      }))
      .filter((message) => !!message.text);

    if (textMessages.some((message) => looksLikeTitleGenerationText(message.text))) {
      for (const message of textMessages) {
        if (message.role && message.role !== "user" && message.role !== "assistant") continue;
        addPromptCandidate(candidates, message.text, 1);
      }
    }

    return candidates;
  }

  const rawText = (parsed === null ? inputText : extractTextFromContent(parsed)).trim();
  if (!rawText || !looksLikeTitleGenerationText(rawText)) return candidates;

  const strippedSubject = rawText
    .replace(/^[\s\S]*?(?:generate a title(?: for this conversation)?|generate a concise title|conversation title|chat title|会话标题|生成标题|概括标题):?\s*/i, "")
    .trim();
  if (strippedSubject && strippedSubject !== rawText) {
    addPromptCandidate(candidates, strippedSubject, 1);
  }

  const lines = rawText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const markerIndex = lines.findIndex((line) => looksLikeTitleGenerationText(line));
  for (let i = markerIndex + 1; i < lines.length; i++) {
    addPromptCandidate(candidates, lines[i], 1);
  }

  return candidates;
}

export function extractTitleRequestSubjectText(inputText: string | null | undefined): string | null {
  return extractEmbeddedPromptCandidatesFromInput(inputText)[0] || null;
}
