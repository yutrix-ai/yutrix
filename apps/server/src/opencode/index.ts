import { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireAdmin } from "../middleware/auth";
import { OpencodeService } from "./opencodeService";
import {
  getOpencodeAutoUpdate,
  getOpencodeDownloadProxy,
  setOpencodeAutoUpdate,
  setOpencodeDownloadProxy,
} from "./settings";

const settingsSchema = z.object({
  proxyUrl: z.string().optional(),
  autoUpdate: z.boolean().optional(),
});

export const opencodeRoutes: FastifyPluginAsync = async (fastify) => {
  const service = OpencodeService.getInstance();

  fastify.get("/api/admin/opencode/status", { onRequest: [requireAdmin] }, async () => {
    const status = await service.getStatus();
    const [proxyUrl, autoUpdate] = await Promise.all([
      getOpencodeDownloadProxy(),
      getOpencodeAutoUpdate(),
    ]);
    return {
      ready: status.ready,
      running: status.running,
      version: status.version,
      arch: status.arch,
      lastError: status.lastError,
      proxyUrl,
      autoUpdate,
      streaming: status.streaming,
    };
  });

  fastify.post("/api/admin/opencode/settings", { onRequest: [requireAdmin] }, async (request, reply) => {
    const parsed = settingsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "参数错误", details: parsed.error.issues });
    }
    try {
      if (parsed.data.proxyUrl !== undefined) {
        await setOpencodeDownloadProxy(parsed.data.proxyUrl);
      }
      if (parsed.data.autoUpdate !== undefined) {
        await setOpencodeAutoUpdate(parsed.data.autoUpdate);
      }
      const [proxyUrl, autoUpdate] = await Promise.all([
        getOpencodeDownloadProxy(),
        getOpencodeAutoUpdate(),
      ]);
      return { success: true, proxyUrl, autoUpdate };
    } catch (e: any) {
      return reply.code(400).send({ error: e.message });
    }
  });

  fastify.post("/api/admin/opencode/start", { onRequest: [requireAdmin] }, async (_request, reply) => {
    try {
      await service.start();
      return { success: true };
    } catch (e: any) {
      return reply.code(500).send({ error: e.message });
    }
  });

  fastify.post("/api/admin/opencode/stop", { onRequest: [requireAdmin] }, async () => {
    service.stop();
    return { success: true };
  });

  fastify.post("/api/admin/opencode/download", { onRequest: [requireAdmin] }, async (_request, reply) => {
    try {
      await service.download();
      return { success: true };
    } catch (e: any) {
      return reply.code(500).send({ error: e.message });
    }
  });
};

export { OpencodeService };
export { executeOpencodeSessionApi } from "./opencodeClient";
export {
  extractMessageText,
  resolveOpencodeProviderSlug,
  sanitizeOpencodeAssistantText,
  shouldRouteViaOpencode,
} from "./protocol";
