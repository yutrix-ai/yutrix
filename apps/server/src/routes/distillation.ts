import type { FastifyInstance } from "fastify";
import { requireAdmin } from "../middleware/auth";
import * as distillationController from "../controllers/distillationController";

export default async function distillationRoutes(fastify: FastifyInstance) {
  fastify.addHook("onRequest", requireAdmin);

  fastify.get("/api/admin/distillation/settings", distillationController.getSettings);
  fastify.patch("/api/admin/distillation/settings", distillationController.patchSettings);

  fastify.get("/api/admin/distillation/jobs", distillationController.listJobs);
  fastify.post("/api/admin/distillation/jobs", distillationController.createJob);
  fastify.get("/api/admin/distillation/jobs/:id", distillationController.getJob);
  fastify.post(
    "/api/admin/distillation/jobs/:id/pause",
    distillationController.pauseJob,
  );
  fastify.post(
    "/api/admin/distillation/jobs/:id/resume",
    distillationController.resumeJob,
  );
  fastify.post(
    "/api/admin/distillation/jobs/:id/cancel",
    distillationController.cancelJob,
  );

  fastify.get("/api/admin/distillation/proposals", distillationController.getProposals);
  fastify.post(
    "/api/admin/distillation/proposals/validate",
    distillationController.postValidate,
  );
  fastify.post(
    "/api/admin/distillation/proposals/apply",
    distillationController.postApply,
  );
  fastify.post(
    "/api/admin/distillation/routing/rollback",
    distillationController.postRollback,
  );
  fastify.get(
    "/api/admin/distillation/routing/active",
    distillationController.getRoutingOverlay,
  );

  fastify.get("/api/admin/distillation/skills", distillationController.listSkills);
  fastify.get(
    "/api/admin/distillation/skills/:userId",
    distillationController.getSkill,
  );
  fastify.get(
    "/api/admin/distillation/skills/:userId/download",
    distillationController.downloadSkill,
  );
}
