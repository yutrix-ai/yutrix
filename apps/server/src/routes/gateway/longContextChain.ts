/**
 * Long-context degrade chain.
 *
 * When a request does not fit (preemptive window check, or the upstream rejects it as
 * too long), it moves to the long_context rule of the current layer — with or without
 * images. If that target fails for any reason, the chain continues through the
 * long_context rules of later layers. Targets that were already tried, or whose
 * configured window is known to be too small, are skipped.
 */
import { db } from "../../db";
import { providerModels } from "../../db/schema";
import { and, eq } from "drizzle-orm";
import {
  getStrategyRuleForLayer,
  strategyRoutingEnabledForLayer,
  validateOneStrategyRule,
} from "../../services/strategyRouting";
import { fitsContextBudget, resolveModelContextWindow } from "./gatewayExecutorUtils";

export const LONG_CONTEXT_TASK_TYPE = "long_context";

export function modelKey(providerId: string | null | undefined, modelId: string | null | undefined): string {
  return `${providerId || ""}::${modelId || ""}`;
}

export type LongContextTarget = {
  index: number;
  providerId: string;
  modelId: string;
  providerProtocol: string;
  promptPolicyId?: string | null;
  contextLimit: number;
};

export type LongContextSkip = {
  index: number;
  providerId: string;
  modelId: string;
  reason: "already_tried" | "window_too_small" | "invalid_rule";
  detail?: string;
};

function parseTargets(route: any): any[] {
  if (!route?.targets) return [];
  try {
    const parsed = typeof route.targets === "string" ? JSON.parse(route.targets) : route.targets;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function findLongContextTarget(options: {
  route: any;
  startIndex: number;
  incomingProtocol: string;
  estimatedTokens: number;
  exclude: Set<string>;
  onSkip?: (skip: LongContextSkip) => void;
}): Promise<LongContextTarget | null> {
  const targets = parseTargets(options.route);
  const layerCount = Math.max(targets.length, 1);

  for (let i = Math.max(0, options.startIndex); i < layerCount; i++) {
    if (!strategyRoutingEnabledForLayer(options.route, i)) continue;
    const rawRule = getStrategyRuleForLayer(options.route, i, LONG_CONTEXT_TASK_TYPE);
    if (!rawRule) continue;

    const key = modelKey(rawRule.providerId, rawRule.modelId);
    if (options.exclude.has(key)) {
      options.onSkip?.({ index: i, providerId: rawRule.providerId, modelId: rawRule.modelId, reason: "already_tried" });
      continue;
    }

    const validation = await validateOneStrategyRule({ incomingProtocol: options.incomingProtocol, rule: rawRule });
    if (!validation.ok) {
      options.onSkip?.({
        index: i,
        providerId: rawRule.providerId,
        modelId: rawRule.modelId,
        reason: "invalid_rule",
        detail: validation.error,
      });
      continue;
    }
    const rule = validation.rule;

    const rows = await db
      .select()
      .from(providerModels)
      .where(and(eq(providerModels.providerId, rule.providerId), eq(providerModels.modelId, rule.modelId)))
      .limit(1);
    const budget = resolveModelContextWindow(rows[0] ?? null);
    if (
      budget.limit > 0
      && !fitsContextBudget({ inputTokens: options.estimatedTokens, requestedOutputTokens: 0, safetyMargin: 50, budget })
    ) {
      options.onSkip?.({
        index: i,
        providerId: rule.providerId,
        modelId: rule.modelId,
        reason: "window_too_small",
        detail: `input_${options.estimatedTokens}>${budget.limit}`,
      });
      continue;
    }

    return {
      index: i,
      providerId: rule.providerId,
      modelId: rule.modelId,
      providerProtocol: rule.providerProtocol || "openai",
      promptPolicyId: targets[i]?.promptPolicyId ?? null,
      contextLimit: budget.limit,
    };
  }
  return null;
}

/** First vision rule (from layer 0) not yet tried — the last resort once the long-context chain is exhausted. */
export function findVisionFallbackTarget(options: {
  route: any;
  exclude: Set<string>;
}): { index: number; providerId: string; modelId: string; providerProtocol: string; promptPolicyId?: string | null } | null {
  const targets = parseTargets(options.route);
  const layerCount = Math.max(targets.length, 1);
  for (let i = 0; i < layerCount; i++) {
    const rule = getStrategyRuleForLayer(options.route, i, "vision");
    if (!rule?.providerId || !rule?.modelId) continue;
    if (options.exclude.has(modelKey(rule.providerId, rule.modelId))) continue;
    return {
      index: i,
      providerId: rule.providerId,
      modelId: rule.modelId,
      providerProtocol: rule.providerProtocol || "openai",
      promptPolicyId: targets[i]?.promptPolicyId ?? null,
    };
  }
  return null;
}

const CONTEXT_OVERFLOW_PATTERNS: RegExp[] = [
  /maximum context length/,
  /context[_ -]?length[_ -]?exceeded/,
  /context[_ -]?window[_ -]?exceeded/,
  /exceeds? (?:the )?(?:model'?s? )?(?:maximum |max )?context (?:window|length|size)/,
  /(?:prompt|input) is too long/,
  /input token count.*exceeds/,
  /(?:prompt|input) (?:tokens? )?(?:length )?exceeds? (?:the )?(?:maximum|max|limit)/,
  /too many (?:input |prompt )?tokens(?! per)/,
  /reduce the length of (?:the|either|your)/,
];

const RATE_LIMIT_HINTS = /per minute|per day|rate.?limit|quota|tpm\b|rpm\b/;

function collectErrorText(responseData: any): string {
  const parts: string[] = [];
  if (typeof responseData?.errorDetail === "string") parts.push(responseData.errorDetail);
  if (typeof responseData?.terminalError?.message === "string") parts.push(responseData.terminalError.message);
  const data = responseData?.data;
  if (typeof data === "string") parts.push(data);
  else if (data) {
    try {
      parts.push(JSON.stringify(data));
    } catch {
      // ignore unserializable payloads
    }
  }
  return parts.join(" ").toLowerCase();
}

/** True when the upstream rejected the request because the prompt does not fit the model's context. */
export function isContextOverflowResponse(responseData: any): boolean {
  if (!responseData || responseData.isStream) return false;
  const status = Number(responseData.status);
  if (!Number.isFinite(status) || status < 400 || status >= 500 || status === 429) return false;
  if (status === 413) return true;
  const text = collectErrorText(responseData);
  if (!text) return false;
  if (RATE_LIMIT_HINTS.test(text)) return false;
  return CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(text));
}
