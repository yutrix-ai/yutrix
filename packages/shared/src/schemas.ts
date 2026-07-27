import { z } from "zod";

export const userRoleSchema = z.enum(["admin", "user"]);
export const userStatusSchema = z.enum(["active", "disabled"]);

export const loginSchema = z.object({
  username: z.string().min(1, "用户名不能为空"),
  password: z.string().min(1, "密码不能为空"),
});
