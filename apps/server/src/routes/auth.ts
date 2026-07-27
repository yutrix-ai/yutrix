import { FastifyInstance } from "fastify";
import { db } from "../db";
import { users, inviteCodes, userGroups, userGroupMembers } from "../db/schema";
import { eq, and } from "drizzle-orm";
import * as bcrypt from "bcryptjs";
import crypto from "crypto";
import { z } from "zod";
import { strongPasswordSchema } from "../utils/password";
import { logAction } from "../utils/actionLogger";

const loginSchema = z.object({
  username: z.string().min(1, "请输入用户名"),
  password: z.string().min(1, "请输入密码"),
});

const registerSchema = z.object({
  username: z.string().min(2, "用户名至少需要 2 个字符"),
  password: strongPasswordSchema,
  inviteCode: z.string().min(1, "请输入邀请码"),
});

export default async function (fastify: FastifyInstance) {
  fastify.post("/api/auth/login", async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "Invalid input", details: parsed.error.issues });
    }

    const { username, password } = parsed.data;
    const userResult = await db
      .select()
      .from(users)
      .where(eq(users.username, username));

    if (userResult.length === 0) {
      logAction({
        level: "WARN",
        code: "auth.login.failed",
        username: username,
        reason: "用户名不存在",
      });
      return reply.code(401).send({ error: "用户名或密码错误" });
    }

    const user = userResult[0];
    if (user.status !== "active") {
      logAction({
        level: "WARN",
        code: "auth.login.failed",
        userId: user.id,
        username: user.username,
        reason: "账号已被禁用",
      });
      return reply.code(403).send({ error: "账号已被禁用" });
    }

    const isValid = await bcrypt.compare(password, user.passwordHash);
    if (!isValid) {
      logAction({
        level: "WARN",
        code: "auth.login.failed",
        userId: user.id,
        username: user.username,
        reason: "密码错误",
      });
      return reply.code(401).send({ error: "用户名或密码错误" });
    }

    await db
      .update(users)
      .set({ lastLoginAt: new Date() })
      .where(eq(users.id, user.id));

    const token = fastify.jwt.sign({
      id: user.id,
      username: user.username,
      role: user.role,
    });
    reply.setCookie("token", token, {
      path: "/",
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60, // 7 days
    });

    logAction({
      level: "INFO",
      code: "auth.login.success",
      userId: user.id,
      username: user.username,
      role: user.role,
    });

    return {
      success: true,
      token,
      user: { id: user.id, username: user.username, role: user.role },
    };
  });

  fastify.post("/api/auth/logout", async (request, reply) => {
    reply.clearCookie("token", { path: "/" });
    return { success: true };
  });

  fastify.post("/api/auth/register", async (request, reply) => {
    const parsed = registerSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "Invalid input", details: parsed.error.issues });
    }

    const { username, password, inviteCode } = parsed.data;

    // Check if user exists
    const existingUser = await db
      .select()
      .from(users)
      .where(eq(users.username, username));
    if (existingUser.length > 0) {
      return reply.code(400).send({ error: "用户名已存在" });
    }

    // Check invite code
    const codeHash = crypto
      .createHash("sha256")
      .update(inviteCode)
      .digest("hex");
    const invite = await db
      .select()
      .from(inviteCodes)
      .where(eq(inviteCodes.codeHash, codeHash));

    if (invite.length === 0) {
      return reply.code(400).send({ error: "邀请码无效" });
    }

    const inviteRecord = invite[0];
    if (
      inviteRecord.status !== "active" ||
      (inviteRecord.expiresAt && inviteRecord.expiresAt < new Date())
    ) {
      return reply.code(400).send({ error: "邀请码已失效" });
    }

    if (inviteRecord.usedCount >= inviteRecord.maxUses) {
      return reply.code(400).send({ error: "邀请码使用次数已达上限" });
    }

    // Create user
    const passwordHash = await bcrypt.hash(password, 10);
    const userId = crypto.randomUUID();

    await db.transaction(async (tx) => {
      await tx.insert(users).values({
        id: userId,
        username,
        passwordHash,
        role: "user",
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await tx
        .update(inviteCodes)
        .set({ usedCount: inviteRecord.usedCount + 1 })
        .where(eq(inviteCodes.id, inviteRecord.id));

      const defaultGroups = await tx
        .select()
        .from(userGroups)
        .where(eq(userGroups.isDefault, true));
      if (defaultGroups.length > 0) {
        await tx.insert(userGroupMembers).values({
          id: crypto.randomUUID(),
          groupId: defaultGroups[0].id,
          userId,
          createdAt: new Date(),
        });
      }
    });

    return { success: true, message: "注册成功，请登录" };
  });

  fastify.get(
    "/api/auth/me",
    {
      onRequest: [
        async (req, rep) => {
          try {
            await req.jwtVerify();
          } catch (err) {
            rep.code(401).send({ error: "未授权访问" });
          }
        },
      ],
    },
    async (request, reply) => {
      const user = request.user as any;
      const userResult = await db
        .select()
        .from(users)
        .where(eq(users.id, user.id));
      if (userResult.length === 0)
        return reply.code(404).send({ error: "用户不存在" });
      const dbUser = userResult[0];
      return { id: dbUser.id, username: dbUser.username, role: dbUser.role };
    },
  );

  const changePasswordSchema = z.object({
    oldPassword: z.string().min(1, "请输入原密码"),
    newPassword: strongPasswordSchema,
  });

  fastify.post(
    "/api/auth/change-password",
    {
      onRequest: [
        async (req, rep) => {
          try {
            await req.jwtVerify();
          } catch (err) {
            rep.code(401).send({ error: "未授权访问" });
          }
        },
      ],
    },
    async (request, reply) => {
      const parsed = changePasswordSchema.safeParse(request.body);
      if (!parsed.success)
        return reply
          .code(400)
          .send({ error: "Invalid input", details: parsed.error.issues });

      const user = request.user as any;
      const { oldPassword, newPassword } = parsed.data;

      const userResult = await db
        .select()
        .from(users)
        .where(eq(users.id, user.id));
      if (userResult.length === 0)
        return reply.code(404).send({ error: "用户不存在" });

      const dbUser = userResult[0];
      const isValid = await bcrypt.compare(oldPassword, dbUser.passwordHash);
      if (!isValid) return reply.code(400).send({ error: "原密码错误" });

      const newPasswordHash = await bcrypt.hash(newPassword, 10);
      await db
        .update(users)
        .set({ passwordHash: newPasswordHash, updatedAt: new Date() })
        .where(eq(users.id, dbUser.id));

      return { success: true, message: "密码修改成功" };
    },
  );
}
