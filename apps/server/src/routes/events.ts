import { FastifyInstance } from "fastify";
import { logEmitter } from "../utils/events";
import { requireAuth } from "../middleware/auth";

import { getQueryDateRange } from "../utils/timeRange";
import { withPublicModelName } from "../utils/modelAlias";

export default async function (fastify: FastifyInstance) {
  // SSE stream endpoint for real-time events.
  // Protected by requireAuth. In Docker / reverse proxy setups where cookies may be dropped
  // or stripped, clients must send "Authorization: Bearer <token>" and credentials: 'include'.
  fastify.get(
    "/api/events/stream",
    { onRequest: [requireAuth] },
    async (request, reply) => {
      const { startDate, endDate } = await getQueryDateRange(request.query, "day");

      reply.raw.setHeader("Content-Type", "text/event-stream");
      reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
      reply.raw.setHeader("Connection", "keep-alive");
      reply.raw.setHeader("X-Accel-Buffering", "no");
      reply.raw.setHeader("Access-Control-Allow-Origin", "*");
      reply.raw.flushHeaders?.();

      const sendEvent = (event: string, data: any) => {
        if (!reply.raw.destroyed && !reply.raw.writableEnded) {
          reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        }
      };

      const keepAliveInterval = setInterval(() => {
        sendEvent("ping", { time: Date.now() });
      }, 30000); // 30 seconds

      const user = (request as any).user;
      sendEvent("connected", { time: Date.now() });

      const handleLogUpdate = (data: any) => {
        const eventDate = data?.createdAt ? new Date(data.createdAt) : new Date();
        if (startDate && eventDate < startDate) {
          return;
        }
        if (endDate && eventDate >= endDate) {
          return;
        }

        if (user.role === "admin" || user.id === data.userId) {
          void withPublicModelName(data)
            .then((payload) => sendEvent("logUpdate", payload))
            .catch(() => {
              const payload = { ...data };
              delete payload.alias;
              sendEvent("logUpdate", payload);
            });
        }
      };

      logEmitter.on("logUpdate", handleLogUpdate);

      const cleanup = () => {
        clearInterval(keepAliveInterval);
        logEmitter.off("logUpdate", handleLogUpdate);
      };

      reply.raw.on("close", cleanup);
      request.raw.on("aborted", cleanup);
    }
  );
}
