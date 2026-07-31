import { Provider, ProviderModel, StrategyRoutingRule, StrategyTaskType } from "./types";

export const STRATEGY_TASKS: Array<{
  type: StrategyTaskType;
  labelKey: string;
  fallbackLabel: string;
  descriptionKey: string;
  fallbackDescription: string;
}> = [
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
    fallbackDescription: "仅当预估输入超过 100 万 tokens 时才会路由到此模型。",
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
}): StrategyRoutingRule[] {
  if (!options.providerId || !options.modelId) return [];
  return STRATEGY_TASKS.map((task) => ({
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
}): StrategyRoutingRule[] {
  const byType = new Map((options.rules || []).map((rule) => [rule.taskType, rule]));
  const defaults = createDefaultStrategyRules(options);
  return STRATEGY_TASKS.map((task, index) => {
    const existing = byType.get(task.type);
    if (existing?.providerId && existing?.modelId) {
      return { ...existing, enabled: existing.enabled !== false };
    }
    return defaults[index];
  }).filter(Boolean);
}
