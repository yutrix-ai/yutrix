import type { FastifyRequest, FastifyReply } from "fastify";
import crypto from "crypto";
import { db } from "../../db";
import { responseCache, apiKeys, systemSettings } from "../../db/schema";
import { eq, and } from "drizzle-orm";
import { logAction } from "../../utils/actionLogger";
import { logEmitter } from "../../utils/events";
import { detectAIClient, normalizeChatLogTurn } from "../../utils/chatTurns";
import { insertRequestLog } from "../../services/requestLogService";
import type { AuthContext, RoutingContext, AttemptState, BaseActionLog } from "./types";
import { isAuditExemptUser } from "./logging";
import { writeStreamHeaders } from "./streamProtocol";
import { shouldSkipResponseCacheServe } from "../../services/loopGuard";

/**
 * Check the response cache and serve a cached response if available.
 *
 * Returns `true` if a cached response was served (caller should return early),
 * or `false` if no cache hit (caller should proceed to upstream).
 *
 * This runs BEFORE the upstream request loop to avoid any provider calls.
 */
export async function checkAndServeCachedResponse(
  request: FastifyRequest,
  reply: FastifyReply,
  body: any,
  auth: AuthContext,
  routing: RoutingContext,
  currentAttempt: AttemptState,
  baseActionLog: BaseActionLog,
  startTime: number,
  activeModelAlias?: string | null,
): Promise<boolean> {
  const { userId, apiKeyRecord, providedKey } = auth;
  const { reqPath, route } = routing;

  try {
    if (shouldSkipResponseCacheServe(body)) {
      return false;
    }
    const normalized = normalizeChatLogTurn(JSON.stringify(body), null);
    if (normalized.inputText) {
      const cacheInputHash = crypto.createHash("md5").update(normalized.inputText).digest("hex");
      const cacheHit = await db.select().from(responseCache).where(eq(responseCache.inputHash, cacheInputHash)).limit(1);
      if (cacheHit.length > 0) {
        const cached = cacheHit[0];

        // Update hit count
        await db.update(responseCache).set({
          hitCount: cached.hitCount + 1,
          lastHitAt: new Date(),
        }).where(eq(responseCache.id, cached.id));

        // Persist an audit row. Usage aggregations skip usageStatus === "cached".
        const cachedLog = {
          id: baseActionLog.requestId,
          requestId: baseActionLog.requestId,
          userId,
          apiKeyId: apiKeyRecord.id,
          routeId: route.id,
          endpointId: route.endpointId,
          providerId: currentAttempt.providerId,
          model: cached.model || currentAttempt.modelId,
          alias: activeModelAlias || undefined,
          path: reqPath,
          statusCode: 200,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          latencyMs: Date.now() - startTime,
          ttftMs: 0,
          usageStatus: "cached",
          cost: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        void insertRequestLog(cachedLog);

        // Emit audit log event in background (fire-and-forget)
        void (async () => {
          try {
            const isAuditExempt = await isAuditExemptUser(userId);
            if (!isAuditExempt) {
              const detectedClientVal = detectAIClient(request.headers, body, reqPath);
              const clientSessionIdVal = (request.headers["x-client-session-id"] || request.headers["x-conversation-id"] || request.headers["x-session-id"]) as string;
              logEmitter.emit("chatLogInsert", {
                id: baseActionLog.requestId,
                requestId: baseActionLog.requestId,
                serverSessionId: (request.headers["x-server-session-id"] as string) || baseActionLog.requestId,
                clientSessionId: clientSessionIdVal,
                turnId: parseInt(request.headers["x-turn-id"] as string) || 0,
                userId,
                clientName: apiKeyRecord.name || "API Client",
                detectedClient: detectedClientVal,
                model: cached.model || currentAttempt.modelId,
                inputText: JSON.stringify(body),
                outputText: cached.responseText,
                inputTokens: 0,
                outputTokens: 0,
                latencyMs: Date.now() - startTime,
                status: "cached",
                error: null,
                apiKey: providedKey,
                noSummary: request.headers["x-promptgate-no-summary"] === "true",
                createdAt: new Date().toISOString(),
              });
            }
          } catch (err) {
            console.error("[GatewayCache] Failed to emit audit log event:", err);
          }
        })();

        logAction({
          ...baseActionLog,
          level: "INFO",
          code: "request.cache_hit",
          cacheId: cached.id,
          providerName: "Cache",
          modelId: cached.model || currentAttempt.modelId,
          statusCode: 200,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          latencyMs: Date.now() - startTime,
          queueMs: 0,
        });

        // Construct OpenAI-compatible response
        const isStreamRequest = body.stream === true;
        if (isStreamRequest) {
          // SSE streaming response
          writeStreamHeaders(reply);

          // Parse cached responseText to separate think/content
          let thinkContent = "";
          let mainContent = cached.responseText;
          const thinkMatch = cached.responseText.match(/^<think>([\s\S]*?)<\/think>\n?/);
          if (thinkMatch) {
            thinkContent = thinkMatch[1];
            mainContent = cached.responseText.slice(thinkMatch[0].length);
          }

          const streamId = `chatcmpl-cache-${cached.id.slice(0, 8)}`;

          if (thinkContent) {
            const reasoningChunk = {
              id: streamId,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: cached.model || currentAttempt.modelId,
              choices: [{ index: 0, delta: { reasoning_content: thinkContent }, finish_reason: null }],
            };
            reply.raw.write(`data: ${JSON.stringify(reasoningChunk)}\n\n`);
          }

          const contentChunk = {
            id: streamId,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: cached.model || currentAttempt.modelId,
            choices: [{ index: 0, delta: { content: mainContent }, finish_reason: null }],
          };
          reply.raw.write(`data: ${JSON.stringify(contentChunk)}\n\n`);

          const doneChunk = {
            id: streamId,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: cached.model || currentAttempt.modelId,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          };
          reply.raw.write(`data: ${JSON.stringify(doneChunk)}\n\n`);
          reply.raw.write(`data: [DONE]\n\n`);
          reply.raw.end();
          return true;
        } else {
          // Non-streaming response
          let thinkContent = "";
          let mainContent = cached.responseText;
          const thinkMatch = cached.responseText.match(/^<think>([\s\S]*?)<\/think>\n?/);
          if (thinkMatch) {
            thinkContent = thinkMatch[1];
            mainContent = cached.responseText.slice(thinkMatch[0].length);
          }

          const cachedResponse = {
            id: `chatcmpl-cache-${cached.id.slice(0, 8)}`,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: cached.model || currentAttempt.modelId,
            choices: [{
              index: 0,
              message: {
                role: "assistant",
                content: mainContent,
                ...(thinkContent ? { reasoning_content: thinkContent } : {}),
              },
              finish_reason: "stop",
            }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          };
          reply.code(200).send(cachedResponse);
          return true;
        }
      }
    }
  } catch (cacheErr: any) {
    // Cache check failure is non-fatal — log and proceed normally
    request.log.warn({ err: cacheErr }, "Cache check failed, proceeding to upstream");
  }

  return false;
}
