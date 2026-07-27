import { GatewayRequestContext, RoundUsage, RoundUsageStatus, UpstreamResponseData } from "./types";
import { normalizeUsagePayload, extractPromptText, detectProviderUsagePresence, extractCompletionMaterialForTokenEstimate } from "../../utils/gatewayContent";
import { exactEstimateTokens, estimateTokensFallback } from "../../utils/tokenizer";
import { estimateMultimodalInputUsage } from "./inputTokenLimit";

export async function resolveRoundUsage(
  ctx: GatewayRequestContext,
  responseData: UpstreamResponseData,
  roundRequestBody: any,
  streamedText = "",
  streamedReasoning = "",
  streamedToolCalls: any[] = []
): Promise<RoundUsage> {
  const presence = responseData.rawProviderUsage || detectProviderUsagePresence(responseData.data);
  const normalized = normalizeUsagePayload(responseData.data);

  let providerInput: number | undefined = undefined;
  let providerOutput: number | undefined = undefined;
  let cacheRead = 0;
  let cacheWrite = 0;

  if (presence.inputProvided && normalized) {
    providerInput = normalized.inputTokens;
  }
  if (presence.outputProvided && normalized) {
    providerOutput = normalized.outputTokens;
  }
  if (presence.cacheReadProvided && normalized) {
    cacheRead = normalized.cacheReadTokens;
  }
  if (presence.cacheWriteProvided && normalized) {
    cacheWrite = normalized.cacheWriteTokens;
  }

  if (responseData.roundStreamUsage) {
    const streamNorm = normalizeUsagePayload(responseData.roundStreamUsage);
    if (streamNorm) {
      if (streamNorm.inputTokens !== undefined) providerInput = streamNorm.inputTokens;
      if (streamNorm.outputTokens !== undefined) providerOutput = streamNorm.outputTokens;
      if (streamNorm.cacheReadTokens !== undefined) cacheRead = streamNorm.cacheReadTokens;
      if (streamNorm.cacheWriteTokens !== undefined) cacheWrite = streamNorm.cacheWriteTokens;
    }
  }

  let inputSource: "provider" | "estimated" | "missing" = providerInput !== undefined ? "provider" : "estimated";
  let outputSource: "provider" | "estimated" | "missing" = providerOutput !== undefined ? "provider" : "estimated";

  let inputTokens = providerInput ?? 0;
  if (providerInput === undefined) {
    const est = await estimateMultimodalInputUsage({
      body: roundRequestBody,
      modelId: ctx.currentAttempt.modelId,
      tokenizerRepo: ctx.activeModelConfig?.tokenizerRepo || undefined,
      weightProxyUrl: ctx.activeProvider?.weightProxyUrl || undefined
    });
    inputTokens = est.totalTokens;
    inputSource = est.totalTokens > 0 ? "estimated" : "missing";
  }

  let outputTokens = providerOutput ?? 0;
  if (providerOutput === undefined) {
    let completionText = "";
    if (responseData.roundOutputSnapshot) {
      const snap = responseData.roundOutputSnapshot;
      completionText = snap.completionMaterial || [snap.completionText, snap.reasoningText, snap.toolCallSerialization].filter(Boolean).join("\n");
    } else {
      completionText = extractCompletionMaterialForTokenEstimate(
        responseData.data,
        streamedText,
        streamedReasoning,
        streamedToolCalls
      );
    }
    const estOutput = await exactEstimateTokens(
      completionText,
      ctx.currentAttempt.modelId,
      ctx.activeProvider?.weightProxyUrl,
      ctx.activeModelConfig?.tokenizerRepo
    ).catch(() => estimateTokensFallback(completionText));
    outputTokens = estOutput;
    outputSource = estOutput > 0 ? "estimated" : "missing";
  }

  let usageStatus: RoundUsageStatus = "success";
  if (inputSource === "missing" || outputSource === "missing") {
    usageStatus = "missing";
  } else if (inputSource === "estimated" || outputSource === "estimated") {
    usageStatus = "estimated";
  }

  const roundUsage = {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    usageStatus,
    inputSource,
    outputSource
  };
  return roundUsage;
}

export function commitRoundUsage(
  ctx: GatewayRequestContext,
  responseData: UpstreamResponseData,
  roundUsage: RoundUsage,
  roundId: string
) {
  if (!ctx.continuity.committedRoundIds) {
    ctx.continuity.committedRoundIds = new Set<string>();
  }
  if (ctx.continuity.committedRoundIds.has(roundId)) {
    return;
  }
  ctx.continuity.committedRoundIds.add(roundId);

  ctx.continuity.promptTokens += roundUsage.inputTokens;
  ctx.continuity.completionTokens += roundUsage.outputTokens;
  ctx.continuity.cacheReadTokens += roundUsage.cacheReadTokens;
  ctx.continuity.cacheWriteTokens += roundUsage.cacheWriteTokens;

  const currentStatus = ctx.continuity.usageStatus || "success";
  const newStatus = responseData.status >= 400 || responseData.terminalError ? "failed" : roundUsage.usageStatus;
  ctx.continuity.usageStatus = aggregateStatus(currentStatus, newStatus);

  responseData.roundUsage = roundUsage;
  responseData.roundUsageCommitted = true;
}

function aggregateStatus(s1: string, s2: string): any {
  const rank: Record<string, number> = {
    failed: 4,
    missing: 3,
    estimated: 2,
    success: 1,
  };
  return rank[s1] >= rank[s2] ? s1 : s2;
}

export function updateResponseDataUsage(
  ctx: GatewayRequestContext,
  responseData: UpstreamResponseData
) {
  const data = responseData.data;
  if (!data || typeof data !== "object") return;
  const protocol = responseData.responseProtocol || "openai";
  const totals = {
    promptTokens: ctx.continuity.promptTokens,
    completionTokens: ctx.continuity.completionTokens,
    cacheReadTokens: ctx.continuity.cacheReadTokens,
    cacheWriteTokens: ctx.continuity.cacheWriteTokens
  };

  if (!data.usage) {
    data.usage = {};
  }

  if (protocol === "anthropic" || data.type === "message") {
    data.usage.input_tokens = totals.promptTokens;
    data.usage.output_tokens = totals.completionTokens;

    delete data.usage.prompt_tokens;
    delete data.usage.completion_tokens;
    delete data.usage.total_tokens;

    if (totals.cacheReadTokens !== undefined && totals.cacheReadTokens > 0) {
      data.usage.cache_read_input_tokens = totals.cacheReadTokens;
    } else {
      delete data.usage.cache_read_input_tokens;
    }
    if (totals.cacheWriteTokens !== undefined && totals.cacheWriteTokens > 0) {
      data.usage.cache_creation_input_tokens = totals.cacheWriteTokens;
    } else {
      delete data.usage.cache_creation_input_tokens;
    }
  } else {
    data.usage.prompt_tokens = totals.promptTokens;
    data.usage.completion_tokens = totals.completionTokens;
    data.usage.total_tokens = totals.promptTokens + totals.completionTokens;

    delete data.usage.input_tokens;
    delete data.usage.output_tokens;
    delete data.usage.cache_read_input_tokens;
    delete data.usage.cache_creation_input_tokens;

    if (totals.cacheReadTokens !== undefined && totals.cacheReadTokens > 0) {
      if (!data.usage.prompt_tokens_details) {
        data.usage.prompt_tokens_details = {};
      }
      data.usage.prompt_tokens_details.cached_tokens = totals.cacheReadTokens;
    } else {
      delete data.usage.prompt_tokens_details;
    }
  }
}
