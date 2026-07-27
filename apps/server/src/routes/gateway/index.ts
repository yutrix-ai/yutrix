import { FastifyInstance } from "fastify";
import { proxyHandler } from "./gatewayHandlers";
import { modelsHandler } from "./models";

export default async function (fastify: FastifyInstance) {
  // --- Route Registration ---
  fastify.get("/v1/models", modelsHandler);
  fastify.get("/models", modelsHandler);
  fastify.post("/v1/chat/completions", proxyHandler);
  fastify.post("/api/paas/v4/chat/completions", proxyHandler);
  fastify.post("/v1/messages", proxyHandler);
  fastify.post("/v1/complete", proxyHandler);
  fastify.post("/v0/chat/completions", proxyHandler);
  fastify.post("/v0/messages", proxyHandler);
}
