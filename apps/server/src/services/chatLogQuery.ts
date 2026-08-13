import { db } from "../db";
import { chatLogs } from "../db/schema";
import { eq, and, desc, gte, sql } from "drizzle-orm";
import {
  fingerprintLogInput,
  normalizeChatLogTurn,
  NormalizedTurnPayload,
  looksLikeContinuationRequest,
  tryParseJson,
  getMessagesFromParsedRequest,
  extractEmbeddedPromptCandidatesFromInput,
  extractEmbeddedPromptCandidatesFromOutput,
} from "../utils/chatTurns";
import { extractTextFromContent } from "../utils/chatText";
import { ChatLogPayload, SessionMatch } from "./chatLogTypes";
import {
  selectStickyModelFromLogRows,
  selectStickyTurnFromLogRows,
} from "./requestRoutingClass";

type MergeStrategy = {
  priority: number;
  name: string;
  run: () => Promise<SessionMatch | null>;
};

const RECENT_INPUT_MERGE_WINDOW_MS = 30 * 60 * 1000;
// Prefer under-merge: tighter windows for weak heuristic layers
const RECENT_ACTIVITY_WINDOW_MS = 2 * 60 * 1000; // 2 minutes
const BACKGROUND_HEURISTIC_WINDOW_MS = 90 * 1000; // 90 seconds
// Strong signal but not forever: continuous tool loops stay together;
// overnight / next-day unrelated tasks on the same project must split.
const PREVIOUS_ASSISTANT_WINDOW_MS = 4 * 60 * 60 * 1000; // 4 hours

export async function getSessionTurnStats(serverSessionId: string | null | undefined) {
  if (!serverSessionId) return { count: 0, maxTurnId: null as number | null };

  const rows = await db
    .select({
      count: sql<number>`COUNT(*)`,
      maxTurnId: sql<number | null>`MAX(${chatLogs.turnId})`,
    })
    .from(chatLogs)
    .where(eq(chatLogs.serverSessionId, serverSessionId));

  return {
    count: rows[0]?.count || 0,
    maxTurnId: rows[0]?.maxTurnId ?? null,
  };
}

function sameNullable(a: string | null | undefined, b: string | null | undefined) {
  return (a || "") === (b || "");
}

function normalizedInputFingerprint(inputText: string | null | undefined) {
  if (!inputText) return null;
  return normalizeChatLogTurn(inputText, null).inputFingerprint || fingerprintLogInput(inputText);
}

async function findSessionByClientSessionId(payload: ChatLogPayload) {
  if (!payload.clientSessionId) return null;

  const match = await db
    .select({
      serverSessionId: chatLogs.serverSessionId,
      maxTurnId: sql<number>`MAX(${chatLogs.turnId})`,
    })
    .from(chatLogs)
    .where(
      and(
        eq(chatLogs.userId, payload.userId),
        eq(chatLogs.clientSessionId, payload.clientSessionId),
      ),
    )
    .groupBy(chatLogs.serverSessionId)
    .orderBy(desc(sql`MAX(${chatLogs.createdAt})`))
    .limit(1);

  if (match.length === 0 || !match[0].serverSessionId) return null;
  return {
    serverSessionId: match[0].serverSessionId,
    maxTurnId: match[0].maxTurnId || 0,
    reason: "client-session-id",
  };
}

/**
 * Priority 1 — previous-assistant.
 * Match the exact hash of the prior assistant response, but only within a
 * bounded activity window. Unbounded hash chaining caused multi-day unrelated
 * coding-agent tasks on the same project to collapse into mega-sessions.
 */
async function findSessionByPreviousAssistant(payload: ChatLogPayload, previousAssistantHash: string | null) {
  if (!previousAssistantHash) return null;

  const cutoff = new Date(Date.now() - PREVIOUS_ASSISTANT_WINDOW_MS);
  const match = await db
    .select({
      serverSessionId: chatLogs.serverSessionId,
      maxTurnId: sql<number>`MAX(${chatLogs.turnId})`,
    })
    .from(chatLogs)
    .where(
      and(
        eq(chatLogs.userId, payload.userId),
        eq(chatLogs.responseHash, previousAssistantHash),
        gte(chatLogs.createdAt, cutoff),
      ),
    )
    .groupBy(chatLogs.serverSessionId)
    .orderBy(desc(sql`MAX(${chatLogs.createdAt})`))
    .limit(1);

  if (match.length === 0 || !match[0].serverSessionId) return null;
  return {
    serverSessionId: match[0].serverSessionId,
    maxTurnId: match[0].maxTurnId || 0,
    reason: "previous-assistant",
  };
}

async function findRecentSessionByInput(payload: ChatLogPayload, inputFingerprint: string | null, hasConversationContext: boolean) {
  if (!inputFingerprint || hasConversationContext) return null;

  const cutoff = new Date(Date.now() - RECENT_INPUT_MERGE_WINDOW_MS);
  const candidates = await db
    .select({
      serverSessionId: chatLogs.serverSessionId,
      inputText: chatLogs.inputText,
      model: chatLogs.model,
      clientName: chatLogs.clientName,
      maxTurnId: sql<number>`MAX(${chatLogs.turnId})`,
      lastCreatedAt: sql<Date>`MAX(${chatLogs.createdAt})`,
    })
    .from(chatLogs)
    .where(and(eq(chatLogs.userId, payload.userId), gte(chatLogs.createdAt, cutoff)))
    .groupBy(chatLogs.serverSessionId)
    .orderBy(desc(sql`MAX(${chatLogs.createdAt})`))
    .limit(100);

  for (const candidate of candidates) {
    if (!candidate.serverSessionId) continue;
    if (candidate.serverSessionId === payload.serverSessionId) continue;
    if (!sameNullable(candidate.clientName, payload.clientName)) continue;
    if (normalizedInputFingerprint(candidate.inputText) !== inputFingerprint) continue;

    return {
      serverSessionId: candidate.serverSessionId,
      maxTurnId: candidate.maxTurnId || 0,
      reason: "recent-identical-input",
    };
  }

  return null;
}

async function findSessionByRecentEmbeddedPrompt(
  payload: ChatLogPayload,
  inputFingerprint: string | null,
  hasConversationContext: boolean,
) {
  if (!inputFingerprint || hasConversationContext) return null;

  const cutoff = new Date(Date.now() - RECENT_ACTIVITY_WINDOW_MS);
  const conditions = [
    eq(chatLogs.userId, payload.userId),
    gte(chatLogs.createdAt, cutoff),
  ];

  if (payload.clientName) {
    conditions.push(eq(chatLogs.clientName, payload.clientName));
  }

  const candidates = await db
    .select({
      serverSessionId: chatLogs.serverSessionId,
      inputText: chatLogs.inputText,
      outputText: chatLogs.outputText,
      turnId: chatLogs.turnId,
      createdAt: chatLogs.createdAt,
    })
    .from(chatLogs)
    .where(and(...conditions))
    .orderBy(desc(chatLogs.createdAt))
    .limit(100);

  const seenSessionIds = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate.serverSessionId) continue;
    if (candidate.serverSessionId === payload.serverSessionId) continue;
    if (seenSessionIds.has(candidate.serverSessionId)) continue;
    seenSessionIds.add(candidate.serverSessionId);

    const embeddedCandidates = [
      ...extractEmbeddedPromptCandidatesFromInput(candidate.inputText),
      ...extractEmbeddedPromptCandidatesFromOutput(candidate.outputText),
    ];
    if (!embeddedCandidates.some((candidateText) => fingerprintLogInput(candidateText) === inputFingerprint)) {
      continue;
    }

    const stats = await getSessionTurnStats(candidate.serverSessionId);
    return {
      serverSessionId: candidate.serverSessionId,
      maxTurnId: stats.maxTurnId ?? candidate.turnId ?? 0,
      reason: "embedded-prompt",
    };
  }

  return null;
}

async function findSessionByConversationRoot(payload: ChatLogPayload, conversationRootHash: string | null) {
  if (!conversationRootHash) return null;

  const cutoff = new Date(Date.now() - RECENT_INPUT_MERGE_WINDOW_MS);
  const match = await db
    .select({
      serverSessionId: chatLogs.serverSessionId,
      maxTurnId: sql<number>`MAX(${chatLogs.turnId})`,
    })
    .from(chatLogs)
    .where(
      and(
        eq(chatLogs.userId, payload.userId),
        eq(chatLogs.conversationRootHash, conversationRootHash),
        gte(chatLogs.createdAt, cutoff),
      ),
    )
    .groupBy(chatLogs.serverSessionId)
    .orderBy(desc(sql`MAX(${chatLogs.createdAt})`))
    .limit(1);

  if (match.length === 0 || !match[0].serverSessionId) return null;
  return {
    serverSessionId: match[0].serverSessionId,
    maxTurnId: match[0].maxTurnId || 0,
    reason: "conversation-root",
  };
}

/**
 * Priority 6 — recent-activity.
 * Prefer under-merge: only unambiguous continuation requests, same client signals,
 * short time window, and exactly one candidate session in that window.
 */
async function findSessionByRecentActivity(
  payload: ChatLogPayload,
  normalizedInputText: string | null,
) {
  if (!looksLikeContinuationRequest(normalizedInputText)) return null;

  const cutoff = new Date(Date.now() - RECENT_ACTIVITY_WINDOW_MS);

  const conditions = [
    eq(chatLogs.userId, payload.userId),
    gte(chatLogs.createdAt, cutoff),
  ];

  if (payload.clientName) {
    conditions.push(eq(chatLogs.clientName, payload.clientName));
  }

  if (payload.detectedClient) {
    conditions.push(eq(chatLogs.detectedClient, payload.detectedClient));
  }

  // Fetch 2 to detect ambiguity across concurrent sessions
  const matches = await db
    .select({
      serverSessionId: chatLogs.serverSessionId,
      maxTurnId: sql<number>`MAX(${chatLogs.turnId})`,
    })
    .from(chatLogs)
    .where(and(...conditions))
    .groupBy(chatLogs.serverSessionId)
    .orderBy(desc(sql`MAX(${chatLogs.createdAt})`))
    .limit(2);

  if (matches.length === 0 || !matches[0].serverSessionId) return null;

  // Multiple active sessions in the window → ambiguous → do not merge
  if (matches.length > 1) return null;

  return {
    serverSessionId: matches[0].serverSessionId,
    maxTurnId: matches[0].maxTurnId || 0,
    reason: "recent-activity",
  };
}

async function findSessionByContextOverlap(payload: ChatLogPayload, inputText: string | null | undefined) {
  if (!inputText) return null;

  const parsedInput = tryParseJson(inputText);
  const messages = getMessagesFromParsedRequest(parsedInput);

  let signatureText: string | null = null;

  if (messages.length > 1) {
    for (let i = messages.length - 2; i >= 0; i--) {
      const msg = messages[i];
      if (msg?.role === "user" || msg?.role === "assistant") {
        const text = extractTextFromContent(msg.content);
        if (text && text.length > 30) {
          signatureText = text;
          break;
        }
      }
    }
  } else if (messages.length === 1) {
    const msg = messages[0];
    const content = msg?.content;
    if (Array.isArray(content) && content.length > 1) {
      for (let i = content.length - 2; i >= 0; i--) {
        const block = content[i];
        const text = typeof block === "string" ? block : (block?.text || block?.content || "");
        if (typeof text === "string" && text.length > 20 && !text.startsWith("[Request interrupted")) {
          signatureText = text;
          break;
        }
      }
    }
  }

  if (!signatureText) return null;

  const cutoff = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2 hours
  const conditions = [
    eq(chatLogs.userId, payload.userId),
    gte(chatLogs.createdAt, cutoff),
  ];
  if (payload.clientName) {
    conditions.push(eq(chatLogs.clientName, payload.clientName));
  }

  const candidates = await db
    .select({
      serverSessionId: chatLogs.serverSessionId,
      inputText: chatLogs.inputText,
      outputText: chatLogs.outputText,
      maxTurnId: sql<number>`MAX(${chatLogs.turnId})`,
      lastCreatedAt: sql<Date>`MAX(${chatLogs.createdAt})`,
    })
    .from(chatLogs)
    .where(and(...conditions))
    .groupBy(chatLogs.serverSessionId)
    .orderBy(desc(sql`MAX(${chatLogs.createdAt})`))
    .limit(100);

  for (const cand of candidates) {
    if (!cand.serverSessionId) continue;
    if (cand.serverSessionId === payload.serverSessionId) continue;

    if (
      (cand.inputText && cand.inputText.includes(signatureText)) ||
      (cand.outputText && cand.outputText.includes(signatureText))
    ) {
      return {
        serverSessionId: cand.serverSessionId,
        maxTurnId: cand.maxTurnId || 0,
        reason: "context-overlap",
      };
    }
  }

  return null;
}

/**
 * Priority 7 — background-heuristic.
 * Prefer under-merge: only fire for clearly background patterns (title gen,
 * system-reminder, interrupted requests, etc.). Pure temporal fallback removed.
 * Requires same client signals and a unique candidate within a short window.
 */
async function findSessionByBackgroundHeuristics(payload: ChatLogPayload, inputText: string | null | undefined) {
  if (payload.clientSessionId) return null;
  if (!inputText) return null;

  const parsedInput = tryParseJson(inputText);
  const messages = getMessagesFromParsedRequest(parsedInput);

  const userOrAssistantMessages = messages.filter((m: any) => m?.role !== "system");
  if (userOrAssistantMessages.length > 1) return null;

  let text: string | null = null;
  if (messages.length === 1) {
    text = extractTextFromContent(messages[0]?.content);
  } else if (parsedInput === null) {
    text = inputText;
  } else {
    text = extractTextFromContent(parsedInput);
  }

  const isBackground = !!(text && (
    text.includes("<session>") ||
    text.includes("Title:") ||
    text.toLowerCase().includes("generate a title") ||
    text.includes("[Request interrupted") ||
    text.includes("Web page content:") ||
    text.includes("<system-reminder>")
  ));

  // Prefer under-merge: never merge ordinary single-shot traffic on pure time proximity
  if (!isBackground) return null;

  const cutoff = new Date(Date.now() - BACKGROUND_HEURISTIC_WINDOW_MS);
  const conditions = [
    eq(chatLogs.userId, payload.userId),
    gte(chatLogs.createdAt, cutoff),
  ];

  if (payload.clientName) {
    conditions.push(eq(chatLogs.clientName, payload.clientName));
  }

  if (payload.detectedClient) {
    conditions.push(eq(chatLogs.detectedClient, payload.detectedClient));
  }

  const candidates = await db
    .select({
      serverSessionId: chatLogs.serverSessionId,
      maxTurnId: sql<number>`MAX(${chatLogs.turnId})`,
      lastCreatedAt: sql<Date>`MAX(${chatLogs.createdAt})`,
    })
    .from(chatLogs)
    .where(and(...conditions))
    .groupBy(chatLogs.serverSessionId)
    .orderBy(desc(sql`MAX(${chatLogs.createdAt})`))
    .limit(2);

  if (candidates.length === 0 || !candidates[0].serverSessionId) return null;

  // Multiple candidates → ambiguous → do not merge
  if (candidates.length > 1) return null;

  return {
    serverSessionId: candidates[0].serverSessionId,
    maxTurnId: candidates[0].maxTurnId || 0,
    reason: "background-heuristic",
  };
}

export async function resolveSessionMatch(
  payload: ChatLogPayload,
  normalizedTurn: NormalizedTurnPayload,
  finalInputText: string | null | undefined,
) {
  const strategies: MergeStrategy[] = [
    {
      priority: 0,
      name: "client-session-id",
      run: () => findSessionByClientSessionId(payload),
    },
    {
      priority: 1,
      name: "previous-assistant",
      run: () => findSessionByPreviousAssistant(payload, normalizedTurn.previousAssistantHash),
    },
    {
      priority: 2,
      name: "conversation-root",
      run: () => findSessionByConversationRoot(payload, normalizedTurn.conversationRootHash),
    },
    {
      priority: 3,
      name: "recent-identical-input",
      run: () => findRecentSessionByInput(payload, normalizedTurn.inputFingerprint, normalizedTurn.hasConversationContext),
    },
    {
      priority: 4,
      name: "embedded-prompt",
      run: () => findSessionByRecentEmbeddedPrompt(payload, normalizedTurn.inputFingerprint, normalizedTurn.hasConversationContext),
    },
    {
      priority: 5,
      name: "context-overlap",
      run: () => findSessionByContextOverlap(payload, payload.inputText),
    },
    {
      priority: 6,
      name: "recent-activity",
      run: () => findSessionByRecentActivity(payload, finalInputText ?? null),
    },
    {
      priority: 7,
      name: "background-heuristic",
      run: () => findSessionByBackgroundHeuristics(payload, payload.inputText),
    },
  ];

  for (const strategy of strategies.sort((a, b) => a.priority - b.priority)) {
    const match = await strategy.run();
    if (match) {
      return {
        ...match,
        reason: match.reason || strategy.name,
      };
    }
  }

  return null;
}

/**
 * For sticky strategy routing:
 * Quickly find the model used in the previous turn of a continuation request.
 *
 * The `body` parameter is the raw request body (e.g., {model, messages, stream, ...}).
 * We serialize it with JSON.stringify to match how gatewayResponder stores inputText
 * in chat_logs (i.e., JSON.stringify(body)), so that normalizeChatLogTurn and
 * resolveSessionMatch produce the same fingerprints for matching.
 */
export async function getStickyModelForContinuation(
  body: any,
  userId: string,
  clientSessionId: string | undefined,
): Promise<string | null> {
  const rawInputText = JSON.stringify(body);
  const normalizedTurn = normalizeChatLogTurn(rawInputText, null);

  const payload: ChatLogPayload = {
    userId,
    serverSessionId: undefined,
    clientSessionId,
    clientName: undefined,
  };

  const match = await resolveSessionMatch(payload, normalizedTurn, rawInputText);
  if (!match || !match.serverSessionId) return null;

  const rows = await db
    .select({ model: chatLogs.model, inputText: chatLogs.inputText })
    .from(chatLogs)
    .where(eq(chatLogs.serverSessionId, match.serverSessionId))
    .orderBy(desc(chatLogs.turnId), desc(chatLogs.createdAt))
    .limit(40);

  return selectStickyModelFromLogRows(rows);
}

export async function getStickyTurnForContinuation(
  body: any,
  userId: string,
  clientSessionId: string | undefined,
): Promise<{ model: string; inputText: string } | null> {
  const rawInputText = JSON.stringify(body);
  const normalizedTurn = normalizeChatLogTurn(rawInputText, null);

  const payload: ChatLogPayload = {
    userId,
    serverSessionId: undefined,
    clientSessionId,
    clientName: undefined,
  };

  const match = await resolveSessionMatch(payload, normalizedTurn, rawInputText);
  if (!match || !match.serverSessionId) return null;

  const rows = await db
    .select({ model: chatLogs.model, inputText: chatLogs.inputText })
    .from(chatLogs)
    .where(eq(chatLogs.serverSessionId, match.serverSessionId))
    .orderBy(desc(chatLogs.turnId), desc(chatLogs.createdAt))
    .limit(40);

  return selectStickyTurnFromLogRows(rows);
}
