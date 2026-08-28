import { db } from "../../db";
import { apiKeys } from "../../db/schema";
import { eq } from "drizzle-orm";
import { logEmitter } from "../../utils/events";
import { detectAIClient } from "../../utils/chatTurns";
import { formatError, stringifyErrorPayload, describeGatewayErrorPayload, mapErrorTypeToAnthropic } from "../../utils/gatewayError";
import { resolveUsageForLog, UsageLogValues } from "../../utils/gatewayContent";
import { resolveRoundUsage, commitRoundUsage } from "./continuityHelper";
import { updateRequestLog } from "../../services/requestLogService";
import type { GatewayRequestContext } from "./types";
import { pickFirstAnswerTimeoutMs, remainingFirstChunkTimeoutMs } from "./gatewayExecutorUtils";
import { forwardStream } from "./streaming";
import { finalizeStreamLog, isAuditExemptUser, appendRoutingTraceToOutput } from "./logging";
import { writeStreamErrorResponse, writeStreamHeaders } from "./streamProtocol";
import { buildSafeNonStreamAuditOutput } from "./auditSanitizer";

export async function handleGatewayResponse(ctx: GatewayRequestContext, responseData: any, logAction: any, isStitching = false, anthropicState?: any): Promise<{ isLengthTruncated: boolean, lastToolCallState?: any, closingSentinel?: string, anthropicState?: any, terminalError?: any, terminalEventSent?: boolean, meaningfulClientOutputSent?: boolean, visibleClientOutputSent?: boolean, withheldEmptyTerminal?: boolean }> {
  if (!ctx.continuity) {
    ctx.continuity = {
      accumulatedCompletionText: "",
      hiddenContinuityText: "",
      forwardedStreamText: "",
      promptTokens: 0,
      completionTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      usageStatus: "success",
      committedRoundIds: new Set<string>(),
      hasStartedContinuity: false,
      hasForwardedStreamMaterial: false,
      streamRoundCount: 1,
    } as any;
  }
  const { request, reply, body, startTime, auth, routing, baseActionLog, reqLogId, usageRequestBody, currentAttempt, calculateCostForTokens } = ctx;
  const { incomingProtocol, reqPath } = routing;
  const authCtx = auth;
      if (!responseData) {
        responseData = { status: 500, data: formatError(incomingProtocol, 500, "网关内部错误"), isStream: false, latencyMs: 0, queueMs: 0 };
      }

      (ctx as any)._responseData = responseData;
      const { provider, baseLog, queueMs, latencyMs } = responseData;

      if (responseData) {
        if (responseData.isFakeStream) {
          ctx.continuity.hiddenContinuityText = "";
        } else if (!responseData.isStream) {
          ctx.continuity.forwardedStreamText = ctx.continuity.accumulatedCompletionText;
          ctx.continuity.hiddenContinuityText = "";
        }
      }

      // --- 16. Non-Streaming Response ---
      if (!responseData.isStream) {
        let isSuccess = responseData.status >= 200 && responseData.status < 300;
        let preserveOriginalError = false;

         if (responseData.terminalError) {
          if (responseData.terminalError.retryable && responseData.status >= 400) {
            // Wait, we should just return early for retries so we don't log it as failed request yet
            return { isLengthTruncated: false, terminalError: responseData.terminalError, terminalEventSent: false, meaningfulClientOutputSent: false };
          }
          isSuccess = false;
          if (incomingProtocol === "openai" && responseData.status >= 200 && responseData.status < 300) {
            preserveOriginalError = true;
          } else {
            responseData.status = responseData.terminalError.statusCode || 502;
            const anthropicType = incomingProtocol === "anthropic"
              ? mapErrorTypeToAnthropic(responseData.terminalError.errorType)
              : undefined;
            responseData.data = formatError(
              incomingProtocol,
              responseData.status,
              responseData.terminalError.message,
              responseData.terminalError.code,
              { type: anthropicType, canonicalErrorType: responseData.terminalError.errorType }
            );
          }
          responseData.errorDetail = responseData.terminalError.message;
        }

        ctx.stream.promptTokens = ctx.continuity.promptTokens;
        ctx.stream.completionTokens = ctx.continuity.completionTokens;

        const errorDetail = !isSuccess
          ? (responseData.errorDetail || describeGatewayErrorPayload(responseData.data))
          : undefined;

        const calculatedCost = isSuccess
          ? (calculateCostForTokens(ctx.continuity.promptTokens, ctx.continuity.completionTokens) || 0)
          : null;

        const finalLog = {
          ...baseLog,
          status: responseData.status,
          statusCode: responseData.status,
          inputTokens: ctx.continuity.promptTokens,
          outputTokens: ctx.continuity.completionTokens,
          totalTokens: ctx.continuity.promptTokens + ctx.continuity.completionTokens,
          latencyMs: Date.now() - startTime,
          ttftMs: Date.now() - startTime,
          cacheReadTokens: ctx.continuity.cacheReadTokens,
          cacheWriteTokens: ctx.continuity.cacheWriteTokens,
          isAborted: ctx.clientDisconnected,
          usageStatus: isSuccess ? ctx.continuity.usageStatus : "failed",
          errorCode: !isSuccess ? (responseData.terminalError?.code || String(responseData.status)) : null,
          errorMessage: responseData.terminalError?.message || errorDetail || null,
          cost: calculatedCost,
          routingTrace: ctx.routingTrace.length > 0 ? JSON.stringify(ctx.routingTrace) : null,
        };
        await updateRequestLog(reqLogId, finalLog, finalLog);

        // ═══════════════════════════════════════════════════════════════
        // SACRED: Send the upstream response to the client UNCHANGED.
        // DO NOT modify responseData.data before this point.
        // All audit processing operates on COPIES below.
        // ═══════════════════════════════════════════════════════════════

        if (isSuccess) {
          db.update(apiKeys)
            .set({ lastUsedAt: new Date() })
            .where(eq(apiKeys.id, authCtx.apiKeyRecord.id))
            .execute()
            .catch((e: any) => console.error(e));

          logAction({
            ...baseActionLog,
            level: "INFO",
            code: "request.completed",
            providerName: provider?.name,
            modelId: currentAttempt.modelId,
            statusCode: responseData.status,
            promptTokens: ctx.continuity.promptTokens,
            completionTokens: ctx.continuity.completionTokens,
            totalTokens: ctx.continuity.promptTokens + ctx.continuity.completionTokens,
            latencyMs: Date.now() - startTime,
            queueMs: queueMs || 0,
            fallback: currentAttempt.isFallback,
            fallbackText: currentAttempt.fallbackReason,
          });
        }

        // Send non-success responses (error)
        if (!isSuccess) {
          logAction({
            ...baseActionLog,
            level: "ERROR",
            code: responseData.terminalError ? "request.non_stream_terminal_error" : "request.error",
            providerName: provider?.name,
            modelId: currentAttempt.modelId,
            statusCode: responseData.status,
            errorCode: responseData.terminalError?.code || String(responseData.status),
            errorType: responseData.terminalError?.errorType,
            message: responseData.terminalError?.message || errorDetail || stringifyErrorPayload(responseData.data),
            latencyMs: Date.now() - startTime,
            queueMs: queueMs || 0,
            fallback: currentAttempt.isFallback,
            fallbackText: currentAttempt.fallbackReason,
          });

          // Audit event for errors (before sending)
          const isExempt = await isAuditExemptUser(authCtx.userId);
          if (!isExempt) {
            const auditOutputForLog = appendRoutingTraceToOutput(null, ctx.routingTrace);
            const detectedClientVal = detectAIClient(request.headers, body, reqPath);
            const clientSessionIdVal = (request.headers["x-client-session-id"] || request.headers["x-conversation-id"] || request.headers["x-session-id"]) as string;
            logEmitter.emit("chatLogInsert", {
              id: reqLogId,
              requestId: reqLogId,
              serverSessionId: (request.headers["x-server-session-id"] as string) || reqLogId,
              clientSessionId: clientSessionIdVal,
              turnId: parseInt(request.headers["x-turn-id"] as string) || 0,
              userId: authCtx.userId,
              clientName: authCtx.apiKeyRecord.name || "API Client",
              detectedClient: detectedClientVal,
              model: currentAttempt.modelId,
              inputText: JSON.stringify(body),
              outputText: auditOutputForLog,
              inputTokens: ctx.stream.promptTokens,
              outputTokens: ctx.stream.completionTokens,
              latencyMs: Date.now() - startTime,
              ttftMs: Date.now() - startTime,
              cachedTokens: ctx.continuity.cacheReadTokens || 0,
              isAborted: ctx.clientDisconnected,
              status: "failed",
              error: errorDetail || stringifyErrorPayload(responseData.data),
              apiKey: authCtx.providedKey,
              noSummary: request.headers["x-promptgate-no-summary"] === "true",
              createdAt: new Date().toISOString(),
            });
          }
          const errorMessage = errorDetail || stringifyErrorPayload(responseData.data);
          const canonicalErrorType = responseData.terminalError?.errorType;
          const anthropicType = incomingProtocol === "anthropic" && canonicalErrorType
            ? mapErrorTypeToAnthropic(canonicalErrorType)
            : undefined;

          if (reply.raw.headersSent) {
            writeStreamErrorResponse(reply, incomingProtocol, responseData.status, errorMessage, { type: anthropicType, canonicalErrorType });
          } else {
            if (preserveOriginalError) {
              reply.code(responseData.status).send(responseData.data);
            } else {
              reply
                .code(responseData.status)
                .send(formatError(
                  incomingProtocol,
                  responseData.status,
                  errorMessage,
                  responseData.terminalError?.code,
                  { type: anthropicType, canonicalErrorType }
                ));
            }
          }
          return { isLengthTruncated: false, terminalError: responseData.terminalError, terminalEventSent: true, meaningfulClientOutputSent: false };
        }

        // ─── Audit logging on COPY (success path) ───
        const isExempt = await isAuditExemptUser(authCtx.userId);
        if (!isExempt) {
          const nonStreamOutputForLog = buildSafeNonStreamAuditOutput(
            responseData.data,
            responseData.observation,
          );

          const auditOutputForLog = appendRoutingTraceToOutput(
            nonStreamOutputForLog,
            ctx.routingTrace,
          );
          const detectedClientVal = detectAIClient(request.headers, body, reqPath);
          const clientSessionIdVal = (request.headers["x-client-session-id"] || request.headers["x-conversation-id"] || request.headers["x-session-id"]) as string;
          logEmitter.emit("chatLogInsert", {
            id: reqLogId,
            requestId: reqLogId,
            serverSessionId: (request.headers["x-server-session-id"] as string) || reqLogId,
            clientSessionId: clientSessionIdVal,
            turnId: parseInt(request.headers["x-turn-id"] as string) || 0,
            userId: authCtx.userId,
            clientName: authCtx.apiKeyRecord.name || "API Client",
            detectedClient: detectedClientVal,
            model: currentAttempt.modelId,
            inputText: JSON.stringify(body),
            outputText: auditOutputForLog,
            inputTokens: ctx.continuity.promptTokens,
            outputTokens: ctx.continuity.completionTokens,
            latencyMs: Date.now() - startTime,
            ttftMs: Date.now() - startTime,
            cachedTokens: ctx.continuity.cacheReadTokens || 0,
            isAborted: ctx.clientDisconnected,
            status: "success",
            error: null,
            apiKey: authCtx.providedKey,
            noSummary: request.headers["x-promptgate-no-summary"] === "true",
            createdAt: new Date().toISOString(),
          });
        }

        // Send the response to the client UNCHANGED
        reply.code(responseData.status).send(responseData.data);
        return { isLengthTruncated: false };
      } else {
        // --- 17. Stream Forwarding ---
        if (!reply.raw.headersSent) {
          writeStreamHeaders(reply, responseData.status);
        }

        let toolState = ctx.continuity.stitchState;
        if (!toolState) {
          toolState = {
            isStitching,
            isLastCycle: ctx.continuity.isLastCycle,
            terminalReplayState: {
              terminalEventSent: false,
              usageChunksSent: [],
              meaningfulClientOutputSent: false,
              doneForwarded: false,
              usageForwarded: false
            }
          };
          ctx.continuity.stitchState = toolState;
        } else {
          toolState.isStitching = isStitching;
          toolState.isLastCycle = ctx.continuity.isLastCycle;
        }

        const firstChunkTimeoutMs = remainingFirstChunkTimeoutMs(
          pickFirstAnswerTimeoutMs(responseData.provider?.timeoutMs, ctx.routing.endpoint?.timeoutMs),
          responseData.latencyMs,
        );
        const streamResult = await forwardStream(
          reply,
          responseData,
          ctx,
          baseLog,
          toolState,
          responseData.provider?.streamTimeoutMs,
          anthropicState,
          firstChunkTimeoutMs,
        );
        (ctx as any)._lastToolCallState = streamResult.lastToolCallState;
        responseData.roundStreamUsage = ctx.stream.streamedUsagePayload;

        ctx.continuity.forwardedStreamText += streamResult.accumulatedCompletionText || "";
        ctx.continuity.accumulatedCompletionText = ctx.continuity.forwardedStreamText + ctx.continuity.hiddenContinuityText;

        ctx.stream.promptTokens = ctx.continuity.promptTokens;
        ctx.stream.completionTokens = ctx.continuity.completionTokens;
        ctx.stream.accumulatedCompletionText = ctx.continuity.accumulatedCompletionText;
        if (isStitching) {
          ctx.stream.accumulatedReasoningText = ((ctx as any)._accumulatedReasoningText || "") + streamResult.accumulatedReasoningText;
        }
        (ctx as any)._accumulatedReasoningText = ctx.stream.accumulatedReasoningText;

        return {
          isLengthTruncated: streamResult.isLengthTruncated || false,
          lastToolCallState: streamResult.lastToolCallState,
          closingSentinel: streamResult.closingSentinel,
          anthropicState: streamResult.anthropicState,
          terminalError: streamResult.terminalError,
          terminalEventSent: streamResult.terminalEventSent,
          meaningfulClientOutputSent: streamResult.meaningfulClientOutputSent,
          visibleClientOutputSent: streamResult.visibleClientOutputSent,
          withheldEmptyTerminal: streamResult.withheldEmptyTerminal,
        };
      }
}
