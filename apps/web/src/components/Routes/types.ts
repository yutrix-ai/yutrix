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
  timeoutEjectEnabled?: boolean;
  timeoutEjectObserving?: boolean;
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
  routingMode?: RoutingMode;
  fallbackStrategyRoutingEnabled?: boolean;
  fallbackStrategyRoutingRules?: StrategyRoutingRule[];
  strategyRoutingEnabled?: boolean;
  strategyRoutingRules?: StrategyRoutingRule[];
  readiness: "ready" | "incomplete" | "disabled" | "error";
  errorMessage?: string;
  allowClientModel?: boolean;
  ipWhitelist?: string;
  authorizedUserIds?: string[];
  authorizedGroupIds?: string[];
  schedules?: any[];
  isScheduleActive?: boolean;
  activeSchedule?: any;
}

export type RoutingMode = "strategy" | "opc_agent";

export type StrategyTaskType = "vision" | "debug" | "code" | "long_context" | "writing" | "general";

export type OpcAgentTaskType = "vision" | "thinking" | "action" | "auto_review" | "memory" | "general";

export type RouteTaskType = StrategyTaskType | OpcAgentTaskType;

export interface StrategyRoutingRule {
  taskType: RouteTaskType;
  providerId: string;
  providerProtocol: string;
  modelId: string;
  enabled: boolean;
}
