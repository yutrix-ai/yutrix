/**
 * Client Override mode: match the client-passed model name against the route's
 * L0 configuration (strategy rules + L0 base model). On miss, fall back to
 * the General strategy rule (or L0 base if General is not configured).
 *
 * Mutually exclusive with a page-fixed modelId for the same user+route override.
 */
import {
  findStrategyRule,
  parseStrategyRoutingRules,
  type StrategyRoutingRule,
} from "./strategyRouting";
import type { RouteProtocol } from "../utils/routeProtocol";

export type UserRouteOverrideMode = "default" | "fixed" | "strategy" | "client";

export interface L0ModelTarget {
  providerId: string;
  providerProtocol: RouteProtocol;
  modelId: string;
  promptPolicyId?: string | null;
}

export interface ClientModelResolveResult extends L0ModelTarget {
  /** True when client model name matched an L0-configured model. */
  matched: boolean;
  source: "client_match" | "general" | "l0_base";
}

/**
 * Normalize user override payload so Client Override cannot co-exist with a
 * page-specified fixed modelId (or custom strategy rules).
 */
export function normalizeUserRouteOverridePayload(input: {
  useClientModel?: boolean | null;
  modelId?: string | null;
  strategyRoutingRules?: string | null;
}): {
  useClientModel: boolean;
  modelId: string | null;
  strategyRoutingRules: string | null;
  mode: UserRouteOverrideMode;
} {
  if (input.useClientModel) {
    return {
      useClientModel: true,
      modelId: null,
      strategyRoutingRules: null,
      mode: "client",
    };
  }

  const rules =
    typeof input.strategyRoutingRules === "string" &&
    input.strategyRoutingRules.trim()
      ? input.strategyRoutingRules
      : null;
  if (rules) {
    return {
      useClientModel: false,
      modelId: null,
      strategyRoutingRules: rules,
      mode: "strategy",
    };
  }

  const modelId =
    typeof input.modelId === "string" && input.modelId.trim()
      ? input.modelId.trim()
      : null;
  if (modelId) {
    return {
      useClientModel: false,
      modelId,
      strategyRoutingRules: null,
      mode: "fixed",
    };
  }

  return {
    useClientModel: false,
    modelId: null,
    strategyRoutingRules: null,
    mode: "default",
  };
}

/**
 * Extract L0 base target + strategy rules from a route (targets[0] preferred).
 */
export function extractL0Config(route: any): {
  base: L0ModelTarget;
  rules: StrategyRoutingRule[];
  strategyEnabled: boolean;
} {
  let base: L0ModelTarget = {
    providerId: route?.providerId || "",
    providerProtocol:
      route?.providerProtocol === "anthropic" ? "anthropic" : "openai",
    modelId: route?.modelId || "",
    promptPolicyId: route?.promptPolicyId || null,
  };
  let rules = parseStrategyRoutingRules(route?.strategyRoutingRules);
  let strategyEnabled = !!route?.strategyRoutingEnabled;

  if (route?.targets) {
    try {
      const parsed =
        typeof route.targets === "string"
          ? JSON.parse(route.targets)
          : route.targets;
      if (Array.isArray(parsed) && parsed.length > 0) {
        const t0 = parsed[0];
        base = {
          providerId: t0.providerId || base.providerId,
          providerProtocol:
            t0.providerProtocol === "anthropic" ? "anthropic" : "openai",
          modelId: t0.modelId || base.modelId,
          promptPolicyId:
            t0.promptPolicyId !== undefined
              ? t0.promptPolicyId
              : base.promptPolicyId,
        };
        if (t0.strategyRoutingEnabled !== undefined) {
          strategyEnabled = !!t0.strategyRoutingEnabled;
        }
        if (t0.strategyRoutingRules !== undefined) {
          rules = parseStrategyRoutingRules(t0.strategyRoutingRules);
        }
      }
    } catch {
      // keep route-level fallback
    }
  }

  return { base, rules, strategyEnabled };
}

/**
 * Match client-passed model name against L0-configured models.
 * Hit → that L0 model/provider. Miss → General rule, else L0 base.
 */
export function resolveClientModelAgainstL0(options: {
  clientModelId: string | null | undefined;
  route: any;
}): ClientModelResolveResult {
  const { base, rules } = extractL0Config(options.route);
  const clientModel =
    typeof options.clientModelId === "string"
      ? options.clientModelId.trim()
      : "";

  if (clientModel) {
    const hit = rules.find(
      (r) => r.enabled !== false && r.modelId === clientModel,
    );
    if (hit) {
      return {
        providerId: hit.providerId,
        providerProtocol: hit.providerProtocol,
        modelId: hit.modelId,
        promptPolicyId: base.promptPolicyId,
        matched: true,
        source: "client_match",
      };
    }
    if (base.modelId && base.modelId === clientModel) {
      return {
        ...base,
        matched: true,
        source: "client_match",
      };
    }
  }

  // Miss → General (explicit general rule only; do not use findStrategyRule's
  // task-type fallback which would mask a true miss).
  const general = rules.find(
    (r) => r.enabled !== false && r.taskType === "general",
  );
  if (general) {
    return {
      providerId: general.providerId,
      providerProtocol: general.providerProtocol,
      modelId: general.modelId,
      promptPolicyId: base.promptPolicyId,
      matched: false,
      source: "general",
    };
  }

  return {
    ...base,
    matched: false,
    source: "l0_base",
  };
}

/**
 * Apply Client Override onto attempt state and disable content-based strategy
 * for this request so the client-name match (or General) is final.
 */
export function applyClientModelOverrideToAttempt(options: {
  route: any;
  clientModelId: string | null | undefined;
  currentAttempt: {
    providerId: string;
    providerProtocol: string;
    modelId: string;
    promptPolicyId?: string | null;
  };
}): ClientModelResolveResult {
  const resolved = resolveClientModelAgainstL0({
    clientModelId: options.clientModelId,
    route: options.route,
  });

  options.currentAttempt.providerId = resolved.providerId;
  options.currentAttempt.providerProtocol = resolved.providerProtocol;
  options.currentAttempt.modelId = resolved.modelId;
  if (resolved.promptPolicyId !== undefined) {
    options.currentAttempt.promptPolicyId = resolved.promptPolicyId;
  }

  // Content-based strategy must not re-pick a model after client-name match.
  options.route.strategyRoutingEnabled = false;
  if (options.route.targets) {
    try {
      const parsed =
        typeof options.route.targets === "string"
          ? JSON.parse(options.route.targets)
          : options.route.targets;
      if (Array.isArray(parsed) && parsed[0] && typeof parsed[0] === "object") {
        parsed[0] = { ...parsed[0], strategyRoutingEnabled: false };
        options.route.targets =
          typeof options.route.targets === "string"
            ? JSON.stringify(parsed)
            : parsed;
      }
    } catch {
      // ignore
    }
  }

  return resolved;
}

// Re-export for callers that need rule helpers nearby
export { findStrategyRule, parseStrategyRoutingRules };
