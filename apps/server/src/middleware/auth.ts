import { FastifyRequest, FastifyReply } from "fastify";

export async function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  try {
    await request.jwtVerify();
  } catch (err) {
    return reply.code(401).send({ error: "未授权访问" });
  }
}

export async function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  try {
    await request.jwtVerify();
    const user = request.user as any;
    if (user.role !== "admin") {
      return reply.code(403).send({ error: "权限不足" });
    }
  } catch (err) {
    return reply.code(401).send({ error: "未授权访问" });
  }
}
