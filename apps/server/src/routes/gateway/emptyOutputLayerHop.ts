/**
 * EmptyOutput exhaust: one hop to a later funnel layer.
 * Not same-layer strategy reroute, not long_context.
 */

import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { providerModels } from "../../db/schema";
import { getStrategyRuleForLayer } from "../../services/strategyRouting";
import { estimateMultimodalInputUsage } from "./inputTokenLimit";
import { resolveModelContextWindow } from "./gatewayExecutorUtils";

export type EmptyOutputHopLayer = {
  index: number;
  providerId: string;
  modelId: string;
  providerProtocol: string;
  visionRule?: {
    providerId: string;
    modelId: string;
    providerProtocol: string;
    taskType?: string;
  } | null;
  /** When set to long_context, this entry is a strategy target and is skipped. */
  strategyTaskType?: string;
  windowLimit?: number;
};

export type EmptyOutputLayerHop = {
  index: number;
  providerId: string;
  modelId: string;
  providerProtocol: string;
};

export function snapshotUncutInboundBody(body: any): any {
  return JSON.parse(JSON.stringify(body ?? {}));
}

function windowHolds(windowLimit: number | undefined, estimatedTokens: number, safetyMargin: number): boolean {
  if (windowLimit === undefined || windowLimit === null || windowLimit <= 0) return true;
  return estimatedTokens + safetyMargin <= windowLimit;
}

function isLongContextTask(taskType?: string): boolean {
  return taskType === "long_context";
}

/**
 * Pick the first later funnel layer that can take an EmptyOutput degrade.
 * Never returns the current layer. Never returns a long_context strategy target.
 */
export function selectEmptyOutputLayerHop(input: {
  currentIndex: number;
  hasImages: boolean;
  estimatedTokens: number;
  safetyMargin?: number;
  layers: EmptyOutputHopLayer[];
}): EmptyOutputLayerHop | null {
  const safetyMargin = input.safetyMargin ?? 50;
  const estimatedTokens = Number(input.estimatedTokens) || 0;
  const currentIndex = Number(input.currentIndex) || 0;

  const later = [...input.layers]
    .filter((layer) => layer.index > currentIndex)
    .sort((a, b) => a.index - b.index);

  for (const layer of later) {
    if (input.hasImages) {
      const vision = layer.visionRule;
      if (!vision || !vision.providerId || !vision.modelId) continue;
      if (isLongContextTask(vision.taskType)) continue;
      if (!windowHolds(layer.windowLimit, estimatedTokens, safetyMargin)) continue;
      return {
        index: layer.index,
        providerId: vision.providerId,
        modelId: vision.modelId,
        providerProtocol: vision.providerProtocol || layer.providerProtocol || "openai",
      };
    }

    if (!layer.providerId || !layer.modelId) continue;
    if (isLongContextTask(layer.strategyTaskType)) continue;
    if (!windowHolds(layer.windowLimit, estimatedTokens, safetyMargin)) continue;
    return {
      index: layer.index,
      providerId: layer.providerId,
      modelId: layer.modelId,
      providerProtocol: layer.providerProtocol || "openai",
    };
  }

  return null;
}

export function parseFunnelLayersFromRoute(route: any): Array<{
  index: number;
  providerId: string;
  modelId: string;
  providerProtocol: string;
  strategyRoutingRules?: unknown;
}> {
  if (!route) return [];
  if (route.targets) {
    try {
      const parsed = typeof route.targets === "string" ? JSON.parse(route.targets) : route.targets;
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.map((target: any, index: number) => ({
          index,
          providerId: target.providerId || "",
          modelId: target.modelId || "",
          providerProtocol: target.providerProtocol || "openai",
          strategyRoutingRules: target.strategyRoutingRules,
        }));
      }
    } catch {
      return [];
    }
  }
  const layers = [
    {
      index: 0,
      providerId: route.providerId || "",
      modelId: route.modelId || "",
      providerProtocol: route.providerProtocol || "openai",
      strategyRoutingRules: route.strategyRoutingRules,
    },
  ];
  if (route.fallbackEnabled && route.fallbackProviderId && route.fallbackModelId) {
    layers.push({
      index: 1,
      providerId: route.fallbackProviderId,
      modelId: route.fallbackModelId,
      providerProtocol: route.fallbackProviderProtocol || "openai",
      strategyRoutingRules: route.fallbackStrategyRoutingRules,
    });
  }
  return layers;
}

export async function resolveEmptyOutputLayerHopFromRoute(options: {
  route: any;
  currentIndex: number;
  body: any;
}): Promise<EmptyOutputLayerHop | null> {
  const parsed = parseFunnelLayersFromRoute(options.route);
  if (parsed.length === 0) return null;

  const tokenEst = await estimateMultimodalInputUsage({ body: options.body });
  const layers: EmptyOutputHopLayer[] = [];

  for (const layer of parsed) {
    const visionRuleRaw = getStrategyRuleForLayer(options.route, layer.index, "vision");
    const visionRule = visionRuleRaw && visionRuleRaw.taskType !== "long_context"
      ? {
          providerId: visionRuleRaw.providerId,
          modelId: visionRuleRaw.modelId,
          providerProtocol: visionRuleRaw.providerProtocol || layer.providerProtocol,
          taskType: visionRuleRaw.taskType,
        }
      : null;

    const hopModelId = tokenEst.imageCount > 0 && visionRule
      ? visionRule.modelId
      : layer.modelId;
    const hopProviderId = tokenEst.imageCount > 0 && visionRule
      ? visionRule.providerId
      : layer.providerId;

    let windowLimit = 0;
    if (hopProviderId && hopModelId) {
      const rows = await db
        .select()
        .from(providerModels)
        .where(and(
          eq(providerModels.providerId, hopProviderId),
          eq(providerModels.modelId, hopModelId),
        ))
        .limit(1);
      windowLimit = resolveModelContextWindow(rows[0] || null).limit;
    }

    layers.push({
      index: layer.index,
      providerId: layer.providerId,
      modelId: layer.modelId,
      providerProtocol: layer.providerProtocol,
      visionRule,
      windowLimit,
    });
  }

  return selectEmptyOutputLayerHop({
    currentIndex: options.currentIndex,
    hasImages: tokenEst.imageCount > 0,
    estimatedTokens: tokenEst.totalTokens,
    layers,
  });
}
