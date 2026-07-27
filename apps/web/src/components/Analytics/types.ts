export interface Stats {
  totalRequests: number;
  totalTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost?: number;
  avgLatencyMs: number;
  successRate: number;
}

export interface BreakdownItem {
  [key: string]: any;
  totalRequests: number;
  totalTokens: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalCost?: number;
  avgLatencyMs: number;
  successRate: number;
}

export type DetailType = "user" | "provider" | "model" | "endpoint" | "subdomain";
