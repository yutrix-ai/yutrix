import { FastifyInstance } from "fastify";
import { requireAdmin } from "../middleware/auth";
import {
  getSessions,
  getRequests,
  getSessionTurns,
  getUsers,
  getModels,
  getStream,
} from "../controllers/chatLogController";

export default async function (fastify: FastifyInstance) {
  // 1. Get paginated chat log sessions (Grouped by serverSessionId)
  fastify.get(
    "/api/admin/chat-logs/sessions",
    { onRequest: [requireAdmin] },
    getSessions
  );

  // 1b. Get paginated requests (Flat view)
  fastify.get(
    "/api/admin/chat-logs/requests",
    { onRequest: [requireAdmin] },
    getRequests
  );

  // 2. Get session details (turns)
  fastify.get(
    "/api/admin/chat-logs/sessions/:sessionId/turns",
    { onRequest: [requireAdmin] },
    getSessionTurns
  );

  // 2a. Get distinct users
  fastify.get(
    "/api/admin/chat-logs/users",
    { onRequest: [requireAdmin] },
    getUsers
  );

  // 2b. Get distinct models
  fastify.get(
    "/api/admin/chat-logs/models",
    { onRequest: [requireAdmin] },
    getModels
  );

  // 3. SSE endpoint for real-time chat logs
  fastify.get(
    "/api/admin/chat-logs/stream",
    { onRequest: [requireAdmin] },
    getStream
  );
}
