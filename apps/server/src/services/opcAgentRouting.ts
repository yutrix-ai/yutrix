/**
 * Route funnel routing modes.
 * - "classic": one model per layer; no intent matrix (default for new routes).
 * - "strategy": IDE/developer traffic with per-task columns.
 *
 * Legacy DB values `opc_agent` are normalized to `classic` (向下兼容).
 */
export const ROUTING_MODES = ["classic", "strategy"] as const;
export type RoutingMode = (typeof ROUTING_MODES)[number];

export const DEFAULT_ROUTING_MODE: RoutingMode = "classic";

export const CLASSIC_TARGET_WEIGHT_OPTIONS = [
  0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100,
] as const;

export function defaultClassicTargetWeight(index = 0): number {
  return index === 0 ? 100 : 0;
}

export function normalizeClassicTargetWeight(value: unknown, index = 0): number {
  if (value === undefined || value === null || value === "") {
    return defaultClassicTargetWeight(index);
  }
  const num = typeof value === "number" ? value : Number(value);
  if (Number.isInteger(num) && num >= 0 && num <= 100 && num % 10 === 0) {
    return num;
  }
  return defaultClassicTargetWeight(index);
}

/**
 * Select the initial funnel layer index for a classic route using per-layer
 * percentage ratios (10% increments).
 * - Layer i with weight >= 100 takes all remaining traffic (so L1=100% takes
 *   100% of requests unless degraded).
 * - Layer i with weight <= 0 takes 0% initial traffic (fallback only, unless
 *   it is the final layer catching unallocated traffic).
 * - Otherwise layer i takes traffic with probability weight / 100, and misses
 *   flow down to the next layer, with the final layer acting as catch-all.
 */
export function selectClassicInitialTargetIndex(
  targets: any[],
  random: () => number = Math.random,
): number {
  if (!Array.isArray(targets) || targets.length <= 1) {
    return 0;
  }
  const lastIndex = targets.length - 1;
  for (let i = 0; i < lastIndex; i++) {
    const weight = normalizeClassicTargetWeight(targets[i]?.weight, i);
    if (weight >= 100) {
      return i;
    }
    if (weight <= 0) {
      continue;
    }
    if (random() * 100 < weight) {
      return i;
    }
  }
  return lastIndex;
}

const LEGACY_OPC_MODE = "opc_agent";

export function isRoutingMode(value: unknown): value is RoutingMode {
  return typeof value === "string" && (ROUTING_MODES as readonly string[]).includes(value);
}

export function isClassicRoutingMode(route: any): boolean {
  return resolveRouteRoutingMode(route) === "classic";
}

/** Classic routes send all traffic to the layer model — no pre-flight capability routing. */
export function shouldBypassCapabilityRouting(route: any): boolean {
  return isClassicRoutingMode(route);
}

export function isLegacyOpcRoutingMode(value: unknown): boolean {
  return value === LEGACY_OPC_MODE;
}

/** Read stored mode; legacy opc_agent → classic. */
export function resolveRouteRoutingMode(route: any): RoutingMode {
  const raw = route?.routingMode;
  if (raw === LEGACY_OPC_MODE) return "classic";
  return isRoutingMode(raw) ? raw : "strategy";
}

/** Normalize client/API input; opc_agent → classic. */
export function normalizeRoutingModeInput(
  value: unknown,
  fallback: RoutingMode = DEFAULT_ROUTING_MODE,
): RoutingMode {
  if (value === LEGACY_OPC_MODE) return "classic";
  return isRoutingMode(value) ? value : fallback;
}

/** Pick a single model from a legacy matrix / OPC layer target. */
export function seedModelFromLegacyTarget(target: any): {
  providerId: string;
  providerProtocol: string;
  modelId: string;
} {
  const rules = Array.isArray(target?.strategyRoutingRules)
    ? target.strategyRoutingRules
    : [];
  const byType = new Map(rules.map((r: any) => [r.taskType, r]));
  const seeded =
    byType.get("general") ||
    rules.find((r: any) => r?.providerId && r?.modelId) ||
    null;
  return {
    providerId: seeded?.providerId || target?.providerId || "",
    providerProtocol: seeded?.providerProtocol || target?.providerProtocol || "openai",
    modelId: seeded?.modelId || target?.modelId || "",
  };
}

/** Collapse a legacy OPC/strategy-matrix layer to classic single-model shape. */
export function coerceClassicTargetFromLegacy(target: any, index = 0) {
  const seed = seedModelFromLegacyTarget(target);
  return {
    ...target,
    ...seed,
    weight: normalizeClassicTargetWeight(target?.weight, index),
    strategyRoutingEnabled: false,
    strategyRoutingRules: [],
  };
}

/** API read helper: expose legacy opc routes as classic with collapsed targets. */
export function coerceLegacyRouteForDisplay(route: any) {
  const routingMode = resolveRouteRoutingMode(route);
  if (!isLegacyOpcRoutingMode(route?.routingMode)) {
    return { ...route, routingMode };
  }
  let targets = route.targets;
  try {
    const parsed =
      typeof targets === "string" ? JSON.parse(targets) : targets;
    if (Array.isArray(parsed)) {
      targets = parsed.map(coerceClassicTargetFromLegacy);
    }
  } catch {
    // keep original targets
  }
  return {
    ...route,
    routingMode: "classic" as RoutingMode,
    targets,
  };
}

/** Resolve layer target for gateway/runtime (classic collapses legacy matrix). */
export function resolveEffectiveLayerTarget(route: any, target: any) {
  if (!isClassicRoutingMode(route)) return target;
  return coerceClassicTargetFromLegacy(target);
}

/**
 * Capacity column for strategy-mode overflow hops.
 * Classic mode skips strategy routing entirely.
 */
export function capacityTaskTypeForMode(_mode: RoutingMode): "long_context" {
  return "long_context";
}

/**
 * Layer-aware strategy enablement. Funnel routes store the flag on each
 * target layer; the legacy top-level column is only a fallback for
 * pre-funnel rows (the CRUD path no longer writes it).
 */
export function strategyRoutingEnabledForLayer(route: any, targetIndex: number): boolean {
  if (isClassicRoutingMode(route)) {
    return false;
  }
  if (route?.targets) {
    try {
      const parsed =
        typeof route.targets === "string" ? JSON.parse(route.targets) : route.targets;
      if (Array.isArray(parsed) && parsed.length > targetIndex) {
        return !!parsed[targetIndex]?.strategyRoutingEnabled;
      }
    } catch {
      // fall through to the top-level flag
    }
  }
  return !!route?.strategyRoutingEnabled;
}
