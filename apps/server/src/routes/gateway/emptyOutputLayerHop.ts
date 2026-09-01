/**
 * EmptyOutput exhaust: availability hop to the next capable funnel layer.
 * Window size is ignored here — capacity (long_context) runs after landing.
 *
 * Mid-session agent loops must not thrash models on empty output: once the
 * conversation already has tool activity (or the turn is a tool_continuation),
 * same-layer EmptyOutput retries still run, but L0→L1 funnel hops are suppressed.
 * Cold first turns keep the availability hop.
 */

import { classifyGatewayRequestClass } from "../../services/requestRoutingClass";
import { getStrategyRuleForLayer } from "../../services/strategyRouting";
import { getMessagesFromParsedRequest } from "../../utils/chatTurnsFormatter";
import { estimateMultimodalInputUsage } from "./inputTokenLimit";
import {
  selectAvailabilityNextLayer,
  type FunnelLayerCandidate,
} from "./degradePolicy";

/** True when the conversation already entered an agent tool loop. */
export function conversationHasPriorToolActivity(body: any): boolean {
  const messages = getMessagesFromParsedRequest(body);
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    if (msg.role === "tool" || msg.role === "function") return true;
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) return true;
    if (msg.function_call) return true;
    const content = msg.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const type = block.type;
      if (
        type === "tool_use" ||
        type === "tool_result" ||
        type === "function_call" ||
        type === "function_response"
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Suppress EmptyOutput funnel-layer hops mid agent session.
 * Cold user_intent with no tool history still hops for availability.
 */
export function shouldSuppressEmptyOutputLayerHop(body: any): boolean {
  if (!body) return false;
  if (classifyGatewayRequestClass(body).requestClass === "tool_continuation") {
    return true;
  }
  return conversationHasPriorToolActivity(body);
}

export type EmptyOutputHopLayer = FunnelLayerCandidate & {
  visionRule?: FunnelLayerCandidate["vision"];
  strategyTaskType?: string;
  windowLimit?: number;
};

export type EmptyOutputLayerHop = {
  index: number;
  providerId: string;
  modelId: string;
  providerProtocol: string;
  strategyTaskType?: string;
  capability?: "vision" | "text";
};

export function snapshotUncutInboundBody(body: any): any {
  return JSON.parse(JSON.stringify(body ?? {}));
}

/** Deep clone that hop/restore always read. Never assign this object to `body`. */
export function freezeUncutInboundBody(body: any): any {
  const snap = snapshotUncutInboundBody(body);
  if (Array.isArray(snap.messages)) {
    for (const message of snap.messages) {
      if (message && typeof message === "object") Object.freeze(message);
    }
    Object.freeze(snap.messages);
  }
  return Object.freeze(snap);
}

/**
 * Next capable funnel layer for a zero-output / availability degrade.
 * Window size is ignored. Images stay on vision targets.
 */
export function selectEmptyOutputLayerHop(input: {
  currentIndex: number;
  hasImages: boolean;
  estimatedTokens?: number;
  safetyMargin?: number;
  layers: EmptyOutputHopLayer[];
  longContextCandidates?: unknown;
  currentProviderId?: string;
  currentModelId?: string;
}): EmptyOutputLayerHop | null {
  const hop = selectAvailabilityNextLayer({
    currentIndex: input.currentIndex,
    hasImages: input.hasImages,
    layers: input.layers
      .filter((layer) => layer.strategyTaskType !== "long_context")
      .map((layer) => {
        const rawVision = layer.vision || layer.visionRule || null;
        const vision = rawVision && (rawVision as { taskType?: string }).taskType === "long_context"
          ? null
          : rawVision;
        return {
          index: layer.index,
          providerId: layer.providerId,
          modelId: layer.modelId,
          providerProtocol: layer.providerProtocol,
          vision,
        };
      }),
  });
  if (!hop) return null;
  return {
    index: hop.index,
    providerId: hop.providerId,
    modelId: hop.modelId,
    providerProtocol: hop.providerProtocol,
    strategyTaskType: hop.capability === "vision" ? "vision" : undefined,
    capability: hop.capability,
  };
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
  currentProviderId?: string;
  currentModelId?: string;
}): Promise<EmptyOutputLayerHop | null> {
  const parsed = parseFunnelLayersFromRoute(options.route);
  if (parsed.length === 0) return null;

  const tokenEst = await estimateMultimodalInputUsage({ body: options.body });
  const layers: EmptyOutputHopLayer[] = [];

  for (const layer of parsed) {
    const visionRuleRaw = getStrategyRuleForLayer(options.route, layer.index, "vision");
    const vision = visionRuleRaw && visionRuleRaw.taskType !== "long_context"
      ? {
          providerId: visionRuleRaw.providerId,
          modelId: visionRuleRaw.modelId,
          providerProtocol: visionRuleRaw.providerProtocol || layer.providerProtocol,
        }
      : null;

    layers.push({
      index: layer.index,
      providerId: layer.providerId,
      modelId: layer.modelId,
      providerProtocol: layer.providerProtocol,
      vision,
      visionRule: vision,
    });
  }

  return selectEmptyOutputLayerHop({
    currentIndex: options.currentIndex,
    hasImages: tokenEst.imageCount > 0,
    layers,
  });
}
