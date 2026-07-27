import { z } from "zod";
import { userRoleSchema, userStatusSchema, loginSchema } from "./schemas";

export type UserRole = z.infer<typeof userRoleSchema>;
export type UserStatus = z.infer<typeof userStatusSchema>;
export type LoginRequest = z.infer<typeof loginSchema>;
