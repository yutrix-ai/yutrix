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

export const OPC_AGENT_TASKS: RouteTaskDefinition[] = [
  {
    type: "vision",
    labelKey: "routes.opcAgent.tasks.vision",
    fallbackLabel: "视觉感知",
    descriptionKey: "routes.opcAgent.taskDescriptions.vision",
    fallbackDescription: "屏幕截图、图片输入或 UI 定位任务，需要多模态视觉模型。",
  },
  {
    type: "thinking",
    labelKey: "routes.opcAgent.tasks.thinking",
    fallbackLabel: "深度规划",
    descriptionKey: "routes.opcAgent.taskDescriptions.thinking",
    fallbackDescription: "新用户目标进入时的任务拆解与多步规划，适合深度推理模型。",
  },
  {
    type: "action",
    labelKey: "routes.opcAgent.tasks.action",
    fallbackLabel: "操作执行",
    descriptionKey: "routes.opcAgent.taskDescriptions.action",
    fallbackDescription: "工具调用循环中的键鼠、Shell、文件等操作，需要强工具调用模型。",
  },
  {
    type: "auto_review",
    labelKey: "routes.opcAgent.tasks.auto_review",
    fallbackLabel: "安全审评",
    descriptionKey: "routes.opcAgent.taskDescriptions.auto_review",
    fallbackDescription: "Agent 危险动作安全审计，要求低延迟轻量模型。",
  },
  {
    type: "memory",
    labelKey: "routes.opcAgent.tasks.memory",
    fallbackLabel: "记忆压缩",
    descriptionKey: "routes.opcAgent.taskDescriptions.memory",
    fallbackDescription: "会话历史压缩与记忆提炼；上下文超限时也会路由到此模型。",
  },
  {
    type: "general",
    labelKey: "routes.opcAgent.tasks.general",
    fallbackLabel: "通用兜底",
    descriptionKey: "routes.opcAgent.taskDescriptions.general",
    fallbackDescription: "普通对话轮次或未命中其他阶段时使用。",
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
    value: "strategy",
    labelKey: "routes.routingMode.strategy",
    fallbackLabel: "策略路由",
    descriptionKey: "routes.routingMode.strategyDescription",
    fallbackDescription: "面向 IDE / 编码助手等客户端，按内容意图分类（代码、报错、写作等）。",
  },
  {
    value: "opc_agent",
    labelKey: "routes.routingMode.opcAgent",
    fallbackLabel: "OPC 智能体路由",
    descriptionKey: "routes.routingMode.opcAgentDescription",
    fallbackDescription: "面向 Rakazo 等自主智能体，按执行阶段分类（视觉、规划、操作、审评、记忆）。",
  },
];

export function tasksForRoutingMode(mode: string | undefined): RouteTaskDefinition[] {
  return mode === "opc_agent" ? OPC_AGENT_TASKS : STRATEGY_TASKS;
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
