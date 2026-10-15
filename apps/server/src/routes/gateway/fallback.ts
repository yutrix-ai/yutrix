import { db } from "../../db";
import { providerModels, providers } from "../../db/schema";
import { eq, and } from "drizzle-orm";
import { getStatusReasonCN } from "../../utils/gatewayError";
import { resolveFallbackStrategyRoutingDecision, getDeclaredVisionModels, getStrategyRuleForLayer } from "../../services/strategyRouting";
import { estimateMultimodalInputUsage } from "./inputTokenLimit";
import { resolveModelContextWindow, fitsContextBudget } from "./gatewayExecutorUtils";
import type { AttemptState, BaseActionLog } from "./types";
import type { AsyncQueue } from "../../utils/asyncQueue";
import { hasImageInput } from "../../utils/multimodal";
import {
  coerceClassicTargetFromLegacy,
  isClassicRoutingMode,
} from "../../services/opcAgentRouting";
import {
  LONG_CONTEXT_TASK_TYPE,
  findLongContextTarget,
  findVisionFallbackTarget,
  modelKey,
} from "./longContextChain";

export interface FallbackResult {
  newAttempt: AttemptState;
}

async function resolveFallbackTarget(
  route: any,
  currentAttemptProviderId: string,
  currentAttemptModelId: string,
  currentAttemptStrategyTaskType: string | undefined,
  body: any,
  incomingProtocol: string,
  targetIndex: number,
  logAction?: (log: any) => void,
  baseActionLog?: BaseActionLog,
  failedModelKeys?: Set<string>
): Promise<{ providerId: string; modelId: string; protocol: string; promptPolicyId?: string | null; strategyTaskType?: string; strategyReason?: string; targetIndex: number } | null> {
  if (currentAttemptStrategyTaskType === LONG_CONTEXT_TASK_TYPE && !isClassicRoutingMode(route)) {
    const chainTarget = await resolveLongContextChainTarget({
      route,
      currentAttemptProviderId,
      currentAttemptModelId,
      body,
      incomingProtocol,
      targetIndex,
      logAction,
      baseActionLog,
      failedModelKeys,
    });
    if (chainTarget) return chainTarget;
  }

  let parsedTargets: any[] = [];
  if (route.targets) {
    try {
      parsedTargets = typeof route.targets === 'string' ? JSON.parse(route.targets) : route.targets;
    } catch (e) {}
  } else {
    if (!route.fallbackEnabled) return null;
    parsedTargets = [
      { providerId: route.providerId, modelId: route.modelId, promptPolicyId: route.promptPolicyId },
      {
        providerId: route.fallbackProviderId,
        modelId: route.fallbackModelId,
        providerProtocol: route.fallbackProviderProtocol,
        promptPolicyId: route.fallbackPromptPolicyId,
        bestEffort: route.fallbackMatchTarget,
        strategyRoutingEnabled: route.fallbackStrategyRoutingEnabled,
        strategyRoutingRules: route.fallbackStrategyRoutingRules
      }
    ];
  }

  const tokenEst = await estimateMultimodalInputUsage({ body });
  const isVision = tokenEst.imageCount > 0;

  for (let i = targetIndex + 1; i < parsedTargets.length; i++) {
    const target = isClassicRoutingMode(route)
      ? coerceClassicTargetFromLegacy(parsedTargets[i])
      : parsedTargets[i];
    let targetFallbackModelId = target.modelId;
    let targetFallbackProtocol = target.providerProtocol || "openai";
    let targetFallbackProviderId = target.providerId;
    let targetPromptPolicyId = target.promptPolicyId;
    let strategyTaskType: string | undefined;
    let strategyReason: string | undefined;

    if (isVision && !isClassicRoutingMode(route)) {
      const visionRule = getStrategyRuleForLayer(route, i, "vision");
      if (!visionRule) {
        if (logAction && baseActionLog) {
          logAction({
            ...baseActionLog,
            level: "WARN",
            code: "request.fallback_target_skipped",
            providerId: targetFallbackProviderId,
            modelId: targetFallbackModelId || "",
            reason: "layer_missing_vision_rule",
          });
        }
        continue;
      }
      targetFallbackModelId = visionRule.modelId;
      targetFallbackProtocol = visionRule.providerProtocol;
      targetFallbackProviderId = visionRule.providerId;
      strategyTaskType = "vision";
      strategyReason = "fallback_vision_rule";
    } else {
      const strategyDecision = await resolveFallbackStrategyRoutingDecision({
        route: { ...route, fallbackStrategyRoutingEnabled: target.strategyRoutingEnabled, fallbackStrategyRoutingRules: target.strategyRoutingRules },
        body,
        currentFallbackModelId: targetFallbackModelId,
        incomingProtocol,
        currentStrategyTaskType: currentAttemptStrategyTaskType,
        failedProviderId: currentAttemptProviderId,
        failedModelId: currentAttemptModelId,
      });

      if (strategyDecision?.applied && strategyDecision.rule) {
        targetFallbackModelId = strategyDecision.rule.modelId;
        targetFallbackProtocol = strategyDecision.rule.providerProtocol;
        targetFallbackProviderId = strategyDecision.rule.providerId;
        strategyTaskType = strategyDecision.taskType;
        strategyReason = strategyDecision.reasons?.join("; ");
      }

      let isBestEffortMatched = false;
      if ((route.fallbackMatchTarget || target.bestEffort) && currentAttemptModelId) {
        const matchedModels = await db
          .select()
          .from(providerModels)
          .where(
            and(
              eq(providerModels.providerId, targetFallbackProviderId),
              eq(providerModels.modelId, currentAttemptModelId),
            ),
          );
        if (matchedModels.length > 0) {
          targetFallbackModelId = currentAttemptModelId;
          strategyTaskType = undefined;
          strategyReason = "尽力而为 (Best Effort) 匹配同名模型";
          isBestEffortMatched = true;
        }
      }
    }

    if (targetFallbackProviderId && targetFallbackModelId) {
      const candidateModelRows = await db
        .select()
        .from(providerModels)
        .where(
          and(
            eq(providerModels.providerId, targetFallbackProviderId),
            eq(providerModels.modelId, targetFallbackModelId),
          ),
        )
        .limit(1);

      const candidateModelConfig = candidateModelRows.length > 0 ? candidateModelRows[0] : null;
      if (candidateModelConfig) {
        const candidateBudget = resolveModelContextWindow(candidateModelConfig);
        const isSufficient = fitsContextBudget({
          inputTokens: tokenEst.totalTokens,
          requestedOutputTokens: 0,
          safetyMargin: 50,
          budget: candidateBudget,
        });

        if (!isSufficient && logAction && baseActionLog) {
          logAction({
            ...baseActionLog,
            level: "INFO",
            code: "request.fallback_target_capacity_deferred",
            providerId: targetFallbackProviderId,
            modelId: targetFallbackModelId || "",
            reason: `availability_hop_despite_small_window:input_${tokenEst.totalTokens}>${candidateBudget.limit}`,
          });
        }
      }
    }

    return {
      providerId: targetFallbackProviderId,
      modelId: targetFallbackModelId || "",
      protocol: targetFallbackProtocol,
      promptPolicyId: targetPromptPolicyId,
      strategyTaskType,
      strategyReason,
      targetIndex: i
    };
  }

  return null;
}

/**
 * Next hop while already on the long-context chain: the next later-layer long_context
 * target; once exhausted, image requests go back to a vision model (clipped to its window
 * by the post-hop guard) and text requests fall through to the regular layer fallback.
 */
async function resolveLongContextChainTarget(options: {
  route: any;
  currentAttemptProviderId: string;
  currentAttemptModelId: string;
  body: any;
  incomingProtocol: string;
  targetIndex: number;
  logAction?: (log: any) => void;
  baseActionLog?: BaseActionLog;
  failedModelKeys?: Set<string>;
}): Promise<{ providerId: string; modelId: string; protocol: string; promptPolicyId?: string | null; strategyTaskType?: string; strategyReason?: string; targetIndex: number } | null> {
  const exclude = new Set(options.failedModelKeys ?? []);
  exclude.add(modelKey(options.currentAttemptProviderId, options.currentAttemptModelId));
  const tokenEst = await estimateMultimodalInputUsage({ body: options.body });

  const next = await findLongContextTarget({
    route: options.route,
    startIndex: options.targetIndex + 1,
    incomingProtocol: options.incomingProtocol,
    estimatedTokens: tokenEst.totalTokens,
    exclude,
    onSkip: (skip) => {
      if (!options.logAction || !options.baseActionLog) return;
      options.logAction({
        ...options.baseActionLog,
        level: "INFO",
        code: "request.fallback_target_skipped",
        providerId: skip.providerId,
        modelId: skip.modelId,
        reason: `long_context_chain_${skip.reason}${skip.detail ? `:${skip.detail}` : ""}`,
      });
    },
  });
  if (next) {
    return {
      providerId: next.providerId,
      modelId: next.modelId,
      protocol: next.providerProtocol,
      promptPolicyId: next.promptPolicyId,
      strategyTaskType: LONG_CONTEXT_TASK_TYPE,
      strategyReason: "long_context_chain_fallback",
      targetIndex: next.index,
    };
  }

  if (tokenEst.imageCount > 0) {
    const vision = findVisionFallbackTarget({ route: options.route, exclude });
    if (vision) {
      return {
        providerId: vision.providerId,
        modelId: vision.modelId,
        protocol: vision.providerProtocol,
        promptPolicyId: vision.promptPolicyId,
        strategyTaskType: "vision",
        strategyReason: "long_context_chain_exhausted_vision_clip",
        targetIndex: vision.index,
      };
    }
  }
  return null;
}

export async function checkConcurrencyFallback(
  currentAttempt: AttemptState,
  route: any,
  body: any,
  provQueue: AsyncQueue,
  provider: any,
  baseActionLog: BaseActionLog,
  logAction: (log: any) => void,
  incomingProtocol: string
): Promise<FallbackResult | null> {
  const nextTarget = await resolveFallbackTarget(
    route,
    currentAttempt.providerId,
    currentAttempt.modelId,
    currentAttempt.strategyTaskType,
    body,
    incomingProtocol,
    currentAttempt.targetIndex || 0,
    logAction,
    baseActionLog
  );
  if (!nextTarget) return null;

  if (provQueue.active + provQueue.pending >= provQueue.concurrency) {
    const { providerId, modelId, protocol, promptPolicyId, strategyTaskType, strategyReason } = nextTarget;

    const fallbackProviderRecord = await db.select({ name: providers.name }).from(providers).where(eq(providers.id, providerId)).limit(1);
    const fallbackProviderName = fallbackProviderRecord.length > 0 ? fallbackProviderRecord[0].name : providerId;

    logAction({
      ...baseActionLog,
      level: "警告",
      action: "路由并发降级",
      providerName: provider.name,
      modelId: currentAttempt.modelId,
      fallbackReason: `供应商 [${provider.name}] 队列已满，切换至 [${fallbackProviderName}] 的 [${modelId}]`,
    });

    return {
      newAttempt: {
        providerId,
        providerProtocol: protocol,
        modelId,
        promptPolicyId: promptPolicyId || null,
        isFallback: true,
        fallbackReason: `并发过载降级${strategyReason ? ` (${strategyReason})` : ""}`,
        targetIndex: nextTarget.targetIndex,
        strategyTaskType,
        strategyReason,
      },
    };
  }

  return null;
}

export interface CheckErrorFallbackOptions {
  status: number;
  currentAttempt: AttemptState;
  route: any;
  body: any;
  provider: any;
  responseData: any;
  baseActionLog: BaseActionLog;
  logAction: (log: any) => void;
  incomingProtocol: string;
  forceCapabilityFallback?: boolean;
  /** Models already failed in this request; the current attempt is added before resolving. */
  failedModelKeys?: Set<string>;
}

/** Funnel hops on any unsuccessful upstream status; only HTTP 200 is a terminal success. */
export function isErrorFallbackStatus(status: unknown): boolean {
  const n = typeof status === "number" ? status : Number(status);
  if (!Number.isFinite(n)) return true;
  return n !== 200;
}

export async function checkErrorFallback(
  options: CheckErrorFallbackOptions
): Promise<FallbackResult | null> {
  const {
    status,
    currentAttempt,
    route,
    body,
    provider,
    responseData,
    baseActionLog,
    logAction,
    incomingProtocol,
    forceCapabilityFallback,
    failedModelKeys
  } = options;

  const isVisionCapabilityError = responseData?.terminalError?.requiredCapability === "vision" || forceCapabilityFallback;
  const isPayloadIncompatible = responseData?.terminalError?.retryClass === "protocol_payload_incompatible";
  
  if (!isVisionCapabilityError && !isPayloadIncompatible && !isErrorFallbackStatus(status)) {
    return null;
  }

  failedModelKeys?.add(modelKey(currentAttempt.providerId, currentAttempt.modelId));
  const nextTarget = await resolveFallbackTarget(
    route,
    currentAttempt.providerId,
    currentAttempt.modelId,
    currentAttempt.strategyTaskType,
    body,
    incomingProtocol,
    currentAttempt.targetIndex || 0,
    logAction,
    baseActionLog,
    failedModelKeys
  );
  if (!nextTarget) return null;

  const { providerId, modelId, protocol, promptPolicyId, strategyTaskType, strategyReason } = nextTarget;

  let reasonText = "";
  if (status) {
    reasonText = getStatusReasonCN(status);
  } else {
    reasonText = "未知连接错误";
  }

  const currentProviderRecord = await db.select({ name: providers.name }).from(providers).where(eq(providers.id, currentAttempt.providerId)).limit(1);
  const fallbackProviderRecord = await db.select({ name: providers.name }).from(providers).where(eq(providers.id, providerId)).limit(1);
  const currentProviderName = currentProviderRecord.length > 0 ? currentProviderRecord[0].name : currentAttempt.providerId;
  const fallbackProviderName = fallbackProviderRecord.length > 0 ? fallbackProviderRecord[0].name : providerId;

  logAction({
    ...baseActionLog,
    level: "警告",
    action: "路由错误降级",
    providerName: currentProviderName,
    modelId: currentAttempt.modelId,
    fallbackReason: `供应商 [${currentProviderName}] 发生错误 (${reasonText})，切换至 [${fallbackProviderName}] 的 [${modelId}]`,
  });

  return {
    newAttempt: {
      providerId,
      providerProtocol: protocol,
      modelId,
      promptPolicyId: promptPolicyId || null,
      isFallback: true,
      fallbackReason: `${reasonText} 触发降级${strategyReason ? ` (${strategyReason})` : ""}`,
      targetIndex: nextTarget.targetIndex,
      strategyTaskType,
      strategyReason,
    },
  };
}
