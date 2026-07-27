import { sql } from "drizzle-orm";
import { providerModels, requestLogs } from "../db/schema";

const computedRequestCost = sql<number>`(
  COALESCE(${requestLogs.inputTokens}, 0) * COALESCE(${providerModels.inputTokenPricePerM}, 0) / 1000000.0 +
  COALESCE(${requestLogs.outputTokens}, 0) * COALESCE(${providerModels.outputTokenPricePerM}, 0) / 1000000.0
)`;

export const requestCostSql = sql<number>`COALESCE(${requestLogs.cost}, ${computedRequestCost}, 0)`;

export const summedRequestCostSql = sql<number>`COALESCE(SUM(${requestCostSql}), 0)`;
