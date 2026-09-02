import { Provider, ProviderModel, RouteTaskType, RoutingMode, StrategyRoutingRule } from "./types";

export interface RouteTaskDefinition {
  type: RouteTaskType;
  labelKey: string;
  fallbackLabel: string;
  descriptionKey: string;
  fallbackDescription: string;
}

export const STRATEGY_TASKS: RouteTaskDefinition[] = [
  {
    type: "vision",
    labelKey: "routes.strategy.tasks.vision",
    fallbackLabel: "图片 / 视觉",
    descriptionKey: "routes.strategy.taskDescriptions.vision",
    fallbackDescription: "当前输入包含图片或截图时优先匹配。",
  },
  {
    type: "debug",
    labelKey: "routes.strategy.tasks.debug",
    fallbackLabel: "报错排查",
    descriptionKey: "routes.strategy.taskDescriptions.debug",
    fallbackDescription: "包含异常、超时、失败、堆栈或修复意图。",
  },
  {
    type: "code",
    labelKey: "routes.strategy.tasks.code",
    fallbackLabel: "代码任务",
    descriptionKey: "routes.strategy.taskDescriptions.code",
    fallbackDescription: "代码生成、重构、接口、组件或编译相关。",
  },
  {
    type: "long_context",
    labelKey: "routes.strategy.tasks.long_context",
    fallbackLabel: "长上下文",
    descriptionKey: "routes.strategy.taskDescriptions.long_context",
    fallbackDescription: "当前模型上下文装不下时，会路由到此模型。",
  },
  {
    type: "writing",
    labelKey: "routes.strategy.tasks.writing",
    fallbackLabel: "写作润色",
    descriptionKey: "routes.strategy.taskDescriptions.writing",
    fallbackDescription: "文章、文案、邮件、翻译或润色。",
  },
  {
    type: "general",
    labelKey: "routes.strategy.tasks.general",
    fallbackLabel: "通用兜底",
    descriptionKey: "routes.strategy.taskDescriptions.general",
    fallbackDescription: "未命中其他任务类型时使用。",
  },
];

export const ROUTING_MODES: Array<{
  value: RoutingMode;
  labelKey: string;
  fallbackLabel: string;
  descriptionKey: string;
  fallbackDescription: string;
}> = [
  {
    value: "classic",
    labelKey: "routes.routingMode.classic",
    fallbackLabel: "经典路由",
    descriptionKey: "routes.routingMode.classicDescription",
    fallbackDescription: "每层只选一个模型，按 L1→L2→L3 漏斗降级，适合大多数简单场景。",
  },
  {
    value: "strategy",
    labelKey: "routes.routingMode.strategy",
    fallbackLabel: "策略路由",
    descriptionKey: "routes.routingMode.strategyDescription",
    fallbackDescription: "面向 IDE / 编码助手等客户端，按内容意图分类（代码、报错、写作等）。",
  },
];

export function normalizeRoutingModeForForm(mode: string | undefined): RoutingMode {
  if (mode === "opc_agent" || mode === "classic") return "classic";
  if (mode === "strategy") return "strategy";
  return "classic";
}

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

export function coerceClassicTargetFromLegacy(target: any) {
  const seed = seedModelFromLegacyTarget(target);
  return {
    ...target,
    ...seed,
    strategyRoutingEnabled: false,
    strategyRoutingRules: [],
  };
}

export function coerceTargetsForRoutingMode(
  targets: any[],
  mode: string | undefined,
): any[] {
  const normalizedMode = normalizeRoutingModeForForm(mode);
  if (normalizedMode !== "classic") return targets;
  return targets.map(coerceClassicTargetFromLegacy);
}

export function isClassicRoutingMode(mode: string | undefined): boolean {
  return normalizeRoutingModeForForm(mode) === "classic";
}

export function tasksForRoutingMode(mode: string | undefined): RouteTaskDefinition[] {
  if (isClassicRoutingMode(mode)) return [];
  return STRATEGY_TASKS;
}

export function selectableModelsForProvider(models: ProviderModel[], providerId: string) {
  return models.filter((model) =>
    model.providerId === providerId &&
    model.enabled !== false &&
    model.active !== false
  );
}

export function firstModelForProvider(models: ProviderModel[], providerId: string) {
  return selectableModelsForProvider(models, providerId)[0] || null;
}

export function providerProtocolForRule(
  incomingProtocol: string,
  provider: Provider | undefined,
) {
  if (incomingProtocol === "anthropic") {
    return provider?.anthropicBaseUrl ? "anthropic" : "openai";
  }
  return "openai";
}

export function createDefaultStrategyRules(options: {
  providerId: string;
  providerProtocol: string;
  modelId: string;
  routingMode?: RoutingMode;
}): StrategyRoutingRule[] {
  if (!options.providerId || !options.modelId) return [];
  return tasksForRoutingMode(options.routingMode).map((task) => ({
    taskType: task.type,
    providerId: options.providerId,
    providerProtocol: options.providerProtocol || "openai",
    modelId: options.modelId,
    enabled: true,
  }));
}

export function completeStrategyRules(options: {
  rules: StrategyRoutingRule[] | undefined;
  providerId: string;
  providerProtocol: string;
  modelId: string;
  routingMode?: RoutingMode;
}): StrategyRoutingRule[] {
  const byType = new Map((options.rules || []).map((rule) => [rule.taskType, rule]));
  const defaults = createDefaultStrategyRules(options);
  return tasksForRoutingMode(options.routingMode).map((task, index) => {
    const existing = byType.get(task.type);
    if (existing?.providerId && existing?.modelId) {
      return { ...existing, enabled: existing.enabled !== false };
    }
    return defaults[index];
  }).filter(Boolean);
}
