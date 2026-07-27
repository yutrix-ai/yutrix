import { FastifyInstance } from "fastify";
import { requireAdmin } from "../middleware/auth";
import {
  getStatsHandler,
  getByUserHandler,
  getByProviderHandler,
  getByProviderKeyHandler,
  getByModelHandler,
  getByEndpointHandler,
  getBySubdomainHandler,
  getByApiKeyHandler,
  getTimeSeriesHandler,
  getDetailHandler,
} from "../controllers/analyticsController";

export default async function (fastify: FastifyInstance) {
  fastify.get("/api/admin/analytics/stats", { onRequest: [requireAdmin] }, getStatsHandler);
  fastify.get("/api/admin/analytics/by-user", { onRequest: [requireAdmin] }, getByUserHandler);
  fastify.get("/api/admin/analytics/by-provider", { onRequest: [requireAdmin] }, getByProviderHandler);
  fastify.get("/api/admin/analytics/by-provider-key", { onRequest: [requireAdmin] }, getByProviderKeyHandler);
  fastify.get("/api/admin/analytics/by-model", { onRequest: [requireAdmin] }, getByModelHandler);
  fastify.get("/api/admin/analytics/by-endpoint", { onRequest: [requireAdmin] }, getByEndpointHandler);
  fastify.get("/api/admin/analytics/by-subdomain", { onRequest: [requireAdmin] }, getBySubdomainHandler);
  fastify.get("/api/admin/analytics/by-api-key", { onRequest: [requireAdmin] }, getByApiKeyHandler);
  fastify.get("/api/admin/analytics/time-series", { onRequest: [requireAdmin] }, getTimeSeriesHandler);
  fastify.get("/api/admin/analytics/detail", { onRequest: [requireAdmin] }, getDetailHandler);
}
