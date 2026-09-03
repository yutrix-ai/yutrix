import { FastifyInstance, FastifyPluginAsync } from "fastify";
import {
  isFreshInstall,
  getSetupPending,
  testDbConnection,
  completeSetup,
  TestDbParams,
  CompleteSetupParams,
} from "../services/setup";
import { loadDbConfig } from "../db/config";

const setupRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  // GET /api/setup/status
  fastify.get("/api/setup/status", async (request, reply) => {
    const fresh = await isFreshInstall();
    const config = loadDbConfig();

    return {
      fresh,
      driver: config.driver,
      setupCompleted: !fresh && !getSetupPending(),
      setupCompletedAt: config.setupCompletedAt || null,
    };
  });

  // POST /api/setup/test-db
  fastify.post<{ Body: TestDbParams }>("/api/setup/test-db", async (request, reply) => {
    const { driver, sqliteFile, databaseUrl } = request.body || {};

    if (!driver || (driver !== "sqlite" && driver !== "postgres")) {
      return reply.code(400).send({ ok: false, error: "Invalid or missing driver" });
    }

    const result = await testDbConnection({
      driver,
      sqliteFile,
      databaseUrl,
    });

    if (!result.ok) {
      return reply.code(400).send(result);
    }

    return result;
  });

  // POST /api/setup/complete
  fastify.post<{ Body: CompleteSetupParams }>("/api/setup/complete", async (request, reply) => {
    const fresh = await isFreshInstall();
    if (!fresh) {
      return reply.code(409).send({
        error: "Setup has already been completed",
        message: "System is already configured and initialized.",
      });
    }

    try {
      const result = await completeSetup(request.body);

      // Issue admin JWT token on completion so user can log in immediately
      const token = fastify.jwt.sign(
        {
          id: result.admin.id,
          username: result.admin.username,
          role: result.admin.role,
        },
        { expiresIn: "7d" }
      );

      reply.setCookie("token", token, {
        path: "/",
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        maxAge: 7 * 24 * 60 * 60,
      });

      return {
        ok: true,
        message: "Setup completed successfully",
        admin: result.admin,
        token,
      };
    } catch (err: any) {
      const statusCode = err.statusCode || 500;
      return reply.code(statusCode).send({
        error: err.message || "Failed to complete setup",
      });
    }
  });
};

export default setupRoutes;
