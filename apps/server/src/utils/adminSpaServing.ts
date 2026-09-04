import path from "path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { subdomains, systemSettings } from "../db/schema";
import {
  isAdminSpaDocumentPath,
  isAdminSpaFallbackPath,
  shouldServeAdminSpa,
} from "./adminSpa";

export function defaultAdminSpaRoot(): string {
  return path.join(
    process.cwd(),
    process.cwd().endsWith("server") ? "../web/dist" : "apps/web/dist",
  );
}

export async function loadAdminSpaGateContext(): Promise<{
  adminHost: string;
  routeHostnames: string[];
}> {
  try {
    const [adminRows, routeRows] = await Promise.all([
      db
        .select({ value: systemSettings.value })
        .from(systemSettings)
        .where(eq(systemSettings.key, "adminHost"))
        .limit(1),
      db.select({ hostname: subdomains.hostname }).from(subdomains),
    ]);
    return {
      adminHost: adminRows[0]?.value ?? "",
      routeHostnames: routeRows.map((row) => row.hostname).filter(Boolean),
    };
  } catch {
    // DB not ready (setup / bootstrap) — zero-config: no route hosts, empty adminHost
    return { adminHost: "", routeHostnames: [] };
  }
}

async function denyAdminSpaIfNeeded(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<boolean> {
  const ctx = await loadAdminSpaGateContext();
  if (
    shouldServeAdminSpa({
      hostname: request.hostname,
      adminHost: ctx.adminHost,
      routeHostnames: ctx.routeHostnames,
    })
  ) {
    return false;
  }
  reply.code(404).send({ error: "Not found" });
  return true;
}

/**
 * Static assets + host-aware SPA fallback.
 * Gate `/` and `/index.html` before @fastify/static auto-index, and again
 * in not-found before sendFile("index.html") for client-side routes.
 */
export function registerAdminSpaServing(
  fastify: FastifyInstance,
  options?: { root?: string },
): void {
  const root = options?.root ?? defaultAdminSpaRoot();

  fastify.addHook("onRequest", async (request, reply) => {
    if (!isAdminSpaDocumentPath(request.url)) return;
    await denyAdminSpaIfNeeded(request, reply);
  });

  fastify.register(fastifyStatic, { root });

  fastify.setNotFoundHandler(async (request, reply) => {
    if (!isAdminSpaFallbackPath(request.url)) {
      return reply.code(404).send({ error: "Not found" });
    }
    if (await denyAdminSpaIfNeeded(request, reply)) return;
    return reply.sendFile("index.html");
  });
}
