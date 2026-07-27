export interface Provider {
  id: string;
  name: string;
  openaiBaseUrl?: string;
  anthropicBaseUrl?: string;
}

export interface ProviderModel {
  id?: string;
  providerId?: string;
  modelId: string;
  displayName?: string;
  enabled?: boolean;
  active?: boolean;
}

export interface Policy {
  id: string;
  name: string;
  protocol: string;
  enabled: boolean;
}

export interface RouteItem {
  id: string;
  name: string;
  enabled: boolean;
  host: string;
  path: string;
  incomingProtocol: string;
  providerId: string;
  providerName: string;
  providerProtocol: string;
  modelId: string;
  modelName: string;
  promptPolicyId: string | null;
  promptPolicyName: string;
  timeoutMs: number;
  retryCount: number;
  queueTimeoutMs: number;
  maxBodyMb: number;
  fallbackEnabled: boolean;
  fallbackProviderId: string | null;
  fallbackProviderProtocol: string | null;
  fallbackModelId: string | null;
  fallbackPromptPolicyId: string | null;
  fallbackMatchTarget: boolean;
  targets?: any;
  fallbackStrategyRoutingEnabled?: boolean;
  fallbackStrategyRoutingRules?: StrategyRoutingRule[];
  strategyRoutingEnabled?: boolean;
  strategyRoutingRules?: StrategyRoutingRule[];
  readiness: "ready" | "incomplete" | "disabled" | "error";
  errorMessage?: string;
  allowClientModel?: boolean;
  authorizedUserIds?: string[];
  authorizedGroupIds?: string[];
  schedules?: any[];
  isScheduleActive?: boolean;
  activeSchedule?: any;
}

export type StrategyTaskType = "vision" | "debug" | "code" | "long_context" | "writing" | "general";

export interface StrategyRoutingRule {
  taskType: StrategyTaskType;
  providerId: string;
  providerProtocol: string;
  modelId: string;
  enabled: boolean;
}
