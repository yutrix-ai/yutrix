export type RouteProtocol = "openai" | "anthropic";

export interface ProviderProtocolCapability {
  hasOpenaiEndpoint?: boolean;
  hasAnthropicEndpoint?: boolean;
}

export interface ProviderModelLike {
  modelId: string;
  enabled?: boolean | null;
}

interface ResolveRouteProtocolInput {
  incomingProtocol: string;
  provider: ProviderProtocolCapability;
  models: ProviderModelLike[];
  modelId: string;
}

export function getAvailableModels(models: ProviderModelLike[]) {
  const uniqueModels = new Map<string, ProviderModelLike>();
  for (const model of models) {
    if (model.enabled === false || uniqueModels.has(model.modelId)) continue;
    uniqueModels.set(model.modelId, model);
  }

  return Array.from(uniqueModels.values());
}

export function getSelectableModels(input: {
  incomingProtocol: string;
  provider: ProviderProtocolCapability;
  models: ProviderModelLike[];
}) {
  const availableModels = getAvailableModels(input.models);

  if (input.incomingProtocol === "openai") {
    return input.provider.hasOpenaiEndpoint ? availableModels : [];
  }

  if (input.incomingProtocol === "anthropic") {
    if (
      input.provider.hasAnthropicEndpoint ||
      input.provider.hasOpenaiEndpoint
    ) {
      return availableModels;
    }
  }

  return [];
}

export function resolveRouteProviderProtocol(
  input: ResolveRouteProtocolInput,
):
  | { ok: true; providerProtocol: RouteProtocol }
  | { ok: false; error: string } {
  const availableModels = getAvailableModels(input.models);
  const hasSelectedModel = availableModels.some(
    (model) => model.modelId === input.modelId,
  );

  if (input.incomingProtocol === "openai") {
    if (!input.provider.hasOpenaiEndpoint) {
      return {
        ok: false,
        error: "该供应商没有配置 OpenAI 协议 URL，无法接收 OpenAI 路由。",
      };
    }
    if (availableModels.length === 0) {
      return { ok: false, error: "该供应商没有可用模型。" };
    }
    if (!hasSelectedModel) {
      return { ok: false, error: "目标模型不属于该供应商" };
    }
    return { ok: true, providerProtocol: "openai" };
  }

  if (input.incomingProtocol !== "anthropic") {
    return { ok: false, error: "路由协议必须为 openai 或 anthropic。" };
  }

  /**
   * 血泪教训 (CRITICAL LESSON):
   * 协议的选择必须由【路由和供应商配置的 Endpoint URL】决定，绝不能由【模型本身的协议】决定！
   * 架构核心理念：“路由决定模型”，而不是模型决定路由。
   *
   * 举例：当用户配置了 OneAPI/NewAPI 供应商，并填写了 Anthropic 格式的 URL (/v1/messages)，
   * 即使用户选择的是 Kimi、Qwen 等原生为 OpenAI 协议的模型，网关也必须绝对信任供应商的 Anthropic URL 配置，
   * 直接走 Anthropic -> Anthropic 原生透传直通车。
   *
   * 绝不能因为判断出 Kimi 是 OpenAI 模型，就强行把协议降级转化为 OpenAI！
   * 如果强行转化，会导致网关把 OpenAI 格式的 Payload 发给供应商的 Anthropic URL 接口，
   * 上游代理会直接崩溃，报出类似 "BalanceError" / "There are no suitable services" 的 500 错误。
   */
  if (input.provider.hasAnthropicEndpoint) {
    if (availableModels.length === 0) {
      return { ok: false, error: "该供应商没有可用模型。" };
    }
    if (!hasSelectedModel) {
      return { ok: false, error: "目标模型不属于该供应商" };
    }
    return { ok: true, providerProtocol: "anthropic" };
  }

  if (!input.provider.hasOpenaiEndpoint) {
    return {
      ok: false,
      error: "该供应商没有配置 Anthropic 协议 URL，也没有可用于协议适配的 OpenAI 协议 URL。",
    };
  }

  if (availableModels.length === 0) {
    return { ok: false, error: "该供应商没有可用模型。" };
  }
  if (!hasSelectedModel) {
    return { ok: false, error: "目标模型不属于该供应商" };
  }

  return { ok: true, providerProtocol: "openai" };

  return { ok: false, error: "未知目标模型协议" };
}
