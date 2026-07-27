import * as providerUpdateController from "../controllers/providerUpdateController";
import { FastifyInstance } from "fastify";
import { requireAdmin } from "../middleware/auth";
import * as providerController from "../controllers/providerController";
import * as providerModelController from "../controllers/providerModelController";
import * as providerKeyController from "../controllers/providerKeyController";

export default async function (fastify: FastifyInstance) {
  fastify.get("/api/admin/providers", { onRequest: [requireAdmin] }, providerController.listProviders);
  fastify.post("/api/admin/providers/test", { onRequest: [requireAdmin] }, providerController.testProvider);
  fastify.post("/api/admin/providers", { onRequest: [requireAdmin] }, providerUpdateController.createProvider);
  fastify.patch("/api/admin/providers/:id", { onRequest: [requireAdmin] }, providerUpdateController.updateProvider);
  fastify.delete("/api/admin/providers/:id", { onRequest: [requireAdmin] }, providerController.deleteProvider);
  fastify.get("/api/admin/providers/:id/models", { onRequest: [requireAdmin] }, providerModelController.getProviderModels);
  fastify.get("/api/admin/models", { onRequest: [requireAdmin] }, providerModelController.getAllModels);
  fastify.post("/api/admin/providers/:id/refresh-models", { onRequest: [requireAdmin] }, providerModelController.refreshModels);
  fastify.patch("/api/admin/providers/:providerId/models/:modelId", { onRequest: [requireAdmin] }, providerModelController.updateModelConfig);
  fastify.patch("/api/admin/providers/:providerId/models", { onRequest: [requireAdmin] }, providerModelController.bulkUpdateModels);
  fastify.get("/api/admin/providers/:providerId/keys", { onRequest: [requireAdmin] }, providerKeyController.getProviderKeys);
  fastify.post("/api/admin/providers/:providerId/keys", { onRequest: [requireAdmin] }, providerKeyController.createProviderKey);
  fastify.patch("/api/admin/providers/:providerId/keys/:keyId", { onRequest: [requireAdmin] }, providerKeyController.updateProviderKey);
  fastify.delete("/api/admin/providers/:providerId/keys/:keyId", { onRequest: [requireAdmin] }, providerKeyController.deleteProviderKey);
}
