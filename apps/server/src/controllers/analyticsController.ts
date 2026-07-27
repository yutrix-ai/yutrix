import { FastifyRequest, FastifyReply } from "fastify";
import { getQueryDateRange } from "../utils/timeRange";
import {
  getOverallStats,
  getUsageByUser,
  getUsageByProvider,
  getUsageByProviderKey,
  getUsageByModel,
  getUsageByEndpoint,
  getUsageBySubdomain,
  getUsageByApiKey,
  getTimeSeries,
  getDetailedAnalytics,
} from "../services/analyticsService";

export async function getStatsHandler(request: FastifyRequest, reply: FastifyReply) {
  const { startDate, endDate } = await getQueryDateRange(request.query as Record<string, string>, "30");
  const stats = await getOverallStats(startDate, endDate || undefined);
  return stats;
}

export async function getByUserHandler(request: FastifyRequest, reply: FastifyReply) {
  const { startDate, endDate } = await getQueryDateRange(request.query as Record<string, string>, "30");
  const stats = await getUsageByUser(startDate, endDate || undefined);
  return stats;
}

export async function getByProviderHandler(request: FastifyRequest, reply: FastifyReply) {
  const { startDate, endDate } = await getQueryDateRange(request.query as Record<string, string>, "30");
  const stats = await getUsageByProvider(startDate, endDate || undefined);
  return stats;
}

export async function getByProviderKeyHandler(request: FastifyRequest, reply: FastifyReply) {
  const { startDate, endDate } = await getQueryDateRange(request.query as Record<string, string>, "30");
  const stats = await getUsageByProviderKey(startDate, endDate || undefined);
  return stats;
}

export async function getByModelHandler(request: FastifyRequest, reply: FastifyReply) {
  const { startDate, endDate } = await getQueryDateRange(request.query as Record<string, string>, "30");
  const stats = await getUsageByModel(startDate, endDate || undefined);
  return stats;
}

export async function getByEndpointHandler(request: FastifyRequest, reply: FastifyReply) {
  const { startDate, endDate } = await getQueryDateRange(request.query as Record<string, string>, "30");
  const stats = await getUsageByEndpoint(startDate, endDate || undefined);
  return stats;
}

export async function getBySubdomainHandler(request: FastifyRequest, reply: FastifyReply) {
  const { startDate, endDate } = await getQueryDateRange(request.query as Record<string, string>, "30");
  const stats = await getUsageBySubdomain(startDate, endDate || undefined);
  return stats;
}

export async function getByApiKeyHandler(request: FastifyRequest, reply: FastifyReply) {
  const { startDate, endDate } = await getQueryDateRange(request.query as Record<string, string>, "30");
  const stats = await getUsageByApiKey(startDate, endDate || undefined);
  return stats;
}

export async function getTimeSeriesHandler(request: FastifyRequest, reply: FastifyReply) {
  const { startDate, endDate } = await getQueryDateRange(request.query as Record<string, string>, "30");
  const stats = await getTimeSeries(startDate, endDate || undefined);
  return stats;
}

export async function getDetailHandler(request: FastifyRequest, reply: FastifyReply) {
  const { type, value } = request.query as { type: string; value: string };
  if (!type) {
    return reply.status(400).send({ error: "Missing type parameter" });
  }

  const { startDate, endDate } = await getQueryDateRange(request.query as Record<string, string>, "30");
  const timeRange = (request.query as any).timeRange || "30";

  try {
    const result = await getDetailedAnalytics(type, value, startDate, endDate || undefined, timeRange);
    return result;
  } catch (error: any) {
    return reply.status(400).send({ error: error.message || "Invalid request" });
  }
}
