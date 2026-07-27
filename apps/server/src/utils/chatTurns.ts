import { tryParseJson, computeContentHash, serializeMessagesForLog, serializeContentForLog, normalizeValueForFingerprint, normalizeLargeString } from "./chatTurnsUtils";
import {
  getMessagesFromParsedRequest,
  selectCurrentInputMessages,
  extractPreviousAssistantText,
  normalizeAssistantResponseToComparableText,
  extractConversationRoot
} from "./chatTurnsFormatter";
import { NormalizedTurnPayload } from "./chatTurnsTypes";

export * from "./chatTurnsTypes";
export * from "./chatTurnsUtils";
export * from "./chatTurnsFormatter";
export * from "./chatTurnsPrompts";
export * from "./chatTurnsDetector";

export function fingerprintLogInput(inputText: string | null | undefined): string | null {
  if (!inputText) return null;
  const parsed = tryParseJson(inputText);
  const comparable = parsed === null ? normalizeLargeString(inputText) : normalizeValueForFingerprint(parsed);
  const fingerprintSource = typeof comparable === "string" ? comparable : JSON.stringify(comparable);
  if (!fingerprintSource.trim()) return null;
  return computeContentHash(fingerprintSource);
}

export function normalizeChatLogTurn(inputText: string | null | undefined, outputText: string | null | undefined): NormalizedTurnPayload {
  const parsedInput = tryParseJson(inputText);
  const messages = getMessagesFromParsedRequest(parsedInput);
  const currentInput = selectCurrentInputMessages(messages);

  let finalInputText: string | null = null;
  if (currentInput.messages.length > 0) {
    finalInputText = serializeMessagesForLog(currentInput.messages);
  } else if (parsedInput?.prompt !== undefined) {
    finalInputText = serializeContentForLog(parsedInput.prompt);
  } else if (parsedInput?.input !== undefined) {
    finalInputText = serializeContentForLog(parsedInput.input);
  } else if (parsedInput !== null) {
    finalInputText = JSON.stringify(parsedInput);
  } else {
    finalInputText = inputText || null;
  }

  const previousAssistantText = messages.length > 0
    ? extractPreviousAssistantText(messages, currentInput.startIndex)
    : null;

  const responseComparableText = normalizeAssistantResponseToComparableText(outputText);

  const conversationRootHash = extractConversationRoot(messages);

  return {
    inputText: finalInputText,
    inputFingerprint: fingerprintLogInput(finalInputText),
    previousAssistantText,
    previousAssistantHash: previousAssistantText ? computeContentHash(previousAssistantText) : null,
    responseComparableText,
    responseHash: responseComparableText ? computeContentHash(responseComparableText) : null,
    conversationRootHash,
    hasConversationContext: messages.length > currentInput.messages.length,
    messageCount: messages.length,
  };
}
