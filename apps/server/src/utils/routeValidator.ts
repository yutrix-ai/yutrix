import { db } from "../db";
import { providers, providerModels, promptPolicies } from "../db/schema";
import { eq } from "drizzle-orm";
import { resolveRouteProviderProtocol, RouteProtocol } from "./routeProtocol";

export interface RouteTarget {
  providerId: string;
  modelId?: string;
  bestEffort: boolean;
  promptPolicyId?: string | null;
  strategyRoutingEnabled?: boolean;
  strategyRoutingRules?: any[];
}

export interface ValidateRouteConfigInput {
  incomingProtocol: string;
  enabled: boolean;
  targets: RouteTarget[];
  retryCount: number;
}

export interface ValidateRouteConfigResult {
  ok: boolean;
  error?: string;
  resolvedTargets?: (RouteTarget & { providerProtocol: RouteProtocol })[];
}

export async function validateRouteConfig(
  input: ValidateRouteConfigInput
): Promise<ValidateRouteConfigResult> {
  const { incomingProtocol, targets, retryCount } = input;

  if (retryCount !== undefined) {
    if (!Number.isInteger(retryCount) || retryCount < 0 || retryCount > 10) {
      return { ok: false, error: "Invalid retry count. Must be an integer between 0 and 10." };
    }
  }

  if (!targets || targets.length === 0) {
    return { ok: false, error: "至少需要配置一个路由目标" };
  }

  const resolvedTargets: (RouteTarget & { providerProtocol: RouteProtocol })[] = [];

  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];

    if (!target.providerId) {
      return { ok: false, error: `目标 ${i + 1} 未选择供应商` };
    }
    if (!target.strategyRoutingEnabled && !target.modelId) {
      return { ok: false, error: `目标 ${i + 1} 未选择模型` };
    }

    const providerList = await db.select().from(providers).where(eq(providers.id, target.providerId));
    if (providerList.length === 0) {
      return { ok: false, error: `目标 ${i + 1} 供应商不存在或已停用` };
    }
    if (!providerList[0].enabled) {
      return { ok: false, error: `目标 ${i + 1} 供应商已停用` };
    }

    const providerModelList = await db
      .select()
      .from(providerModels)
      .where(eq(providerModels.providerId, target.providerId));

    // Check protocol
    const providerProtocolResult = resolveRouteProviderProtocol({
      incomingProtocol,
      provider: {
        hasOpenaiEndpoint: !!providerList[0].openaiBaseUrl,
        hasAnthropicEndpoint: !!providerList[0].anthropicBaseUrl,
      },
      models: providerModelList,
      modelId: target.modelId || "",
    });

    if (!providerProtocolResult.ok) {
      return { ok: false, error: `目标 ${i + 1} ${providerProtocolResult.error}` };
    }

    if (target.promptPolicyId && target.promptPolicyId !== "none") {
      const policyList = await db.select().from(promptPolicies).where(eq(promptPolicies.id, target.promptPolicyId));
      if (policyList.length === 0) {
        return { ok: false, error: `目标 ${i + 1} 的提示词策略不存在` };
      }
      if (!policyList[0].enabled) {
        return { ok: false, error: `目标 ${i + 1} 的提示词策略已被停用` };
      }
      if (
        policyList[0].protocol !== providerProtocolResult.providerProtocol &&
        policyList[0].protocol !== incomingProtocol
      ) {
        return { ok: false, error: `目标 ${i + 1} 提示词策略协议不匹配` };
      }
    }

    resolvedTargets.push({
      ...target,
      providerProtocol: providerProtocolResult.providerProtocol,
    });
  }

  return { ok: true, resolvedTargets };
}
