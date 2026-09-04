import { FastifyPluginAsync } from "fastify";
import { OpencodeService } from "./opencodeService";

import { requireAdmin } from "../middleware/auth";

import { db } from "../db";
import { systemSettings } from "../db/schema";
import { eq } from "drizzle-orm";

export const opencodeRoutes: FastifyPluginAsync = async (fastify) => {
  const service = OpencodeService.getInstance();

  fastify.get("/api/admin/opencode/status", { onRequest: [requireAdmin] }, async (request, reply) => {
    const proxySetting = await db.select().from(systemSettings).where(eq(systemSettings.key, "opencode_download_proxy"));
    const proxyUrl = proxySetting[0]?.value || "";
    
    // Check version
    let version = "unknown";
    if (service.isReady()) {
      try {
        const { execSync } = require("child_process");
        version = execSync(`"${(service as any).binPath}" --version`).toString().trim();
      } catch (e) {
        // ignore
      }
    }

    return {
      ready: service.isReady(),
      running: service.isRunning(),
      version,
      arch: process.arch,
      proxyUrl,
    };
  });

  fastify.post("/api/admin/opencode/settings", { onRequest: [requireAdmin] }, async (request, reply) => {
    const { proxyUrl } = request.body as any;
    if (proxyUrl !== undefined) {
      const existing = await db.select().from(systemSettings).where(eq(systemSettings.key, "opencode_download_proxy"));
      if (existing.length > 0) {
        await db.update(systemSettings).set({ value: proxyUrl, updatedAt: Math.floor(Date.now() / 1000) }).where(eq(systemSettings.key, "opencode_download_proxy"));
      } else {
        await db.insert(systemSettings).values({
          id: require("crypto").randomUUID(),
          key: "opencode_download_proxy",
          value: proxyUrl,
          createdAt: Math.floor(Date.now() / 1000),
          updatedAt: Math.floor(Date.now() / 1000),
        });
      }
    }
    return { success: true };
  });

  fastify.post("/api/admin/opencode/start", { onRequest: [requireAdmin] }, async (request, reply) => {
    try {
      await service.start();
      return { success: true };
    } catch (e: any) {
      reply.status(500).send({ error: e.message });
    }
  });

  fastify.post("/api/admin/opencode/stop", { onRequest: [requireAdmin] }, async (request, reply) => {
    service.stop();
    return { success: true };
  });

  fastify.post("/api/admin/opencode/download", { onRequest: [requireAdmin] }, async (request, reply) => {
    try {
      await service.download();
      return { success: true };
    } catch (e: any) {
      reply.status(500).send({ error: e.message });
    }
  });
};

export { OpencodeService };
