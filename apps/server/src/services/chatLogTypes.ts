export type ChatLogPayload = {
  id?: string | null;
  requestId?: string | null;
  serverSessionId?: string | null;
  clientSessionId?: string | null;
  turnId?: number;
  userId: string;
  clientName?: string | null;
  detectedClient?: string | null;
  model?: string | null;
  inputText?: string | null;
  outputText?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
  status?: string;
  error?: string | null;
  apiKey?: string | null;
  noSummary?: boolean;
  ttftMs?: number | null;
  cachedTokens?: number | null;
  isAborted?: boolean | null;
};

export type SessionMatch = {
  serverSessionId: string;
  maxTurnId: number;
  reason: string;
};
