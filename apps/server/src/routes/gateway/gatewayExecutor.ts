import { db } from "../../db";
import { providers, providerModels, providerApiKeys, apiKeys, requestLogs } from "../../db/schema";
import { eq, and, gte, sql } from "drizzle-orm";
import { decryptText } from "../../utils/crypto";
import { exactEstimateTokens, estimateTokensFallback } from "../../utils/tokenizer";
import { logEmitter } from "../../utils/events";
import { formatError, truncateErrorDetail, describeFetchError, mapErrorTypeToAnthropic } from "../../utils/gatewayError";
import { extractPromptText, resolveUsageForLog } from "../../utils/gatewayContent";
import { resolveRoundUsage, commitRoundUsage, updateResponseDataUsage } from "./continuityHelper";
import { publishRequestLogUpdate, updateRequestLog } from "../../services/requestLogService";
import type { GatewayRequestContext } from "./types";
import { transformRequestBody, applyPromptPolicy, resolvePromptPolicyPlan } from "./payload";
import { getStrategyRuleForLayer } from "../../services/strategyRouting";
import { adaptRequestProtocol } from "./protocolAdapter";
import { buildUpstreamHeaders, determineUpstreamPath, executeUpstreamFetch, createFakeStreamFromData } from "./upstream";
import { buildBaseLog, insertInitialRequestLog, finalizeStreamLog } from "./logging";
import { getGlobalQueue, getApiKeyQueue, getProviderQueue } from "./concurrency";
import { checkConcurrencyFallback, checkErrorFallback } from "./fallback";
import { handleGatewayResponse } from "./gatewayResponder";
import { startStreamPrelude } from "./streamPrelude";
import { writeStreamErrorResponse } from "./streamProtocol";
import { processErrorRetryLogic, selectProviderKey, isOpenRouterCapacityError, resolveModelContextWindow, fitsContextBudget, reserveAttemptBudgetForLayerSwitch, isUpstreamCredentialUnavailableError } from "./gatewayExecutorUtils";
import { classifyUpstreamErrorWithAdapter } from "./streamForwarder";
import { checkAndServeCachedResponse } from "./cache";
import { enforceInputTokenLimit } from "./inputTokenLimitGuard";
import { estimateMultimodalInputUsage, inspectOutboundCapabilities, applyInputTokenLimit } from "./inputTokenLimit";
import { resolveStrategyRoutingDecision, parseStrategyRoutingRules, validateOneStrategyRule, computeRoutingRequirements, meetsLongContextStrategyTokenFloor } from "../../services/strategyRouting";
import { getStickyModelForContinuation } from "../../services/chatLogQuery";
import { classifyGatewayRequestClass, shouldRecordStrategyRoutingHop } from "../../services/requestRoutingClass";
import { ContinuityEngine } from "../../services/continuity/ContinuityEngine";
import { ContinuityContext } from "../../services/continuity/types";
import { buildUpstreamRequestDiagnostic } from "./diagnostics";
import { applyProviderCompatibility } from "./providerCompatibility";
import {
  applyConstraintMutators,
  planConstraintRecovery,
  type ConstraintMutator,
} from "./providerConstraintRecovery";
import { parseAndNormalizeUrl } from "./providerAdapters/urlMatcher";
import { resolveProviderAdapterDetailed } from "./providerAdapters/registry";
import { ProviderAdapter } from "./providerAdapters/types";
import { transparentAdapter } from "./providerAdapters/transparentAdapter";
import { buildGoogleNativeRequest, buildGoogleNativeHeaders } from "./googleNativeAdapter";

function ensureSseEventDelimiter(chunk: string): string {
  if (!chunk) return chunk;
  if (chunk.endsWith("\n\n")) return chunk;
  if (chunk.endsWith("\n")) return chunk + "\n";
  return chunk + "\n\n";
}

// In-memory cursor to ensure perfect round-robin load balancing even under high concurrency
const providerKeyCursors = new Map<string, number>();

export interface CapacityRetryState {
  providerId: string | null;
  modelId: string | null;
  activeKeyId: string | null;
  retryCount: number;
  maxRetries: number;
  exhausted: boolean;
}

export function restoreFakeStreamIfNeeded(ctx: any, responseData: any, currentAttempt: any) {
  const needsRestoration = ctx.isStreaming && responseData && responseData.status >= 200 && responseData.status < 300 && (!responseData.isStream || responseData.isFakeStream);
  if (needsRestoration) {
    const adapter = ctx.activeProviderAdapter;
    const adapterCtx = ctx.activeProviderAdapterContext;

    const protocol = responseData.responseProtocol;
    if (!protocol) {
      throw new Error("Missing responseProtocol for successful response");
    }

    const adapterPolicy = adapter?.getRequestPolicy?.(adapterCtx!)?.preserveFakeStreamFields
      ? { preserveFields: adapter.getRequestPolicy(adapterCtx).preserveFakeStreamFields }
      : undefined;
    const policy = {
      ...(adapterPolicy || {}),
      skipTextLength: ctx.continuity?.forwardedStreamText?.length || 0,
      skipReasoningLength: ctx.stream?.accumulatedReasoningText?.length || 0
    };
    const { fakeStream, textToEmit } = createFakeStreamFromData(responseData.data, currentAttempt.modelId, protocol, policy);
    responseData.stream = fakeStream;
    responseData.isStream = true;
    responseData.isFakeStream = true;
    responseData.fakeStreamText = textToEmit;
    responseData.streamProtocol = protocol;
    responseData.responseProtocol = protocol;
  }
}

export interface TargetKeyAttemptState {
  providerId: string;
  modelId: string;
  triedKeyIds: Set<string>;
  preferredKeyId: string | null;
  lastUpstreamError?: any;
  /** Codes of constraint rewrites already applied for this target (de-dupe). */
  appliedConstraintRewrites?: Set<string>;
  /** Mutators re-applied to every outbound body for this target after a recovery plan. */
  constraintMutators?: ConstraintMutator[];
}

export async function executeGatewayRequest(ctx: GatewayRequestContext, controller: AbortController, maxAttempts: number, logAction: any, abortHandlers: any) {
  ctx.logAction = logAction;

  let attemptCount = 0;
  const targetKeyStates = new Map<string, TargetKeyAttemptState>();
  const getTargetKeyState = (providerId: string, modelId: string): TargetKeyAttemptState => {
    const key = `${providerId}:${modelId}`;
    let state = targetKeyStates.get(key);
    if (!state) {
      state = {
        providerId,
        modelId,
        triedKeyIds: new Set<string>(),
        preferredKeyId: null,
        appliedConstraintRewrites: new Set<string>(),
        constraintMutators: [],
      };
      targetKeyStates.set(key, state);
    }
    return state;
  };
  let responseData: any = null;

  const capacityRetryStates = new Map<string, CapacityRetryState>();
  const getCapacityRetryState = (providerId: string, modelId: string): CapacityRetryState => {
    const key = `${providerId}:${modelId}`;
    let state = capacityRetryStates.get(key);
    if (!state) {
      state = {
        providerId,
        modelId,
        activeKeyId: null,
        retryCount: 0,
        maxRetries: activeModelConfig?.capacityRetryAttempts ?? 2,
        exhausted: false,
      };
      capacityRetryStates.set(key, state);
    }
    return state;
  };
  let cacheServed = false;
  let activeModelConfig: any = ctx.activeModelConfig;
  let isStreaming: boolean = ctx.isStreaming;
  let usageRequestBody: any = ctx.usageRequestBody;
  let isLogInserted: boolean = ctx.isLogInserted;
  let { request, reply, body, startTime, auth, routing, baseActionLog, reqLogId, currentAttempt } = ctx;
  const { incomingProtocol, reqPath, endpoint, route, subdomainRecord } = routing;
  const authCtx = auth;
  const { abortUpstream, abortOnRequestClose, abortOnReplyClose } = abortHandlers;
  const processQueue = await getGlobalQueue();
  const userQueue = getApiKeyQueue(authCtx.apiKeyRecord.id, authCtx.apiKeyRecord.concurrencyLimit);
  let strategyRoutingChecked = false;
  let strategyDecisionApplied = false;
  let longContextOverrideApplied = false;
  let stopEarlyStreamPrelude: (() => void) | undefined;

  const continuityEngine = new ContinuityEngine();
  let keepContinuity = true;
  let continuityCycles = 0;
  const MAX_CONTINUITY_CYCLES = 5; // Hard limit on total engine loops per request
  const originalBody = { ...ctx.body };
  let anthropicState: any = null;
    let earlyAnthropicMessageId: string | undefined;
  let lastStreamResultIsTruncated = false;

  const ensureEarlyStreamPrelude = (isAnthropicAdaptationPrelude = false) => {
    if (!isStreaming || stopEarlyStreamPrelude || reply.raw.destroyed || reply.raw.writableEnded) return;
    const anthropicMessage =
      isAnthropicAdaptationPrelude && incomingProtocol === "anthropic"
        ? {
            messageId: earlyAnthropicMessageId || (earlyAnthropicMessageId = `msg_${crypto.randomUUID()}`),
            modelId: currentAttempt.modelId,
            promptTokens: ctx.stream.estimatedPromptTokens || 0,
          }
        : undefined;
    stopEarlyStreamPrelude = startStreamPrelude(reply, incomingProtocol, { anthropicMessage });
  };

  const stopStreamPrelude = () => {
    if (!stopEarlyStreamPrelude) return;
    stopEarlyStreamPrelude();
    stopEarlyStreamPrelude = undefined;
  };

  const finalizeGatewayStreamEvents = (
    lastStreamResult: any,
    pendingClosingSentinel?: string
  ) => {
    if ((ctx as any).streamEventsFinalized) return;

    if (!reply.raw.writableEnded && !reply.raw.destroyed) {
      try {
        const isTruncated = lastStreamResult?.isLengthTruncated || false;

        const isOrdinaryTransparentSameProtocol = 
          ctx.activeProviderAdapter?.id === "transparent" &&
          incomingProtocol === (ctx.activeEffectiveUpstreamProtocol || "openai") &&
          !ctx.continuity?.hasStartedContinuity &&
          !isTruncated;

        if (isOrdinaryTransparentSameProtocol) {
          reply.raw.end();
          (ctx as any).streamEventsFinalized = true;
          return;
        }

        if (incomingProtocol === "anthropic") {
          const isAnthropicAdaptation = ctx.activeEffectiveUpstreamProtocol === "openai";

          if (isAnthropicAdaptation) {
            if (anthropicState) {
              // Close active tool calls
              for (const idx in anthropicState.activeToolCalls) {
                const state = anthropicState.activeToolCalls[idx];
                if (state.emittedStart && !state.closed) {
                   reply.raw.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: anthropicState.activeBlockIndex })}\n\n`);
                   state.closed = true;
                   anthropicState.activeBlockIndex++;
                }
              }
              // Close text block if active
              if (anthropicState.isInsideTextBlock) {
                 reply.raw.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: anthropicState.activeBlockIndex })}\n\n`);
                 anthropicState.isInsideTextBlock = false;
                 anthropicState.activeBlockIndex++;
              }
            } else if (lastStreamResult?.closingSentinel) {
               reply.raw.write(lastStreamResult.closingSentinel);
            } else {
              reply.raw.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`);
            }
            const stopReason = isTruncated ? "max_tokens" : (lastStreamResult?.stopReason || "end_turn");
            const totalOutput = ctx.continuity.completionTokens || 0;

            reply.raw.write(`event: message_delta\ndata: ${JSON.stringify({
              type: "message_delta",
              delta: {
                stop_reason: stopReason,
                stop_sequence: null,
              },
              usage: {
                output_tokens: totalOutput,
              },
            })}\n\n`);

            reply.raw.write(`event: message_stop\ndata: {"type":"message_stop"}\n\n`);
          } else {
            // Native Anthropic
            const wasStitching = ctx.continuity.committedRoundIds.size > 1;

            if (wasStitching || isTruncated) {
              const stopReason = isTruncated ? "max_tokens" : (lastStreamResult?.stopReason || "end_turn");
              const totalOutput = ctx.continuity.completionTokens || 0;
              reply.raw.write(`event: message_delta\ndata: ${JSON.stringify({
                type: "message_delta",
                delta: { stop_reason: stopReason, stop_sequence: null },
                usage: { output_tokens: totalOutput }
              })}\n\n`);
              reply.raw.write(`event: message_stop\ndata: {"type":"message_stop"}\n\n`);
            }
          }
        } else {
          // OpenAI protocol
          const meta = (ctx as any).syntheticOpenAIChunkMetadata || {
             id: `chatcmpl-${ctx.reqLogId || crypto.randomUUID()}`,
             created: Math.floor(Date.now() / 1000),
             model: ctx.currentAttempt?.modelId || "default"
          };
          (ctx as any).syntheticOpenAIChunkMetadata = meta;

          if (isTruncated) {
            reply.raw.write(`data: ${JSON.stringify({
              ...meta,
              object: "chat.completion.chunk",
              choices: [{ delta: {}, finish_reason: "length" }]
            })}\n\n`);
          }

          const suppressedUsageChunk = ctx.continuity?.stitchState?.terminalReplayState?.suppressedUsageChunkBytes;
          const wasStitching = ctx.continuity.committedRoundIds.size > 1;

          if (wasStitching) {
            if (ctx.continuity.promptTokens > 0 || ctx.continuity.completionTokens > 0) {
              const meta = (ctx as any).syntheticOpenAIChunkMetadata || {
                 id: `chatcmpl-${ctx.reqLogId || crypto.randomUUID()}`,
                 created: Math.floor(Date.now() / 1000),
                 model: ctx.currentAttempt?.modelId || "default"
              };
              (ctx as any).syntheticOpenAIChunkMetadata = meta;
              reply.raw.write(`data: ${JSON.stringify({
                ...meta,
                object: "chat.completion.chunk",
                choices: [],
                usage: {
                  prompt_tokens: ctx.continuity.promptTokens,
                  completion_tokens: ctx.continuity.completionTokens,
                  total_tokens: ctx.continuity.promptTokens + ctx.continuity.completionTokens,
                }
              })}\n\n`);
            }
          } else if (suppressedUsageChunk) {
            reply.raw.write(ensureSseEventDelimiter(suppressedUsageChunk));
          } else if ((ctx.continuity.promptTokens > 0 || ctx.continuity.completionTokens > 0) && !ctx.continuity?.stitchState?.terminalReplayState?.usageForwarded) {
            const meta = (ctx as any).syntheticOpenAIChunkMetadata || {
               id: `chatcmpl-${ctx.reqLogId || crypto.randomUUID()}`,
               created: Math.floor(Date.now() / 1000),
               model: ctx.currentAttempt?.modelId || "default"
            };
            (ctx as any).syntheticOpenAIChunkMetadata = meta;
            reply.raw.write(`data: ${JSON.stringify({
              ...meta,
              object: "chat.completion.chunk",
              choices: [],
              usage: {
                prompt_tokens: ctx.continuity.promptTokens,
                completion_tokens: ctx.continuity.completionTokens,
                total_tokens: ctx.continuity.promptTokens + ctx.continuity.completionTokens,
              }
            })}\n\n`);
          }



          if (!ctx.continuity?.stitchState?.terminalReplayState?.doneForwarded) {
            reply.raw.write(`data: [DONE]\n\n`);
          }
        }
        reply.raw.end();
        (ctx as any).streamEventsFinalized = true;
      } catch (e) { throw e; }
    }
  };

  const finalizeGatewayStreamOnce = async (
    responseData: any,
    lastStreamResult: any,
    anthropicState?: any
  ) => {
    if ((ctx as any).streamFinalizationPromise) {
      await (ctx as any).streamFinalizationPromise;
      finalizeGatewayStreamEvents(lastStreamResult);
      return;
    }

    (ctx as any).streamFinalizationPromise = (async () => {
      try {
        if (!ctx.streamLogFinalized) {
          if (responseData && responseData.status === 200 && !responseData.roundUsageCommitted) {
            const toolCalls = lastStreamResult?.accumulatedToolArgs
              ? Object.values(lastStreamResult.accumulatedToolArgs)
              : [];
            const roundUsage = await resolveRoundUsage(
              ctx,
              responseData,
              responseData.roundRequestBody,
              lastStreamResult?.accumulatedCompletionText || "",
              lastStreamResult?.accumulatedReasoningText || "",
              toolCalls
            );
            commitRoundUsage(ctx, responseData, roundUsage, responseData.roundId || `continuity-${ctx.continuity.committedRoundIds.size}`);
          }

          const isFailed = (lastStreamResult?.isEmptyStream && ctx.continuity.committedRoundIds.size <= 1) || !!lastStreamResult?.terminalError;
          const finalLogSummary = await finalizeStreamLog(ctx, responseData?.status || 200, {
            usageStatus: isFailed ? "failed" : undefined,
            errorCode: lastStreamResult?.terminalError?.code,
            errorMessage: lastStreamResult?.terminalError?.message || (lastStreamResult?.isEmptyStream ? "Empty stream" : undefined),
          });

          const isStitching = ctx.continuity.committedRoundIds.size > 1;
          const logCode = lastStreamResult?.terminalError
            ? "request.stream_terminal_error"
            : lastStreamResult?.isEmptyStream && !isStitching
              ? "request.empty_stream"
              : "request.completed";
          const logLevel = lastStreamResult?.terminalError ? "ERROR" : (lastStreamResult?.isEmptyStream && !isStitching ? "WARN" : "INFO");

          if (logAction) {
            logAction({
              ...baseActionLog,
              level: logLevel,
              code: logCode,
              providerName: responseData?.provider?.name,
              modelId: currentAttempt.modelId,
              statusCode: responseData?.status || 200,
              promptTokens: finalLogSummary.promptTokens,
              completionTokens: finalLogSummary.completionTokens,
              totalTokens: finalLogSummary.totalTokens,
              latencyMs: Date.now() - startTime,
              queueMs: responseData?.queueMs || 0,
              fallback: currentAttempt.isFallback,
              fallbackText: currentAttempt.fallbackReason,
              message: lastStreamResult?.terminalError?.message || (lastStreamResult?.isEmptyStream ? "Empty stream" : "Stream Completed"),
              adapterId: lastStreamResult?.terminalError?.adapterId,
              errorCode: lastStreamResult?.terminalError?.code,
              errorType: lastStreamResult?.terminalError?.errorType,
              retryClass: lastStreamResult?.terminalError?.retryClass,
              upstreamProvider: lastStreamResult?.terminalError?.upstreamProvider,
              fingerprint: lastStreamResult?.terminalError?.fingerprint,
              retryCount: getCapacityRetryState(currentAttempt.providerId, currentAttempt.modelId).retryCount,
              retryExhausted: getCapacityRetryState(currentAttempt.providerId, currentAttempt.modelId).exhausted,
              meaningfulClientOutputSent: lastStreamResult?.meaningfulClientOutputSent,
              abortSource: lastStreamResult?.abortSource,
            });
          }
        }
      } catch (err) {
        console.error("finalizeGatewayStreamOnce failed:", err);
        throw err;
      }
    })();

    await (ctx as any).streamFinalizationPromise;

    finalizeGatewayStreamEvents(lastStreamResult);
  };

  while (keepContinuity && continuityCycles <= MAX_CONTINUITY_CYCLES) {
    let currentRoundId = "";
    if (!ctx.continuity) {
      ctx.continuity = {
        promptTokens: 0,
        completionTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        usageStatus: "success",
        committedRoundIds: new Set<string>(),
        forwardedStreamText: "",
        hiddenContinuityText: "",
        accumulatedCompletionText: "",
        hasStartedContinuity: false,
        hasForwardedStreamMaterial: false,
        streamRoundCount: 1,
      } as any;
    }
    ctx.continuity.isLastCycle = (continuityCycles >= MAX_CONTINUITY_CYCLES);
    if (continuityCycles > 0) {
      attemptCount = 0;
      strategyRoutingChecked = false;
      strategyDecisionApplied = false;
      responseData = null;
    }

    try {
      await processQueue.add(async (holdGlobal) => {
        await userQueue.add(async (holdUser) => {
          while (attemptCount < maxAttempts) {
            attemptCount++;
            currentRoundId = "round-" + Math.random().toString(36).slice(2) + "-" + Date.now();

            if (attemptCount === 1) {
              const initialProviderList = await db.select().from(providers).where(and(eq(providers.id, currentAttempt.providerId), eq(providers.enabled, true)));
              const initialProvider = initialProviderList[0] || null;

              const initialModelConfigList = await db.select().from(providerModels).where(and(eq(providerModels.providerId, currentAttempt.providerId), eq(providerModels.modelId, currentAttempt.modelId)));
              const initialModelConfig = initialModelConfigList[0] || null;

              const tokenLimitResult = await enforceInputTokenLimit({
                ctx,
                modifiedBody: body,
                provider: initialProvider || { name: "unknown" },
                currentAttempt,
                activeModelConfig: initialModelConfig,
                baseActionLog,
                logAction,
              });
              if (!tokenLimitResult.ok) {
                responseData = tokenLimitResult.responseData;
                return;
              }
              if (tokenLimitResult.truncatedBody) {
                body = tokenLimitResult.truncatedBody;
              }
            }

            if (!strategyRoutingChecked && !currentAttempt.isFallback) {
              strategyRoutingChecked = true;
              try {
                const requestClass = classifyGatewayRequestClass(body);
                const isContinuation = requestClass.requestClass === "tool_continuation";
                let previousModelId: string | null = null;
                if (isContinuation) {
                  const clientSessionIdVal = (request.headers["x-client-session-id"] || request.headers["x-conversation-id"] || request.headers["x-session-id"]) as string | undefined;
                  previousModelId = await getStickyModelForContinuation(body, authCtx.userId, clientSessionIdVal);
                }
                const strategyDecision = await resolveStrategyRoutingDecision({
                  route,
                  body,
                  currentAttempt,
                  incomingProtocol,
                  previousModelId,
                  isContinuation,
                });

                if (
                  strategyDecision?.applied ||
                  (strategyDecision?.skipReason && !["already_on_target", "no_matching_rule", "client_sidecar", "client_named_small_model"].includes(strategyDecision.skipReason))
                ) {
                  logAction({
                    ...baseActionLog,
                    level: strategyDecision.applied ? "INFO" : "WARN",
                    code: strategyDecision.applied ? "request.strategy_routing.applied" : "request.strategy_routing.skipped",
                    taskType: strategyDecision.taskType,
                    reason: strategyDecision.reasons.join(","),
                    targetProviderId: strategyDecision.rule?.providerId || "",
                    targetModelId: strategyDecision.rule?.modelId || currentAttempt.modelId,
                    skipReason: strategyDecision.skipReason || "",
                  });
                }

                if (strategyDecision?.applied && strategyDecision.newAttempt) {
                  if (
                    shouldRecordStrategyRoutingHop(currentAttempt, strategyDecision.newAttempt)
                  ) {
                     ctx.routingTrace.push({
                       fromProviderId: currentAttempt.providerId,
                       fromModelId: currentAttempt.modelId,
                       toProviderId: strategyDecision.newAttempt.providerId,
                       toProviderProtocol: strategyDecision.newAttempt.providerProtocol,
                       toModelId: strategyDecision.newAttempt.modelId,
                       reason: `strategy:${strategyDecision.taskType} ${strategyDecision.reasons.join(",")}`,
                       hop: 1,
                       latencyMs: 0,
                       createdAt: new Date().toISOString(),
                     });
                  }
                  strategyDecisionApplied = true;
                  currentAttempt = {
                    ...strategyDecision.newAttempt,
                    strategyTaskType: strategyDecision.taskType,
                    strategyReason: strategyDecision.reasons.join(","),
                  };
                  ctx.currentAttempt = currentAttempt;
                }
              } catch (e: any) {
                logAction({
                  ...baseActionLog,
                  level: "WARN",
                  code: "request.strategy_routing.error",
                  error: e?.message || "unknown",
                });
              }
            }

            // --- 8. Provider Resolution ---
            const providerList = await db
              .select()
              .from(providers)
              .where(and(eq(providers.id, currentAttempt.providerId), eq(providers.enabled, true)));
            if (providerList.length === 0) {
              if (currentAttempt.isFallback) break;
              responseData = { status: 503, data: formatError(incomingProtocol, 503, "供应商不存在或已停用", "provider_disabled"), isStream: false };
              return;
            }
            const provider = providerList[0];
            ctx.activeProvider = provider;

            const modelConfigList = await db
              .select()
              .from(providerModels)
              .where(and(
                eq(providerModels.providerId, currentAttempt.providerId),
                eq(providerModels.modelId, currentAttempt.modelId),
              ));
            activeModelConfig = modelConfigList.length > 0 ? modelConfigList[0] : null;
            ctx.activeModelConfig = activeModelConfig;

            ctx.routingRequirements = await computeRoutingRequirements(
              body,
              activeModelConfig,
              classifyGatewayRequestClass(body).requestClass === "tool_continuation",
            );

            const contextBudget = resolveModelContextWindow(activeModelConfig);
            if (
              !longContextOverrideApplied &&
              contextBudget.limit > 0 &&
              route.strategyRoutingEnabled &&
              currentAttempt.strategyTaskType !== "long_context"
            ) {
              const routingTokens = await estimateMultimodalInputUsage({ body });
              let estimatedTextTokens = routingTokens.textTokens;
              let estimatedImageTokens = routingTokens.imageTokens;
              let estimatedTotalTokens = routingTokens.totalTokens;
              let imageCount = routingTokens.imageCount;

              const policyCtx = {
                userId: authCtx.userId,
                apiKeyId: authCtx.apiKeyRecord.id,
                endpointId: endpoint.id,
                subdomainId: subdomainRecord?.id || null,
                headers: request.headers as Record<string, string | string[] | undefined>,
              };
              const plan = await resolvePromptPolicyPlan(
                body,
                currentAttempt.promptPolicyId || null,
                reqPath,
                policyCtx,
                formatError,
                incomingProtocol
              );
              if (plan.shouldInject && plan.policy?.content) {
                const policyTokens = await estimateMultimodalInputUsage({ body: plan.policy.content });
                estimatedTextTokens += policyTokens.totalTokens;
                estimatedTotalTokens += policyTokens.totalTokens;
              }

              const safetyMargin = 50; // Add 50 tokens safety margin for formatting overhead
              
              const isContextExhausted = !fitsContextBudget({
                inputTokens: estimatedTotalTokens,
                requestedOutputTokens: 0,
                safetyMargin,
                budget: contextBudget
              });

              if (isContextExhausted) {
                if (ctx.routingRequirements?.requiredCapabilities.vision) {
                  let parsedTargets: any[] = [];
                  if (route.targets) {
                    try {
                      parsedTargets = typeof route.targets === 'string' ? JSON.parse(route.targets) : route.targets;
                    } catch (e) {}
                  }

                  let foundNextVisionTarget = false;
                  const currentTargetIndex = currentAttempt.targetIndex || 0;
                  for (let i = currentTargetIndex + 1; i < parsedTargets.length; i++) {
                    const targetRules = parseStrategyRoutingRules(parsedTargets[i].strategyRoutingRules);
                    const visionRuleRaw = targetRules.find((r: any) => r.taskType === "vision" && r.enabled !== false);
                    if (visionRuleRaw) {
                      const validation = await validateOneStrategyRule({
                        incomingProtocol,
                        rule: visionRuleRaw,
                      });
                      if (validation.ok) {
                        const matchedModelRows = await db
                          .select()
                          .from(providerModels)
                          .where(
                            and(
                              eq(providerModels.providerId, validation.rule.providerId),
                              eq(providerModels.modelId, validation.rule.modelId)
                            )
                          )
                          .limit(1);
                        const targetModelConfig = matchedModelRows.length > 0 ? matchedModelRows[0] : null;
                        const targetContextBudget = resolveModelContextWindow(targetModelConfig);
                        
                        const isTargetContextSufficient = fitsContextBudget({
                          inputTokens: estimatedTotalTokens,
                          requestedOutputTokens: 0,
                          safetyMargin,
                          budget: targetContextBudget
                        });

                        if (targetModelConfig && isTargetContextSufficient) {
                          logAction({
                            ...baseActionLog,
                            level: "WARN",
                            code: "request.long_context_override",
                            originalTaskType: currentAttempt.strategyTaskType || "initial",
                            originalModelId: currentAttempt.modelId,
                            targetModelId: validation.rule.modelId,
                            estimatedTokens: estimatedTotalTokens,
                            modelLimit: contextBudget.limit,
                          });
                          ctx.routingTrace.push({
                            fromProviderId: currentAttempt.providerId,
                            fromModelId: currentAttempt.modelId,
                            toProviderId: validation.rule.providerId,
                            toProviderProtocol: validation.rule.providerProtocol,
                            toModelId: validation.rule.modelId,
                            reason: `long_context_vision_override:input_${estimatedTotalTokens}>${contextBudget.limit}`,
                            hop: ctx.routingTrace.length + 1,
                            latencyMs: 0,
                            createdAt: new Date().toISOString(),
                          });

                          currentAttempt = {
                            ...currentAttempt,
                            providerId: validation.rule.providerId,
                            providerProtocol: validation.rule.providerProtocol,
                            modelId: validation.rule.modelId,
                            targetIndex: i,
                            strategyTaskType: "vision",
                            strategyReason: `long_context_override:input_${estimatedTotalTokens}>${contextBudget.limit}`,
                          };
                          ctx.currentAttempt = currentAttempt;

                          activeModelConfig = targetModelConfig;
                          ctx.activeModelConfig = activeModelConfig;

                          longContextOverrideApplied = true;
                          foundNextVisionTarget = true;
                          break;
                        }
                      }
                    }
                  }

                  if (foundNextVisionTarget) {
                    attemptCount--;
                    continue;
                  }

                  // If no vision target with sufficient context found, fall through to try long_context rules below
                }

                // Try long_context rules only when input exceeds the 1M-token strategy floor
                // (for non-vision requests, or as fallback when no bigger vision model exists)
                if (
                  !longContextOverrideApplied &&
                  meetsLongContextStrategyTokenFloor(estimatedTotalTokens)
                ) {
                  let currentStrategyRoutingRules = route.strategyRoutingRules;
                  if (route.targets) {
                    try {
                      const parsedTargets = typeof route.targets === 'string' ? JSON.parse(route.targets) : route.targets;
                      const targetIndex = currentAttempt.targetIndex || 0;
                      if (Array.isArray(parsedTargets) && parsedTargets.length > targetIndex) {
                        currentStrategyRoutingRules = parsedTargets[targetIndex].strategyRoutingRules ?? currentStrategyRoutingRules;
                      }
                    } catch (e) {}
                  }
                  const rules = parseStrategyRoutingRules(currentStrategyRoutingRules);
                  const longContextRuleRaw = rules.find(
                    (r: any) => r.taskType === "long_context" && r.enabled
                  );
                  if (longContextRuleRaw) {
                    const validation = await validateOneStrategyRule({
                      incomingProtocol,
                      rule: longContextRuleRaw,
                    });
                    if (validation.ok) {
                      const matchedModelRows = await db
                        .select()
                        .from(providerModels)
                        .where(
                          and(
                            eq(providerModels.providerId, validation.rule.providerId),
                            eq(providerModels.modelId, validation.rule.modelId)
                          )
                        )
                        .limit(1);
                      const targetModelConfig = matchedModelRows.length > 0 ? matchedModelRows[0] : null;
                      const targetContextBudget = resolveModelContextWindow(targetModelConfig);

                      const isTargetContextSufficient = fitsContextBudget({
                        inputTokens: estimatedTotalTokens,
                        requestedOutputTokens: 0,
                        safetyMargin,
                        budget: targetContextBudget
                      });

                      if (isTargetContextSufficient) {
                        const longContextRule = validation.rule;
                        logAction({
                          ...baseActionLog,
                          level: "WARN",
                          code: "request.long_context_override",
                          originalTaskType: currentAttempt.strategyTaskType || "initial",
                          originalModelId: currentAttempt.modelId,
                          targetModelId: longContextRule.modelId,
                          estimatedTokens: estimatedTotalTokens,
                          modelLimit: contextBudget.limit,
                        });
                        ctx.routingTrace.push({
                          fromProviderId: currentAttempt.providerId,
                          fromModelId: currentAttempt.modelId,
                          toProviderId: longContextRule.providerId,
                          toProviderProtocol: longContextRule.providerProtocol,
                          toModelId: longContextRule.modelId,
                          reason: `long_context_override:input_${estimatedTotalTokens}>${contextBudget.limit}`,
                          hop: ctx.routingTrace.length + 1,
                          latencyMs: 0,
                          createdAt: new Date().toISOString(),
                        });
                        currentAttempt = {
                          ...currentAttempt,
                          providerId: longContextRule.providerId,
                          providerProtocol: longContextRule.providerProtocol,
                          modelId: longContextRule.modelId,
                          strategyTaskType: "long_context",
                          strategyReason: "override:input_exceeds_model_limit",
                        };
                        ctx.currentAttempt = currentAttempt;
                        longContextOverrideApplied = true;
                        attemptCount--;
                        continue;
                      }
                    }
                  }
                }
              }
            }

            let isAnthropicUpstream = currentAttempt.providerProtocol === "anthropic";

            // --- 8.2 Hourly Token Limit Check ---
            if (provider.hourlyTokenLimit > 0) {
              const oneHourAgo = new Date(Date.now() - 3600 * 1000);
              const usageResult = await db.select({ total: sql<number>`sum(totalTokens)` })
                .from(requestLogs)
                .where(and(eq(requestLogs.providerId, provider.id), gte(requestLogs.createdAt, oneHourAgo)));
              const usage = usageResult[0]?.total || 0;
              if (usage >= provider.hourlyTokenLimit) {
                responseData = {
                  status: 429,
                  data: formatError(incomingProtocol, 429, "供应商已达到每小时Token限制", "provider_rate_limit"),
                  isStream: false
                };
                (ctx as any)._responseData = responseData;
                const errorFallback = await checkErrorFallback({ status: 429, currentAttempt, route, body, provider, responseData, baseActionLog, logAction, incomingProtocol });
                if (errorFallback) {
                  currentAttempt = errorFallback.newAttempt;
                  ctx.currentAttempt = currentAttempt;
                  attemptCount = reserveAttemptBudgetForLayerSwitch(attemptCount, maxAttempts);
                  continue;
                } else {
                  break;
                }
              }
            }


            // --- 8.5 Concurrency Fallback Check ---
            const provQueue = getProviderQueue(provider.id, provider.concurrencyLimit);
            const concurrencyFallback = await checkConcurrencyFallback(
              currentAttempt,
              route,
              body,
              provQueue,
              provider,
              baseActionLog,
              logAction,
              incomingProtocol
            );
            if (concurrencyFallback) {
              currentAttempt = concurrencyFallback.newAttempt;
              ctx.currentAttempt = currentAttempt;
              attemptCount = reserveAttemptBudgetForLayerSwitch(attemptCount, maxAttempts);
              continue;
            }

            const activeKeysList = await db
               .select()
               .from(providerApiKeys)
               .where(and(eq(providerApiKeys.providerId, currentAttempt.providerId), eq(providerApiKeys.status, 'active')));

            let decryptedKey: string | null = null;
            let baseUrl = "";
            let activeKeyId: string | null = null;
            const targetState = getTargetKeyState(currentAttempt.providerId, currentAttempt.modelId);
            const keySelection = selectProviderKey({
              activeKeysList,
              triedKeys: targetState.triedKeyIds,
              providerKeyCursors,
              providerId: currentAttempt.providerId,
              preferredActiveKeyId: targetState.preferredKeyId,
              decryptText,
            });

            if (keySelection.kind === "no_active_keys") {
              responseData = {
                status: 500,
                data: formatError(incomingProtocol, 500, "供应商缺少可用API密钥", "server_error"),
                isStream: false,
                provider: { name: provider.name }
              };
              if (currentAttempt.isFallback) {
                 break;
              } else {
                 return;
              }
            } else if (keySelection.kind === "all_active_keys_tried") {
              logAction({
                ...baseActionLog,
                level: "WARN",
                code: "request.provider_keys_exhausted_for_attempt",
                message: `All active keys for target ${currentAttempt.providerId}/${currentAttempt.modelId} have been tried.`,
                providerName: provider.name,
                modelId: currentAttempt.modelId,
              });

              const lastErr = targetState.lastUpstreamError;
              if (lastErr) {
                 responseData = lastErr;
                 const errorFallback = await checkErrorFallback({
                   status: responseData.status,
                   currentAttempt,
                   route,
                   body,
                   provider,
                   responseData,
                   baseActionLog,
                   logAction,
                   incomingProtocol,
                 });
                 if (errorFallback) {
                   currentAttempt = errorFallback.newAttempt;
                   ctx.currentAttempt = currentAttempt;
                   responseData = null;
                   attemptCount = reserveAttemptBudgetForLayerSwitch(attemptCount, maxAttempts);
                   continue;
                 }
                 break;
              }
              
              responseData = {
                status: 500,
                data: formatError(incomingProtocol, 500, "目标模型下的API密钥均已耗尽", "server_error"),
                isStream: false,
                provider: { name: provider.name }
              };
              break;
            }

            if (keySelection.kind === "selected") {
              activeKeyId = keySelection.keyId;
              decryptedKey = keySelection.decryptedKey;
            }

            if (activeKeyId) {
               db.update(providerApiKeys)
                 .set({ lastUsedAt: new Date() })
                 .where(eq(providerApiKeys.id, activeKeyId))
                 .execute()
                 .catch((e: any) => {
                    console.error("[PromptGate] Failed to update provider API key lastUsedAt:", e);
                 });
            }

            // --- 8.6 Provider Adapter Resolution & Base URL Selection Sequence ---
            // Protocol-aware URL dispatch: providerProtocol determines the PRIMARY URL.
            // If primary URL exists, alternate URL is NEVER scanned.
            // Alternate URL is only checked when primary is null/undefined.
            let adapter = transparentAdapter;
            let matchedAdapterProtocol = "";

            const isAnthropicRoute = currentAttempt.providerProtocol === "anthropic";
            const primaryUrl = isAnthropicRoute
              ? (provider.anthropicBaseUrl || "").replace(/\/+$/, "") || null
              : (provider.openaiBaseUrl || "").replace(/\/+$/, "") || null;
            const primaryProtocol = isAnthropicRoute ? "anthropic" : "openai";
            const alternateUrl = isAnthropicRoute
              ? (provider.openaiBaseUrl || "").replace(/\/+$/, "") || null
              : (provider.anthropicBaseUrl || "").replace(/\/+$/, "") || null;
            const alternateProtocol = isAnthropicRoute ? "openai" : "anthropic";

            let adapterDisabled = false;
            let urlOwner: string | null = null;

            function resolveForUrl(url: string, protocol: string) {
              const urlNorm = parseAndNormalizeUrl(url);
              if (!urlNorm.isValid) return { adapter: transparentAdapter, ownerId: null, disabled: false };
              const mockCtx = {
                providerId: currentAttempt.providerId,
                providerName: provider.name,
                providerProtocol: protocol,
                rawBaseUrl: url,
                normalizedBaseUrl: urlNorm.normalizedBaseUrl,
                hostname: urlNorm.hostname,
                pathname: urlNorm.pathname,
                modelId: currentAttempt.modelId,
                incomingProtocol,
                requestPath: reqPath,
                clientHeaders: ctx.request.headers,
              };
              return resolveProviderAdapterDetailed(mockCtx);
            }

            if (primaryUrl) {
              baseUrl = primaryUrl;
              matchedAdapterProtocol = primaryProtocol;
              const res = resolveForUrl(primaryUrl, primaryProtocol);
              adapter = res.adapter;
              urlOwner = res.ownerId;
              adapterDisabled = res.disabled;
            } else if (alternateUrl) {
              const res = resolveForUrl(alternateUrl, alternateProtocol);
              if (res.ownerId === "google" || res.ownerId === "openrouter") {
                baseUrl = alternateUrl;
                matchedAdapterProtocol = alternateProtocol;
                adapter = res.adapter;
                urlOwner = res.ownerId;
                adapterDisabled = res.disabled;
              } else {
                urlOwner = null;
                adapterDisabled = false;
                adapter = transparentAdapter;
                if (isAnthropicRoute) {
                  baseUrl = "https://api.anthropic.com";
                } else {
                  baseUrl = "https://api.openai.com/v1";
                }
                matchedAdapterProtocol = primaryProtocol;
              }
            } else {
              urlOwner = null;
              adapterDisabled = false;
              adapter = transparentAdapter;
              if (isAnthropicRoute) {
                baseUrl = "https://api.anthropic.com";
              } else {
                baseUrl = "https://api.openai.com/v1";
              }
              matchedAdapterProtocol = primaryProtocol;
            }

            const urlNorm = parseAndNormalizeUrl(baseUrl);
            const adapterCtx = {
              providerId: currentAttempt.providerId,
              providerName: provider.name,
              providerProtocol: matchedAdapterProtocol || currentAttempt.providerProtocol,
              rawBaseUrl: baseUrl,
              normalizedBaseUrl: urlNorm.normalizedBaseUrl,
              hostname: urlNorm.hostname,
              pathname: urlNorm.pathname,
              modelId: currentAttempt.modelId,
              incomingProtocol,
              requestPath: reqPath,
              clientHeaders: ctx.request.headers,
            };

            ctx.activeProviderAdapter = adapter;
            ctx.activeProviderAdapterContext = adapterCtx;
            ctx.activeProviderAdapterState = adapter.createAttemptState ? adapter.createAttemptState(adapterCtx) : {};

            const effectiveProtocol = adapter?.effectiveUpstreamProtocol
              ? adapter.effectiveUpstreamProtocol(adapterCtx) || currentAttempt.providerProtocol
              : currentAttempt.providerProtocol;
            ctx.activeEffectiveUpstreamProtocol = effectiveProtocol;
            const bypassProtocolAdaptation = adapter?.bypassProtocolAdaptation
              ? adapter.bypassProtocolAdaptation(adapterCtx)
              : false;

            // If we bypass adaptation, we pretend the upstream matches the incoming protocol for transformation purposes,
            // or we just set isAnthropicUpstream to what effectiveProtocol says.
            // Wait, transformRequestBody adapts incoming to isAnthropicUpstream.
            // If bypassProtocolAdaptation is true, we should pass isAnthropicUpstream = (incomingProtocol === "anthropic") to avoid any transformation.
            const transformAsAnthropic = bypassProtocolAdaptation ? (incomingProtocol === "anthropic") : (effectiveProtocol === "anthropic");
            isAnthropicUpstream = transformAsAnthropic;

            if (logAction) {
              logAction({
                ...baseActionLog,
                level: "INFO",
                code: "request.provider_adapter.selected",
                providerName: provider.name,
                adapterId: adapter.id,
                urlOwner,
                adapterDisabled,
                configuredProtocol: currentAttempt.providerProtocol,
                effectiveProtocol,
                effectiveBaseUrl: baseUrl,
                hostname: urlNorm.hostname,
                modelId: currentAttempt.modelId,
                providerId: currentAttempt.providerId,
                message: `Selected Provider Adapter: ${adapter.id}`,
              });
            }

            // --- 9. Payload Transformation ---
            const { modifiedBody, isStreaming: detectedStreaming } = transformRequestBody(
              body,
              currentAttempt.modelId,
              isAnthropicUpstream,
              activeModelConfig?.maxOutputTokens || null,
              logAction,
              baseActionLog,
              provider.name,
            );
            isStreaming = detectedStreaming;

            ctx.isStreaming = isStreaming;
            // --- 10. Prompt Policy ---
            const policyError = await applyPromptPolicy(
              modifiedBody,
              currentAttempt.promptPolicyId,
              reqPath,
              isAnthropicUpstream,
              {
                userId: authCtx.userId,
                apiKeyId: authCtx.apiKeyRecord.id,
                endpointId: endpoint.id,
                subdomainId: subdomainRecord?.id || null,
                headers: request.headers as Record<string, string | string[] | undefined>,
              },
              formatError,
              incomingProtocol,
            );
            if (policyError) {
              responseData = { status: policyError.status, data: policyError.data, isStream: false };
              return;
            }

            // --- 10.3 Cache Check ---
            const cacheHit = await checkAndServeCachedResponse(
              request,
              reply,
              modifiedBody,
              authCtx,
              { incomingProtocol, reqPath, endpoint, route, subdomainRecord },
              currentAttempt,
              baseActionLog,
              startTime,
              activeModelConfig?.alias,
            );
            if (cacheHit) {
              responseData = { status: 200, data: { cached: true }, isStream: false };
              cacheServed = true;
              return;
            }

            // --- 11. Protocol Adaptation ---
            const requestPolicy = adapter.getRequestPolicy ? adapter.getRequestPolicy(adapterCtx) : undefined;
            let { finalBody, logInfo } = adaptRequestProtocol(
              modifiedBody,
              incomingProtocol,
              isAnthropicUpstream,
              isStreaming,
              currentAttempt.modelId,
              { ...baseActionLog, providerName: provider.name },
              logAction,
              requestPolicy,
              {
                hostname: urlNorm?.hostname,
                pathname: urlNorm?.pathname,
                rawBaseUrl: baseUrl,
              },
            );

            if (adapter?.adaptRequestBody) {
              try {
                finalBody = adapter.adaptRequestBody(adapterCtx, finalBody, { logAction, baseActionLog });
              } catch (adaptErr: any) {
                // Adapter-thrown protocol incompatibilities (server-tool shorthand in history,
                // deferred tools, etc.) enter the funnel fallback loop instead of crashing.
                const isProtocolIncompatible =
                  adaptErr?.errorType === "protocol_payload_incompatible" ||
                  adaptErr?.code === "unsupported_server_tool_shorthand" ||
                  adaptErr?.code === "deferred_custom_tools_unsupported";
                if (isProtocolIncompatible) {
                  responseData = {
                    status: 400,
                    data: { error: { message: adaptErr.message, type: adaptErr.errorType || "protocol_payload_incompatible" } },
                    isStream: false,
                    latencyMs: Date.now() - startTime,
                    queueMs: 0,
                    provider,
                    baseLog: baseActionLog
                  };
                  responseData.terminalError = {
                    statusCode: 400,
                    code: adaptErr.code || "protocol_payload_incompatible",
                    errorType: adaptErr.errorType || "protocol_payload_incompatible",
                    message: adaptErr.message,
                    retryable: false,
                    retryClass: "protocol_payload_incompatible",
                    adapterId: adapter.id,
                    upstreamProvider: provider.name,
                    phase: "nonstream"
                  };
                  (ctx as any)._responseData = responseData;
                  const errorFallback = await checkErrorFallback({ status: 400, currentAttempt, route, body, provider, responseData, baseActionLog, logAction, incomingProtocol });
                  if (errorFallback) {
                    currentAttempt = errorFallback.newAttempt;
                    ctx.currentAttempt = currentAttempt;
                    responseData = null;
                    attemptCount = reserveAttemptBudgetForLayerSwitch(attemptCount, maxAttempts);
                    continue;
                  }
                  break; // If no fallback available, break loop
                } else {
                  throw adaptErr; // Unexpected error
                }
              }
            }

            let compatibilitySummary = undefined;
            if (adapter?.id === "google") {
              compatibilitySummary = applyProviderCompatibility(finalBody, {
                providerName: provider.name,
                baseUrl,
                providerProtocol: currentAttempt.providerProtocol,
                modelId: currentAttempt.modelId,
                // logAction omitted to defer logging until response status is known
              });
            }

            // Re-apply learned constraint rewrites for this provider:model (error-driven recovery).
            applyConstraintMutators(finalBody, targetState.constraintMutators);

            const googleNativeRequest = buildGoogleNativeRequest({
              body: finalBody,
              baseUrl,
              modelId: currentAttempt.modelId,
              isStreaming,
              providerName: provider.name,
              providerProtocol: currentAttempt.providerProtocol,
            });
            const upstreamBody = googleNativeRequest ? googleNativeRequest.body : finalBody;
            usageRequestBody = JSON.parse(JSON.stringify(upstreamBody));
            ctx.usageRequestBody = usageRequestBody;

            // --- Vision Guard ---
            const outboundCapabilities = inspectOutboundCapabilities(usageRequestBody);
            if (outboundCapabilities.vision && !longContextOverrideApplied) {
              const currentLayerVision = getStrategyRuleForLayer(route, currentAttempt.targetIndex || 0, "vision");
              
              if (currentLayerVision) {
                if (currentAttempt.providerId !== currentLayerVision.providerId || currentAttempt.modelId !== currentLayerVision.modelId) {
                  // Direct switch to current layer vision, attemptCount=0
                  currentAttempt = {
                    providerId: currentLayerVision.providerId,
                    modelId: currentLayerVision.modelId,
                    providerProtocol: currentLayerVision.providerProtocol,
                    targetIndex: currentAttempt.targetIndex || 0,
                    promptPolicyId: route.promptPolicyId || undefined,
                    isFallback: true,
                    fallbackReason: "vision_routing_fallback"
                  };
                  ctx.currentAttempt = currentAttempt;
                  attemptCount--; // do not consume attempt
                  continue;
                }
              } else {
                // Search next layers
                let foundNextVision = null;
                let foundIndex = currentAttempt.targetIndex || 0;
                let parsedTargets = [];
                try { parsedTargets = typeof route.targets === 'string' ? JSON.parse(route.targets) : route.targets; } catch (e) {}
                for (let i = foundIndex + 1; i < (parsedTargets || []).length; i++) {
                  const v = getStrategyRuleForLayer(route, i, "vision");
                  if (v) {
                    foundNextVision = v;
                    foundIndex = i;
                    break;
                  }
                }
                if (foundNextVision) {
                  currentAttempt = {
                    providerId: foundNextVision.providerId,
                    modelId: foundNextVision.modelId,
                    providerProtocol: foundNextVision.providerProtocol,
                    targetIndex: foundIndex,
                    promptPolicyId: route.promptPolicyId || undefined,
                    isFallback: true,
                    fallbackReason: "vision_routing_fallback"
                  };
                  ctx.currentAttempt = currentAttempt;
                  attemptCount--; // do not consume attempt
                  continue;
                } else {
                  // No vision anywhere
                  responseData = {
                    status: 400,
                    data: formatError(incomingProtocol, 400, "vision_routing_unavailable", "vision_routing_unavailable"),
                    isStream: false,
                    terminalError: {
                      statusCode: 400,
                      code: "vision_routing_unavailable",
                      errorType: "invalid_request",
                      message: "No vision models configured",
                      requiredCapability: "vision",
                      retryClass: "invalid_request",
                      retryable: false,
                      adapterId: adapter?.id
                    }
                  };
                  break;
                }
              }
            }
            // --- 13. Initial Request Log ---
            const baseLog = buildBaseLog(ctx, provider, activeKeyId);
            await insertInitialRequestLog(ctx, baseLog);
            isLogInserted = ctx.isLogInserted;

            const attemptStartQueueMs = Date.now();

            // --- 14. Upstream Fetch (inside provider queue) ---
            const attemptResult = await provQueue.add(async (holdProv) => {
              const queueMs = Date.now() - attemptStartQueueMs;
              if (queueMs > 50) {
                logAction({
                  ...baseActionLog,
                  level: "INFO",
                  code: "request.dequeued",
                  providerName: provider.name,
                  modelId: currentAttempt.modelId,
                  queueMs,
                  fallback: currentAttempt.isFallback,
                  fallbackReason: currentAttempt.fallbackReason,
                });
              }

              ensureEarlyStreamPrelude(incomingProtocol === "anthropic" && !isAnthropicUpstream);

              // Estimate tokens & update log to processing
              const multimodalEst = await estimateMultimodalInputUsage({
                body: finalBody,
                modelId: currentAttempt.modelId,
                tokenizerRepo: activeModelConfig?.tokenizerRepo || undefined,
                weightProxyUrl: provider.weightProxyUrl || undefined
              });
              ctx.stream.estimatedPromptTokens = multimodalEst.totalTokens;

              publishRequestLogUpdate({
                id: reqLogId,
                userId: authCtx.userId,
                ...baseLog,
                usageStatus: "processing",
                inputTokens: ctx.stream.estimatedPromptTokens,
                latencyMs: Date.now() - startTime,
                alias: activeModelConfig?.alias,
              });

              let timeoutId: NodeJS.Timeout | undefined;
              const fetchController = new AbortController();
              const abortListener = () => fetchController.abort();
              controller.signal.addEventListener("abort", abortListener);

              if (provider.timeoutMs > 0) {
                timeoutId = setTimeout(() => fetchController.abort(), provider.timeoutMs);
              }

              let upstreamHeaders = googleNativeRequest
                ? buildGoogleNativeHeaders(decryptedKey!)
                : buildUpstreamHeaders(decryptedKey!, (effectiveProtocol === "anthropic"), reqPath);

              if (adapter?.adaptUpstreamHeaders) {
                const adapted = adapter.adaptUpstreamHeaders(adapterCtx, upstreamHeaders);
                if (adapted) upstreamHeaders = adapted;
              }

              let upstreamPath = googleNativeRequest
                ? googleNativeRequest.upstreamPath
                : determineUpstreamPath((effectiveProtocol === "anthropic"), reqPath);

              if (adapter?.overrideUpstreamPath) {
                const overridden = adapter.overrideUpstreamPath(adapterCtx, upstreamPath);
                if (overridden) upstreamPath = overridden;
              }
              let upstreamBaseUrl = googleNativeRequest?.baseUrl || baseUrl;
              if (adapter?.overrideUpstreamBaseUrl) {
                const overriddenBaseUrl = adapter.overrideUpstreamBaseUrl(adapterCtx, upstreamBaseUrl);
                if (overriddenBaseUrl) upstreamBaseUrl = overriddenBaseUrl;
              }
              const upstreamBody = googleNativeRequest?.body || finalBody;
              const upstreamProtocolForLog = googleNativeRequest
                ? "google-native"
                : effectiveProtocol;



              try {
                const result = await executeUpstreamFetch({
                  baseUrl: upstreamBaseUrl,
                  upstreamPath,
                  upstreamHeaders,
                  finalBody: upstreamBody,
                  controller: fetchController,
                  provider,
                  isStreaming,
                  modelId: currentAttempt.modelId,
                  holdProv,
                  holdUser,
                  holdGlobal,
                  queueMs,
                  attemptStartProcessingMs: Date.now(),
                  baseLog,
                  timeoutId,
                  currentAttempt,
                  incomingProtocol,
                  isAnthropicUpstream,
                  isGoogleNativeUpstream: !!googleNativeRequest,
                  adapter,
                  adapterContext: adapterCtx,
                  adapterState: ctx.activeProviderAdapterState,
                  roundId: currentRoundId,
                 });
                if (!result.isStream && result.status >= 400) {
                  const omitPayload = [429, 500, 502, 503, 504, 529].includes(result.status);
                  logAction({
                    ...baseActionLog,
                    level: "WARN",
                    code: "request.upstream_diagnostic",
                    providerName: provider.name,
                    modelId: currentAttempt.modelId,
                    statusCode: result.status,
                    upstreamUrl: result.upstreamUrl || `${upstreamBaseUrl}${upstreamPath}`,
                    incomingProtocol,
                    upstreamProtocol: upstreamProtocolForLog,
                    streaming: isStreaming,
                    attempt: attemptCount,
                    maxAttempts,
                    upstreamRequestIds: result.upstreamRequestIds,
                    message: buildUpstreamRequestDiagnostic(upstreamBody, {
                      upstreamPath,
                      errorDetail: result.errorDetail,
                    }, omitPayload),
                  });
                }
                if (!isStreaming) {
                  controller.signal.removeEventListener("abort", abortListener);
                  if (timeoutId) clearTimeout(timeoutId);
                }
                return result;
              } catch (fetchErr: any) {
                if (timeoutId) clearTimeout(timeoutId);
                controller.signal.removeEventListener("abort", abortListener);
                if (controller.signal.aborted) {
                  return {
                    status: 499,
                    data: { error: { message: "Client Closed Request", type: "client_closed" } },
                    isStream: false,
                    latencyMs: Date.now() - startTime,
                    queueMs,
                    provider,
                    baseLog
                  };
                }

                // Instead of throwing and aborting the request, we simulate a 504/502 response
                // so that the gateway can attempt to use a fallback model.
                const status = fetchErr.name === "AbortError" || fetchErr.message?.includes("timeout") ? 504 : 502;
                logAction({
                  ...baseActionLog,
                  level: "WARN",
                  code: "request.upstream_diagnostic",
                  providerName: provider.name,
                  modelId: currentAttempt.modelId,
                  statusCode: status,
                  upstreamUrl: `${upstreamBaseUrl}${upstreamPath}`,
                  incomingProtocol,
                  upstreamProtocol: upstreamProtocolForLog,
                  streaming: isStreaming,
                  attempt: attemptCount,
                  maxAttempts,
                  message: buildUpstreamRequestDiagnostic(upstreamBody, {
                    upstreamPath,
                    fetchError: fetchErr.message || String(fetchErr),
                  }, true),
                });
                return {
                  status,
                  data: { error: { message: fetchErr.message || String(fetchErr), type: "network_error" } },
                  isStream: false,
                  latencyMs: Date.now() - startTime,
                  queueMs,
                  provider,
                  baseLog
                };
              }
            });

            responseData = attemptResult;
            const releaseAttemptResources = () => {
              if (attemptResult && attemptResult.releaseSlots) {
                attemptResult.releaseSlots();
                attemptResult.releaseSlots = undefined;
              }
            };
            if (responseData) {
              responseData.roundRequestBody = JSON.parse(JSON.stringify(usageRequestBody));
              responseData.roundId = currentRoundId;
              responseData.activeKeyId = activeKeyId;
              responseData.availableKeys = activeKeysList;
              if (responseData.status >= 400) {
                const adapterContext = {
                  rawBaseUrl: provider.openaiBaseUrl,
                  incomingProtocol,
                  clientHeaders: request.headers,
                };
                responseData.terminalError = classifyUpstreamErrorWithAdapter(
                  adapter,
                  { rawError: responseData.data, statusCode: responseData.status, phase: "nonstream" },
                  adapterContext
                );
              }
            }
            (ctx as any)._responseData = responseData;

            const isCapacityError = isOpenRouterCapacityError(responseData?.terminalError);

            if (isCapacityError) {
              const capacityRetryState = getCapacityRetryState(currentAttempt.providerId, currentAttempt.modelId);
              if (capacityRetryState.retryCount < capacityRetryState.maxRetries && !capacityRetryState.exhausted) {
                capacityRetryState.retryCount++;
                capacityRetryState.activeKeyId = activeKeyId;
                targetState.preferredKeyId = activeKeyId;

                logAction({
                  ...baseActionLog,
                  level: "WARN",
                  code: "request.upstream_retry",
                  providerName: provider.name,
                  modelId: currentAttempt.modelId,
                  statusCode: responseData.status,
                  attempt: attemptCount,
                  maxAttempts,
                  reason: "capacity_retry",
                  preserveAttemptCount: true,
                });

                attemptCount--;
                responseData = null;
                releaseAttemptResources();
                continue;
              }
            }

            if (responseData.status !== 200 && compatibilitySummary) {
              logAction({
                ...baseActionLog,
                level: "WARN",
                code: "request.provider_compatibility",
                providerName: provider.name,
                modelId: currentAttempt.modelId,
                message: compatibilitySummary,
              });
            }

            // --- 14.5 Auto-Drive Check for hanging states ---
            let responseTextForAutoDrive: string | null = null;
            if (responseData.isFakeStream && responseData.fakeStreamText) {
               responseTextForAutoDrive = responseData.fakeStreamText;
            } else if (!responseData.isStream && responseData.data) {
               if (responseData.data.choices?.[0]?.message?.content) {
                  responseTextForAutoDrive = responseData.data.choices[0].message.content;
               } else if (responseData.data.content && Array.isArray(responseData.data.content)) {
                  responseTextForAutoDrive = responseData.data.content.map((b: any) => b.text || "").join("");
               }
            }

            if (responseData && responseData.status === 200) {
               // Stage 1: Non-streaming / fake-stream candidate early continuity check
               if (!ctx.isStreaming || responseData.isFakeStream) {
                  let textFromThisRound = "";
                  if (responseData.isFakeStream && responseData.fakeStreamText) {
                     textFromThisRound = responseData.fakeStreamText;
                  } else if (responseData.data?.choices?.[0]?.message?.content) {
                     textFromThisRound = responseData.data.choices[0].message.content;
                  } else if (responseData.data?.content && Array.isArray(responseData.data.content)) {
                     textFromThisRound = responseData.data.content.map((b: any) => b.text || "").join("");
                  }

                  const textToCheck = (ctx.continuity.accumulatedCompletionText || "") + textFromThisRound;

                  // Temporarily mock context for early evaluation
                  const earlyDecision = await continuityEngine.evaluateAll({
                     originalBody,
                     responseData,
                     requestClass: classifyGatewayRequestClass(originalBody).requestClass,
                     baseActionLog,
                     currentAttempt,
                     accumulatedCompletionText: textToCheck,
                     state: new Map()
                  });

                  const shouldPerformRetry = earlyDecision.shouldIntervene && (continuityCycles < MAX_CONTINUITY_CYCLES);

                  if (earlyDecision.shouldIntervene && continuityCycles >= MAX_CONTINUITY_CYCLES) {
                     logAction?.({
                        ...baseActionLog,
                        level: "WARN",
                        code: "request.continuity.exhausted",
                        message: `Continuity loop exhausted at ${continuityCycles} cycles`,
                     });
                  }

                  if (!responseData.roundUsageCommitted) {
                     const roundUsage = await resolveRoundUsage(
                        ctx,
                        responseData,
                        responseData.roundRequestBody
                     );
                     commitRoundUsage(ctx, responseData, roundUsage, responseData.roundId || `continuity-${continuityCycles}`);
                  }

                  if (shouldPerformRetry) {
                     ctx.continuity.hiddenContinuityText += textFromThisRound;
                     ctx.continuity.accumulatedCompletionText = ctx.continuity.forwardedStreamText + ctx.continuity.hiddenContinuityText;

                     body = earlyDecision.modifiedBody;
                     attemptCount--; // Do not consume error retry
                     responseData = null;
                     releaseAttemptResources();
                     continuityCycles++;
                     continue;
                  } else {
                     ctx.continuity.hiddenContinuityText += textFromThisRound;
                     ctx.continuity.accumulatedCompletionText = ctx.continuity.forwardedStreamText + ctx.continuity.hiddenContinuityText;
                     const accum = ctx.continuity.accumulatedCompletionText;
                     if (continuityCycles > 0 && accum) {
                        if (responseData.data.choices?.[0]?.message?.content !== undefined) {
                           responseData.data.choices[0].message.content = accum;
                        } else if (responseData.data.content && Array.isArray(responseData.data.content)) {
                           const lastText = responseData.data.content.find((b: any) => b.type === "text" || !b.type);
                           if (lastText) lastText.text = accum;
                        }
                     }
                     if (ctx.continuity.committedRoundIds.size > 1 || ctx.continuity.usageStatus !== "success") {
                        updateResponseDataUsage(ctx, responseData);
                     }
                     if (responseData.isFakeStream) {
                        const adapterPolicy = adapter?.getRequestPolicy?.(adapterCtx)?.preserveFakeStreamFields
                          ? { preserveFields: adapter.getRequestPolicy(adapterCtx).preserveFakeStreamFields }
                          : undefined;
                        const policy = {
                          ...(adapterPolicy || {}),
                          skipTextLength: ctx.continuity?.forwardedStreamText?.length || 0,
                          skipReasoningLength: ctx.stream?.accumulatedReasoningText?.length || 0
                        };
                        const fakeStreamResult = createFakeStreamFromData(
                          responseData.data,
                          currentAttempt.modelId,
                          responseData.responseProtocol,
                          policy
                        );
                        responseData.stream = fakeStreamResult.fakeStream;
                     }
                  }
               }
            }

            // --- 15. Error Fallback Check ---
            if (responseData.terminalError && responseData.terminalError.requiredCapability === "vision") {
              const errorFallback = await checkErrorFallback({ status: responseData.terminalError.statusCode || responseData.status, currentAttempt, route, body, provider, responseData, baseActionLog, logAction, incomingProtocol, forceCapabilityFallback: true });
              if (errorFallback) {
                currentAttempt = errorFallback.newAttempt;
                ctx.currentAttempt = currentAttempt;
                responseData = null;
                releaseAttemptResources();
                attemptCount = reserveAttemptBudgetForLayerSwitch(attemptCount, maxAttempts);
                continue;
              } else {
                break;
              }
            }

            // --- 15.1 Parameter-constraint recovery (same target, rewrite body, retry) ---
            // Driven by upstream 400/422 message + outbound body shape — not model names.
            // Example: "tool_choice ... required or object in thinking mode".
            if (
              responseData &&
              !responseData.isStream &&
              (responseData.status === 400 || responseData.status === 422)
            ) {
              const recoveryBody =
                responseData.roundRequestBody ||
                usageRequestBody ||
                null;
              const errMsg =
                responseData.terminalError?.message ||
                responseData.data?.error?.message ||
                (typeof responseData.data === "string" ? responseData.data : undefined);
              if (!targetState.appliedConstraintRewrites) {
                targetState.appliedConstraintRewrites = new Set();
              }
              if (!targetState.constraintMutators) {
                targetState.constraintMutators = [];
              }
              const recoveryPlan = planConstraintRecovery({
                statusCode: responseData.status,
                errorMessage: errMsg,
                errorCode: responseData.terminalError?.code || responseData.data?.error?.code,
                body: recoveryBody,
                alreadyApplied: targetState.appliedConstraintRewrites,
              });
              if (recoveryPlan) {
                targetState.appliedConstraintRewrites.add(recoveryPlan.code);
                targetState.constraintMutators.push(recoveryPlan.mutate);
                // Keep the same key: this is a body fix, not a key problem.
                if (activeKeyId) {
                  targetState.preferredKeyId = activeKeyId;
                }
                logAction({
                  ...baseActionLog,
                  level: "WARN",
                  code: "request.constraint_recovery",
                  providerName: provider.name,
                  modelId: currentAttempt.modelId,
                  statusCode: responseData.status,
                  message: recoveryPlan.summary,
                  rewriteCode: recoveryPlan.code,
                  attempt: attemptCount,
                  maxAttempts,
                });
                // Do not consume attempt budget for a body rewrite on the same target.
                attemptCount--;
                responseData = null;
                releaseAttemptResources();
                continue;
              }
            }
            
            const capacityRetryState = getCapacityRetryState(currentAttempt.providerId, currentAttempt.modelId);
            if (capacityRetryState.retryCount >= capacityRetryState.maxRetries) {
              capacityRetryState.exhausted = true;
            }
            if (capacityRetryState.exhausted) {
              if (responseData && responseData.terminalError) {
                responseData.terminalError.retryable = false;
              }
            }
            
            // targetState is already declared at the top of the loop
            if (responseData) {
               targetState.lastUpstreamError = responseData;
            }
            
            const { shouldRetrySameProvider, preserveAttemptCount, reason: retryReason, isAuthenticationError } = await processErrorRetryLogic({
              responseData,
              activeKeyId,
              availableKeys: activeKeysList,
              triedKeys: targetState.triedKeyIds,
              attemptCount,
              maxAttempts,
              allowTransientSameKeyRetry: true,
              capacityExhausted: capacityRetryState.exhausted,
            });

            if (isAuthenticationError && activeKeyId) {
               logAction({
                 ...baseActionLog,
                 level: "ERROR",
                 code: "request.provider_key_rejected_for_target",
                 providerName: provider.name,
                 modelId: currentAttempt.modelId,
                 errorCode: "invalid_api_key",
                 statusCode: responseData.status,
                 keyIdSuffix: activeKeyId.slice(-6),
                 targetScoped: true,
               });
            }

            if (shouldRetrySameProvider) {
               targetState.preferredKeyId = null;

               logAction({
                 ...baseActionLog,
                 level: "WARN",
                 code: "request.upstream_retry",
                 providerName: provider.name,
                 modelId: currentAttempt.modelId,
                 statusCode: responseData.status,
                 attempt: attemptCount,
                 maxAttempts,
                 reason: retryReason,
                 preserveAttemptCount,
               });
               if (preserveAttemptCount) attemptCount--;
               responseData = null;
               releaseAttemptResources();
               continue;
            }

            const isPayloadIncompatible = responseData.terminalError?.retryClass === "protocol_payload_incompatible";
            if (!responseData.isStream && (isPayloadIncompatible || responseData.status === 401 || responseData.status === 429 || responseData.status === 500 || responseData.status === 502 || responseData.status === 503 || responseData.status === 504 || responseData.status === 529)) {
              const errorFallback = await checkErrorFallback({ status: responseData.status, currentAttempt, route, body, provider, responseData, baseActionLog, logAction, incomingProtocol });
              if (errorFallback) {
                currentAttempt = errorFallback.newAttempt;
                ctx.currentAttempt = currentAttempt;
                responseData = null;
                releaseAttemptResources();
                attemptCount = reserveAttemptBudgetForLayerSwitch(attemptCount, maxAttempts);
                continue;
              }
            }

            // Secondary same-key 5xx path (when processErrorRetryLogic did not already retry).
            // Credential-pool empty must not burn remaining budget here either — fall through
            // so the client gets the upstream error (or a later layer if fallback already ran).
            if (
              !capacityRetryState.exhausted &&
              !responseData.isStream &&
              [500, 502, 503, 504, 529].includes(responseData.status) &&
              attemptCount < maxAttempts &&
              !isUpstreamCredentialUnavailableError(responseData)
            ) {
              logAction({
                ...baseActionLog,
                level: "WARN",
                code: "request.upstream_retry",
                providerName: provider.name,
                modelId: currentAttempt.modelId,
                statusCode: responseData.status,
                attempt: attemptCount,
                maxAttempts,
                reason: "transient_upstream_5xx",
                preserveAttemptCount: false,
              });
              responseData = null;
              releaseAttemptResources();
              continue;
            }

            break; // Success or non-fallbackable error
          }
        });
      });

      if (cacheServed) return;

      if (responseData && responseData.status === 200 && (!ctx.isStreaming || responseData.isFakeStream || !responseData.isStream)) {
         if (!responseData.roundUsageCommitted) {
            const roundUsage = await resolveRoundUsage(
               ctx,
               responseData,
               responseData.roundRequestBody
            );
            commitRoundUsage(ctx, responseData, roundUsage, responseData.roundId || `continuity-${continuityCycles}`);
         }
         if (ctx.continuity.committedRoundIds.size > 1 || ctx.continuity.usageStatus !== "success") {
            updateResponseDataUsage(ctx, responseData);
         }
      }

      // FAKE STREAM RESTORATION for Sub-agent Delegation-bypassed requests
      // If the gateway forced isStreaming=false internally to intercept a tool call, but the model
      // didn't output a tool call, we must convert the JSON response back into a fake SSE stream
      // before sending it to the client, otherwise the client will hang waiting for a stream.
      restoreFakeStreamIfNeeded(ctx, responseData, currentAttempt);

      stopStreamPrelude();
      const isStitching = ctx.continuity.hasStartedContinuity === true;
      const respResult = await handleGatewayResponse(ctx, responseData, logAction, isStitching, anthropicState);
      lastStreamResultIsTruncated = respResult.isLengthTruncated || false;
      if (respResult.anthropicState) anthropicState = respResult.anthropicState;

      if (respResult.terminalError) {
        const streamTermErr = respResult.terminalError;
        const canRetry = !respResult.terminalEventSent && !respResult.meaningfulClientOutputSent;
        const isCapacityError = isOpenRouterCapacityError(streamTermErr);

        // --- Stream Terminal Error Decision Matrix ---
        // Priority 1: If meaningful client output was already sent, we cannot retry.
        if (!canRetry) {
          logAction({
            ...baseActionLog,
            level: "WARN",
            code: "request.provider_adapter.stream_error",
            providerName: ctx.activeProvider?.name,
            modelId: currentAttempt?.modelId,
            adapterId: streamTermErr.adapterId,
            statusCode: streamTermErr.statusCode,
            errorCode: streamTermErr.code,
            errorType: streamTermErr.errorType,
            retryClass: streamTermErr.retryClass,
            phase: "stream",
            meaningfulClientOutputSent: respResult.meaningfulClientOutputSent,
            fingerprint: streamTermErr.fingerprint,
            safeMetadata: streamTermErr.safeMetadata,
          });
          await finalizeGatewayTerminalFailure(ctx, responseData, respResult);
          return;
        }

        // Priority 2: OpenRouter Capacity retry (same key, fixed budget)
        if (isCapacityError && currentAttempt) {
           const capacityRetryState = getCapacityRetryState(currentAttempt.providerId, currentAttempt.modelId);
           // capacityRetryState.retryCount starts at 0. If max is 2, 0 and 1 are retried, 2 is exhausted.
           if (capacityRetryState.retryCount >= capacityRetryState.maxRetries) {
              capacityRetryState.exhausted = true;
           } else if (!capacityRetryState.exhausted) {
              capacityRetryState.retryCount++;
              // Check again after incrementing - if we just hit the max, mark exhausted for NEXT time (actually, we want to try this time, and THEN it will be exhausted next time if it fails again).
              if (capacityRetryState.retryCount >= capacityRetryState.maxRetries) {
                 capacityRetryState.exhausted = true;
              }
              
              capacityRetryState.activeKeyId = responseData?.activeKeyId || null;
              getTargetKeyState(currentAttempt.providerId, currentAttempt.modelId).preferredKeyId = responseData?.activeKeyId || null;
              
              logAction({
                ...baseActionLog,
                level: "WARN",
                code: "request.upstream_retry",
                providerName: ctx.activeProvider?.name,
                modelId: currentAttempt.modelId,
                statusCode: responseData?.status || 503,
                attempt: attemptCount,
                maxAttempts,
                reason: "provider_capacity",
                preserveAttemptCount: true,
              });
              
              keepContinuity = true;
              if (responseData?.releaseSlots) {
                 responseData.releaseSlots();
                 responseData.releaseSlots = undefined;
              }
              responseData = null;
              attemptCount--;
              continue; // retry same key
           }
        }

        // Priority 3: Key rotation for rate_limit / authentication / provider_unavailable
        // (Also handles capacity-exhausted fallthrough — try other keys first)
        const retryClass = streamTermErr.retryClass;
        const isKeyRotatable = retryClass === "rate_limit" || retryClass === "authentication" || retryClass === "provider_unavailable" || retryClass === "protocol_payload_incompatible";
        const capacityRetryState = currentAttempt ? getCapacityRetryState(currentAttempt.providerId, currentAttempt.modelId) : null;
        if ((isKeyRotatable || (isCapacityError && capacityRetryState?.exhausted)) && currentAttempt) {
          const targetState = getTargetKeyState(currentAttempt.providerId, currentAttempt.modelId);
          const activeKeyId = responseData?.activeKeyId;
          const activeKeysList = responseData?.availableKeys || [];

          if (activeKeyId) {
            targetState.triedKeyIds.add(activeKeyId);
          }
          targetState.preferredKeyId = null;

          if (retryClass === "authentication" && activeKeyId) {
            logAction({
              ...baseActionLog,
              level: "ERROR",
              code: "request.provider_key_rejected_for_target",
              providerName: ctx.activeProvider?.name,
              modelId: currentAttempt.modelId,
              errorCode: streamTermErr.code || "invalid_api_key",
              statusCode: streamTermErr.statusCode,
              keyIdSuffix: activeKeyId.slice(-6),
              targetScoped: true,
            });
          }

          const untriedKeys = activeKeysList.filter((k: any) => !targetState.triedKeyIds.has(k.id));
          if (untriedKeys.length > 0 && !isCapacityError && retryClass !== "protocol_payload_incompatible") { // capacity and payload errors do NOT rotate keys
            logAction({
              ...baseActionLog,
              level: "WARN",
              code: "request.upstream_retry",
              providerName: ctx.activeProvider?.name,
              modelId: currentAttempt.modelId,
              statusCode: streamTermErr.statusCode || 429,
              attempt: attemptCount,
              maxAttempts,
              reason: `stream_${retryClass}_key_rotation`,
              preserveAttemptCount: true,
            });

            keepContinuity = true;
            if (responseData?.releaseSlots) {
               responseData.releaseSlots();
               responseData.releaseSlots = undefined;
            }
            responseData = null;
            attemptCount--;
            continue; // retry with rotated key
          }

          // All keys tried (or capacity exhausted) — attempt Funnel Fallback
          const syntheticStatus = streamTermErr.statusCode || 502;
          const errorFallback = await checkErrorFallback({
            status: syntheticStatus,
            currentAttempt,
            route,
            body,
            provider: ctx.activeProvider,
            responseData: responseData || { status: syntheticStatus, data: { error: { message: streamTermErr.message, type: streamTermErr.errorType } }, isStream: true },
            baseActionLog,
            logAction,
            incomingProtocol,
          });
          if (errorFallback) {
            logAction({
              ...baseActionLog,
              level: "WARN",
              code: "request.upstream_retry",
              providerName: ctx.activeProvider?.name,
              modelId: currentAttempt.modelId,
              statusCode: syntheticStatus,
              reason: `stream_${retryClass}_funnel_fallback`,
            });
            currentAttempt = errorFallback.newAttempt;
            ctx.currentAttempt = currentAttempt;
            keepContinuity = true;
            if (responseData?.releaseSlots) {
               responseData.releaseSlots();
               responseData.releaseSlots = undefined;
            }
            responseData = null;
            attemptCount = reserveAttemptBudgetForLayerSwitch(attemptCount, maxAttempts);
            continue; // fallback to next target
          }
        }

        // Priority 4: No retry possible — finalize failure
        logAction({
          ...baseActionLog,
          level: "ERROR",
          code: "request.provider_adapter.stream_error",
          providerName: ctx.activeProvider?.name,
          modelId: currentAttempt?.modelId,
          adapterId: streamTermErr.adapterId,
          statusCode: streamTermErr.statusCode,
          errorCode: streamTermErr.code,
          errorType: streamTermErr.errorType,
          retryClass: streamTermErr.retryClass,
          phase: "stream",
          meaningfulClientOutputSent: false,
          fingerprint: streamTermErr.fingerprint,
          safeMetadata: streamTermErr.safeMetadata,
        });
        await finalizeGatewayTerminalFailure(ctx, responseData, respResult);
        return;
      }

      if (ctx.isStreaming && !responseData?.roundUsageCommitted && !respResult.terminalError) {
         const roundUsage = await resolveRoundUsage(
            ctx,
            responseData,
            responseData.roundRequestBody,
            ctx.continuity?.accumulatedCompletionText || "",
            ctx.stream?.accumulatedReasoningText || "",
            undefined
         );
         commitRoundUsage(ctx, responseData, roundUsage, responseData.roundId || `continuity-${continuityCycles}`);
      }

      // Stage 2: Streaming (and post-stream) continuity check
      const postDecision = await continuityEngine.evaluateAll({
         originalBody,
         responseData,
         requestClass: classifyGatewayRequestClass(originalBody).requestClass,
         streamResult: respResult,
         baseActionLog,
         currentAttempt,
         accumulatedCompletionText: ctx.continuity.accumulatedCompletionText || "",
         state: new Map()
      });

      let willContinue = false;

      if (postDecision.shouldIntervene) {
         if (continuityCycles >= MAX_CONTINUITY_CYCLES) {
            logAction?.({
               ...baseActionLog,
               level: "WARN",
               code: "request.continuity.exhausted",
               message: `Continuity loop exhausted at ${continuityCycles} cycles`,
            });
         } else {
            willContinue = true;
         }
      } else {
         if (postDecision.isExhausted) {
            logAction?.({
               ...baseActionLog,
               level: "WARN",
               code: "request.continuity.exhausted",
               message: `Continuity strategy ${postDecision.strategyName} exhausted retries`,
            });
         }
      }

      if (willContinue) {
         continuityCycles++;
         ctx.continuity.hasStartedContinuity = true;
         ctx.continuity.streamRoundCount = continuityCycles + 1;
         logAction({
            ...baseActionLog,
            level: "INFO",
            code: "request.continuity.round_truncated",
            strategy: postDecision.strategyName,
            attempt: continuityCycles,
         });
         body = postDecision.modifiedBody;
         ctx.body = body;
      } else {
         keepContinuity = false;
         if (ctx.isStreaming) {
            await finalizeGatewayStreamOnce(responseData, respResult, anthropicState);
         }
      }
    } catch (err: any) {

      stopStreamPrelude();
      keepContinuity = false;
      const gotFirstChunk = ctx.stream.gotFirstChunk;
      const isClientDisconnect = ctx.clientDisconnected || request.raw.destroyed || request.raw.closed || err.code === "ECONNRESET" || err.message?.includes("closed") || err.message?.includes("destroyed");

      if (isClientDisconnect) {
        const statusCode = gotFirstChunk ? (responseData?.status || 200) : 499;
        const disconnectMessage = gotFirstChunk ? null : "客户端在收到响应前断开了连接";
        const finalLogSummary = await finalizeStreamLog(ctx, statusCode, {
          usageStatus: gotFirstChunk ? undefined : "failed",
          errorMessage: disconnectMessage,
        });

        logAction({
          ...baseActionLog,
          level: "INFO",
          code: "request.completed",
          providerName: responseData?.provider?.name,
          modelId: currentAttempt.modelId,
          statusCode,
          promptTokens: finalLogSummary.promptTokens,
          completionTokens: finalLogSummary.completionTokens,
          totalTokens: finalLogSummary.totalTokens,
          latencyMs: Date.now() - startTime,
          queueMs: responseData?.queueMs || 0,
          fallback: currentAttempt.isFallback,
          fallbackText: currentAttempt.fallbackReason,
          message: gotFirstChunk ? "客户端提前关闭连接" : "客户端在收到响应前断开了连接",
        });

        if (!reply.raw.writableEnded && !reply.raw.destroyed) {
          try { reply.raw.end(); } catch {}
        }
        return;
      }

      const upstreamContext = err.upstreamContext || {};
      const runtimeErrorDetail = truncateErrorDetail(
        [
          upstreamContext.providerName ? `供应商=${upstreamContext.providerName}` : "",
          upstreamContext.providerProtocol ? `目标协议=${upstreamContext.providerProtocol}` : "",
          upstreamContext.modelId ? `模型=${upstreamContext.modelId}` : "",
          upstreamContext.upstreamUrl ? `上游URL=${upstreamContext.upstreamUrl}` : "",
          upstreamContext.timeoutMs !== undefined ? `超时配置=${upstreamContext.timeoutMs}ms` : "",
          describeFetchError(err),
        ].filter(Boolean).join(" "),
      );

      if (err.name === "AbortError") {
        const errLog = { status: 504, statusCode: 504, usageStatus: "failed", errorMessage: runtimeErrorDetail || "上游请求超时", latencyMs: Date.now() - startTime };
        updateRequestLog(reqLogId, errLog, { id: reqLogId, userId: authCtx.userId, ...errLog });
        logAction({ ...baseActionLog, level: "ERROR", code: "request.timeout", providerName: upstreamContext.providerName, modelId: upstreamContext.modelId, statusCode: 504, errorCode: "504", fallback: upstreamContext.fallback, fallbackText: upstreamContext.fallbackReason, message: runtimeErrorDetail || "上游请求超时", latencyMs: Date.now() - startTime });
        if (reply.raw.headersSent) {
          writeStreamErrorResponse(reply, incomingProtocol, 504, runtimeErrorDetail || "上游请求超时");
          return;
        }
        return reply.code(504).send(formatError(incomingProtocol, 504, runtimeErrorDetail || "上游请求超时"));
      }

      const errLog = { status: 500, statusCode: 500, usageStatus: "failed", errorMessage: runtimeErrorDetail || err.message, latencyMs: Date.now() - startTime };
      updateRequestLog(reqLogId, errLog, { id: reqLogId, userId: authCtx.userId, ...errLog });
      logAction({ ...baseActionLog, level: "ERROR", code: "request.error", providerName: upstreamContext.providerName, modelId: upstreamContext.modelId, statusCode: 500, errorCode: "500", fallback: upstreamContext.fallback, fallbackText: upstreamContext.fallbackReason, message: runtimeErrorDetail || err.message, latencyMs: Date.now() - startTime });
      if (reply.raw.headersSent) {
        writeStreamErrorResponse(reply, incomingProtocol, 500, runtimeErrorDetail || err.message);
        return;
      }
      return reply.code(500).send(formatError(incomingProtocol, 500, runtimeErrorDetail || err.message));
    } finally {
      if (!keepContinuity) {
        stopStreamPrelude();
      }
      request.raw.off("aborted", abortUpstream);
      request.raw.off("close", abortOnRequestClose);
      reply.raw.off("close", abortOnReplyClose);
      if (responseData?.releaseSlots) {
        responseData.releaseSlots();
        responseData.releaseSlots = undefined;
      }
    }
  } // end while

  if (ctx.isStreaming) {
    finalizeGatewayStreamEvents(null);
  }
}

export async function finalizeGatewayTerminalFailure(ctx: GatewayRequestContext, responseData: any, streamResult: any) {
  const { incomingProtocol } = ctx.routing;
  const reply = ctx.reply;
  const termErr = streamResult?.terminalError || responseData?.terminalError;
  const statusCode = termErr?.statusCode || responseData?.status || 502;
  const errorMessage = termErr?.message || "Unknown error";
  const canonicalErrorType = termErr?.errorType;
  const anthropicType = incomingProtocol === "anthropic" && canonicalErrorType
    ? mapErrorTypeToAnthropic(canonicalErrorType)
    : undefined;

  if (!reply.raw.headersSent) {
    if (ctx.isStreaming) {
      if (!streamResult?.terminalEventSent && !streamResult?.meaningfulClientOutputSent) {
        reply.code(statusCode).send(formatError(
          incomingProtocol,
          statusCode,
          errorMessage,
          termErr?.code,
          { type: anthropicType, canonicalErrorType }
        ));
      }
    } else {
      reply.code(statusCode).send(formatError(
        incomingProtocol,
        statusCode,
        errorMessage,
        termErr?.code,
        { type: anthropicType, canonicalErrorType }
      ));
    }
  } else if (ctx.isStreaming && !streamResult?.terminalEventSent && !streamResult?.meaningfulClientOutputSent) {
     writeStreamErrorResponse(reply, incomingProtocol, statusCode, errorMessage);
  } else {
     reply.raw.end();
  }

  if (ctx.isStreaming) {
     await finalizeStreamLog(ctx, statusCode, { usageStatus: "failed", errorCode: termErr?.code || "stream_terminal_error", errorMessage });
  } else {
     const finalLog = {
       ...(responseData?.baseLog || {}),
       id: ctx.reqLogId,
       userId: ctx.auth.userId,
       statusCode,
       inputTokens: 0,
       outputTokens: 0,
       totalTokens: 0,
       latencyMs: Date.now() - ctx.startTime,
       usageStatus: "failed",
       errorCode: termErr?.code || "terminal_error",
       errorMessage,
       routingTrace: ctx.routingTrace.length > 0 ? JSON.stringify(ctx.routingTrace) : null,
       alias: ctx.activeModelConfig?.alias,
     };
     if (ctx.isLogInserted) {
       await updateRequestLog(ctx.reqLogId, finalLog, finalLog);
     } else {
       publishRequestLogUpdate(finalLog);
     }
  }
}
