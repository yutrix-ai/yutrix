export type TurnInputSelection = {
  messages: any[];
  startIndex: number;
};

export type NormalizedTurnPayload = {
  inputText: string | null;
  inputFingerprint: string | null;
  previousAssistantText: string | null;
  previousAssistantHash: string | null;
  responseComparableText: string;
  responseHash: string | null;
  conversationRootHash: string | null;
  hasConversationContext: boolean;
  messageCount: number;
};
