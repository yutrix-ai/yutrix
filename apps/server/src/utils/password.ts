import { z } from "zod";

export const strongPasswordSchema = z
  .string()
  .min(8, "密码至少需要 8 个字符")
  .refine((password) => /[A-Z]/.test(password), {
    message: "密码必须包含至少一个大写字母",
  })
  .refine((password) => /[a-z]/.test(password), {
    message: "密码必须包含至少一个小写字母",
  })
  .refine((password) => /[0-9]/.test(password), {
    message: "密码必须包含至少一个数字",
  })
  .refine((password) => /[^A-Za-z0-9]/.test(password), {
    message: "密码必须包含至少一个特殊字符",
  });
