import { db } from "../db";
import { chatLogs } from "../db/schema";
import { logEmitter } from "../utils/events";
import crypto from "crypto";
import { normalizeChatLogTurn } from "../utils/chatTurns";
import { ChatLogPayload } from "./chatLogTypes";
import { getSessionTurnStats, resolveSessionMatch } from "./chatLogQuery";
import { triggerSessionTitleSummarization } from "./chatLogSummarizer";
import { enqueueAuditInsert } from "./chatLogInsertQueue";

export { ChatLogPayload };

async function processChatLogInsert(payload: ChatLogPayload) {
  if (payload.noSummary) {
    return;
  }

  try {
    const normalizedTurn = normalizeChatLogTurn(payload.inputText, payload.outputText);
    let finalInputText = normalizedTurn.inputText || payload.inputText;
    let finalServerSessionId = payload.serverSessionId || payload.requestId || payload.id || crypto.randomUUID();
    let finalTurnId = payload.turnId || 0;
    const responseHash = normalizedTurn.responseHash;

    const hasExplicitSessionId = !!(
      payload.serverSessionId &&
      payload.requestId &&
      payload.serverSessionId !== payload.requestId
    );

    let mergeReason: string | null = null;
    if (!hasExplicitSessionId) {
      const match = await resolveSessionMatch(payload, normalizedTurn, finalInputText);

      if (match) {
        finalServerSessionId = match.serverSessionId;
        finalTurnId = match.maxTurnId + 1;
        mergeReason = match.reason;
      }
    } else if (finalTurnId <= 0) {
      const stats = await getSessionTurnStats(finalServerSessionId);
      if (stats.count > 0 && stats.maxTurnId !== null) {
        finalTurnId = stats.maxTurnId + 1;
      }
    }

    const id = payload.id || crypto.randomUUID();
    const createdAt = new Date();
    const insertedLog = {
      id,
      requestId: payload.requestId,
      serverSessionId: finalServerSessionId,
      clientSessionId: payload.clientSessionId,
      turnId: finalTurnId,
      userId: payload.userId,
      clientName: payload.clientName,
      detectedClient: payload.detectedClient,
      model: payload.model,
      inputText: finalInputText,
      outputText: payload.outputText,
      responseHash,
      conversationRootHash: normalizedTurn.conversationRootHash,
      inputTokens: payload.inputTokens || 0,
      outputTokens: payload.outputTokens || 0,
      latencyMs: payload.latencyMs || 0,
      status: payload.status || "success",
      error: payload.error,
      ttftMs: payload.ttftMs ?? null,
      cachedTokens: payload.cachedTokens ?? 0,
      isAborted: payload.isAborted ?? false,
      createdAt,
    };

    try {
      await db.insert(chatLogs).values(insertedLog);
    } catch (insertErr: any) {
      // Gracefully handle duplicate requestId (UNIQUE constraint violation)
      if (insertErr?.code === "SQLITE_CONSTRAINT" || insertErr?.message?.includes("UNIQUE constraint") || insertErr?.cause?.message?.includes("UNIQUE constraint")) {
        // Duplicate — silently skip
        return;
      }
      throw insertErr;
    }

    if (finalServerSessionId !== payload.serverSessionId) {
      logEmitter.emit("chatSessionMerged", {
        oldSessionId: payload.serverSessionId,
        newSessionId: finalServerSessionId,
        turnId: finalTurnId,
        reason: mergeReason,
        createdAt: createdAt.toISOString()
      });
    }

    logEmitter.emit("chatLogCreated", {
      ...insertedLog,
      createdAt: createdAt.toISOString(),
    });

    // Run session title summarization in the background on the first turn
    const isFirstTurn = (finalTurnId === 0);

    if (isFirstTurn) {
      triggerSessionTitleSummarization(payload, finalInputText, finalServerSessionId);
    }
  } catch (error) {
    console.error("[ChatLogService] Failed to insert chat log asynchronously. Error:", error);
  }
}

logEmitter.on("chatLogInsert", async (payload: ChatLogPayload) => {
  try {
    await enqueueAuditInsert(payload, () => processChatLogInsert(payload));
  } catch (error) {
    console.error("[ChatLogService] Failed to enqueue chat log insert:", error);
  }
});
