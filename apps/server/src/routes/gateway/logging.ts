import type { FastifyRequest } from "fastify";
import { db } from "../../db";
import { systemSettings } from "../../db/schema";
import { eq } from "drizzle-orm";
import { logEmitter } from "../../utils/events";
import { detectAIClient } from "../../utils/chatTurns";
import {
  UsageStatus,
  UsageLogValues,
  resolveUsageForLog,
} from "../../utils/gatewayContent";
import {
  insertRequestLog,
  publishRequestLogUpdate,
  updateRequestLog,
} from "../../services/requestLogService";
import type {
  GatewayRequestContext,
  StreamAccumulator,
} from "./types";

/**
 * Check if a user is exempt from audit logging.
 * Deduplicated: this check was previously done in 3 separate places.
 */
export async function isAuditExemptUser(userId: string): Promise<boolean> {
  const exemptSetting = await db
    .select()
    .from(systemSettings)
    .where(eq(systemSettings.key, "auditExemptUsers"))
    .limit(1);
  if (exemptSetting.length > 0 && exemptSetting[0].value) {
    const exemptUsers = exemptSetting[0].value.split(",");
    return exemptUsers.includes(userId);
  }
  return false;
}

/**
 * Build the initial base log object for a request attempt.
 */
export function buildBaseLog(ctx: GatewayRequestContext, provider: any, activeKeyId?: string | null): Record<string, any> {
  return {
    id: ctx.reqLogId,
    requestId: ctx.baseActionLog.requestId,
    userId: ctx.auth.userId,
    apiKeyId: ctx.auth.apiKeyRecord.id,
    endpointId: ctx.routing.endpoint.id,
    subdomainId: ctx.routing.subdomainRecord?.id || null,
    providerId: provider.id,
    providerApiKeyId: activeKeyId || null,
    protocol: ctx.currentAttempt.providerProtocol,
    model: ctx.currentAttempt.modelId,
    alias: ctx.activeModelConfig?.alias || undefined,
    ipAddress: ctx.request.ip,
    streaming: ctx.isStreaming,
    createdAt: new Date(),
  };
}

/**
 * Insert the initial "queued" request log. Idempotent via isLogInserted flag.
 */
export async function insertInitialRequestLog(
  ctx: GatewayRequestContext,
  baseLog: Record<string, any>,
): Promise<void> {
  if (!ctx.isLogInserted) {
    const initialLog = {
      ...baseLog,
      usageStatus: "queued",
      latencyMs: 0,
      totalTokens: 0,
    };
    await insertRequestLog(initialLog as any);
    ctx.isLogInserted = true;
  }
}

/**
 * Resolve final stream usage (tokens) using upstream data or estimation.
 */
export async function resolveFinalStreamUsage(
  ctx: GatewayRequestContext,
): Promise<UsageLogValues> {
  return resolveUsageForLog(
    ctx.stream.streamedUsagePayload,
    ctx.usageRequestBody,
    ctx.currentAttempt.modelId,
    undefined,
    ctx.stream.accumulatedCompletionText + ctx.stream.accumulatedReasoningText,
    ctx.activeModelConfig?.tokenizerRepo,
    ctx.activeProvider?.weightProxyUrl
  );
}

/**
 * Build the outputText string for audit logging, including reasoning and tool calls.
 */
export function buildAuditOutputText(stream: StreamAccumulator): string {
  let auditOutput = stream.accumulatedReasoningText
    ? `<think>${stream.accumulatedReasoningText}</think>\n${stream.accumulatedCompletionText}`
    : stream.accumulatedCompletionText;

  const toolArgEntries = Object.entries(stream.accumulatedToolArgs);
  if (toolArgEntries.length > 0) {
    for (const [id, tc] of toolArgEntries) {
      auditOutput += `\n[tool_call: ${tc.name || "unknown"}]`;
    }
  }

  return auditOutput;
}

export function appendRoutingTraceToOutput(
  outputText: string | null,
  routingTrace: GatewayRequestContext["routingTrace"],
): string | null {
  if (!routingTrace || routingTrace.length === 0) return outputText;
  const serializedTrace = JSON.stringify(routingTrace);
  return `${outputText || ""}\n<routing_trace>${serializedTrace}</routing_trace>`.trim();
}

/**
 * Extract the client session ID from request headers.
 */
export function extractClientSessionId(request: FastifyRequest): string {
  return (
    request.headers["x-client-session-id"] ||
    request.headers["x-conversation-id"] ||
    request.headers["x-session-id"]
  ) as string;
}

/**
 * Emit a chatLogInsert audit event. Shared by both streaming and non-streaming paths.
 */
export async function emitAuditEvent(
  ctx: GatewayRequestContext,
  outputText: string | null,
  status: "success" | "failed",
  errorMessage?: string | null,
): Promise<void> {
  const isExempt = await isAuditExemptUser(ctx.auth.userId);
  if (isExempt) return;

  const detectedClientVal = detectAIClient(
    ctx.request.headers,
    ctx.body,
    ctx.routing.reqPath,
  );
  const clientSessionIdVal = extractClientSessionId(ctx.request);

  logEmitter.emit("chatLogInsert", {
    id: ctx.reqLogId,
    requestId: ctx.reqLogId,
    serverSessionId:
      (ctx.request.headers["x-server-session-id"] as string) || ctx.reqLogId,
    clientSessionId: clientSessionIdVal,
    turnId: parseInt(ctx.request.headers["x-turn-id"] as string) || 0,
    userId: ctx.auth.userId,
    clientName: ctx.auth.apiKeyRecord.name || "API Client",
    detectedClient: detectedClientVal,
    model: ctx.currentAttempt.modelId,
    inputText: JSON.stringify(ctx.body),
    outputText,
    inputTokens: ctx.stream.promptTokens,
    outputTokens: ctx.stream.completionTokens,
    latencyMs: Date.now() - ctx.startTime,
    ttftMs: ctx.stream.ttft,
    cachedTokens: ctx.continuity.cacheReadTokens || 0,
    isAborted: ctx.clientDisconnected,
    status,
    error: errorMessage,
    apiKey: ctx.auth.providedKey,
    noSummary: ctx.request.headers["x-promptgate-no-summary"] === "true",
    createdAt: new Date().toISOString(),
  });
}

/**
 * Finalize the streaming request log: resolve usage, update DB, emit audit event.
 */
export async function finalizeStreamLog(
  ctx: GatewayRequestContext,
  statusCode: number,
  options: { usageStatus?: UsageStatus; errorCode?: string; errorMessage?: string | null } = {},
): Promise<{ promptTokens: number; completionTokens: number; totalTokens: number; usageStatus: string }> {
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
  if (ctx.streamLogFinalized) {
    return {
      promptTokens: ctx.stream.promptTokens,
      completionTokens: ctx.stream.completionTokens,
      totalTokens: ctx.stream.promptTokens + ctx.stream.completionTokens,
      usageStatus: options.usageStatus || "missing",
    };
  }

  const usageForLog = await resolveFinalStreamUsage(ctx);
  const totalTokens = ctx.continuity.promptTokens + ctx.continuity.completionTokens;
  const usageStatus = options.usageStatus || ctx.continuity.usageStatus || usageForLog.usageStatus;
  const finalAttemptCost = ctx.calculateCostForTokens(
    ctx.continuity.promptTokens,
    ctx.continuity.completionTokens,
  ) || 0;

  const responseData = (ctx as any)._responseData;
  const finalStreamLog = {
    ...(responseData?.baseLog || {}),
    id: ctx.reqLogId,
    userId: ctx.auth.userId,
    statusCode,
    inputTokens: ctx.continuity.promptTokens,
    outputTokens: ctx.continuity.completionTokens,
    totalTokens,
    latencyMs: Date.now() - ctx.startTime,
    ttftMs: ctx.stream.ttft,
    cacheReadTokens: ctx.continuity.cacheReadTokens,
    cacheWriteTokens: ctx.continuity.cacheWriteTokens,
    isAborted: ctx.clientDisconnected,
    usageStatus,
    errorCode: options.errorCode ?? null,
    errorMessage: options.errorMessage ?? null,
    cost: finalAttemptCost,
    routingTrace: ctx.routingTrace.length > 0 ? JSON.stringify(ctx.routingTrace) : null,
    alias: ctx.activeModelConfig?.alias,
  };

  if (ctx.isLogInserted) {
    await updateRequestLog(ctx.reqLogId, finalStreamLog, finalStreamLog);
  } else {
    publishRequestLogUpdate(finalStreamLog);
  }

  const origAccumulatedText = ctx.stream.accumulatedCompletionText;
  ctx.stream.accumulatedCompletionText = ctx.continuity.accumulatedCompletionText;
  const auditOutput = appendRoutingTraceToOutput(
    buildAuditOutputText(ctx.stream),
    ctx.routingTrace,
  );
  ctx.stream.accumulatedCompletionText = origAccumulatedText;

  await emitAuditEvent(
    ctx,
    auditOutput,
    usageStatus === "failed" ? "failed" : "success",
    options.errorMessage,
  );

  ctx.streamLogFinalized = true;

  return {
    promptTokens: ctx.continuity.promptTokens,
    completionTokens: ctx.continuity.completionTokens,
    totalTokens,
    usageStatus,
  };
}
