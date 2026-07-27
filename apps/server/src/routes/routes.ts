import { FastifyInstance } from "fastify";
import * as userRouteController from "../controllers/userRouteController";
import * as adminRouteController from "../controllers/adminRouteController";
import * as adminRouteMutateController from "../controllers/adminRouteMutateController";

export default async function (fastify: FastifyInstance) {
  fastify.addHook("onRequest", async (request, reply) => {
    try {
      await request.jwtVerify();
    } catch (err) {
      reply.send(err);
    }
  });

  fastify.get("/api/user/routes", userRouteController.getUserRoutes);
  fastify.get("/api/user/providers/:id/models", userRouteController.getProviderModels);
  fastify.post("/api/user/routes/:id/override", userRouteController.overrideUserRoute);

  fastify.get("/api/admin/routes", adminRouteController.getAdminRoutes);
  fastify.get("/api/admin/routes/:id", adminRouteController.getAdminRouteById);
  fastify.post("/api/admin/routes", adminRouteMutateController.createAdminRoute);
  fastify.patch("/api/admin/routes/:id", adminRouteMutateController.updateAdminRoute);
  fastify.delete("/api/admin/routes/:id", adminRouteMutateController.deleteAdminRoute);
}
