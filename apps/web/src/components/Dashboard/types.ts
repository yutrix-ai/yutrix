export interface UserUsageStats {
  totalRequests: number;
  totalTokens: number;
  totalPromptTokens?: number;
  totalCompletionTokens?: number;
  totalCost?: number;
  successRate: number;
  errorCount: number;
  lastRequestAt: string | null;
}

export interface DashboardStats {
  todayRequests: number;
  todayTokens: number;
  todayInputTokens: number;
  todayOutputTokens: number;
  todayCost: number;
  successRate: number;
  avgLatencyMs: number;
  activeApiKeys: number;
  enabledProviders: number;
  totalSubdomains: number;
  totalEndpoints: number;
  tpm: number;
}

export interface TokenSeriesPoint {
  hour: string;
  label: string;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  requests: number;
  cost?: number;
}

export interface UserTokenRank {
  userId: string;
  username: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  totalRequests: number;
  totalCost?: number;
}

export interface DashboardCharts {
  tokenSeries: TokenSeriesPoint[];
  userRanking: UserTokenRank[];
}

export interface ModelBreakdownItem {
  model: string;
  totalRequests: number;
  totalTokens: number;
  totalCost: number;
}

export interface UserDashboardExtra {
  avgLatencyMs: number;
  modelBreakdown: ModelBreakdownItem[];
}
