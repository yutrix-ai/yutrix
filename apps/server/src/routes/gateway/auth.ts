import crypto from "crypto";
import type { FastifyRequest, FastifyReply } from "fastify";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { apiKeys } from "../../db/schema";
import { systemToken } from "../../utils/systemToken";
import { formatError } from "../../utils/gatewayError";
import type { AuthContext } from "./types";

/**
 * Extract the API key from request headers and validate it against the database.
 *
 * Handles two authentication flows:
 * 1. **System key** – the key matches `pg_system_${systemToken}`.  A synthetic
 *    `apiKeyRecord` is created and `userId` is read from the
 *    `x-promptgate-user-id` header.
 * 2. **User key** – the key is SHA-256 hashed and looked up in the `apiKeys`
 *    table.  Status (active / revoked / inactive) and expiry are checked.
 *
 * On failure an appropriate error response is sent via `reply` and `null` is
 * returned so the caller can short-circuit.
 *
 * @returns An `AuthContext` on success, or `null` if the response has already
 *          been sent with an error.
 */
export async function extractAndValidateApiKey(
  request: FastifyRequest,
  reply: FastifyReply,
  incomingProtocol: string,
): Promise<AuthContext | null> {
  // ── 1. Extract key from headers ──────────────────────────────────────
  let providedKey = "";
  const authHeader = request.headers.authorization;
  const xApiKey = request.headers["x-api-key"] as string;

  if (authHeader && authHeader.startsWith("Bearer ")) {
    providedKey = authHeader.substring(7);
  } else if (xApiKey) {
    providedKey = xApiKey;
  }

  if (!providedKey) {
    reply
      .code(401)
      .send(
        formatError(
          incomingProtocol,
          401,
          "缺少 API Key，请在 Authorization Bearer 或 x-api-key 中提供",
          "invalid_api_key",
        ),
      );
    return null;
  }

  // ── 2. System key path ───────────────────────────────────────────────
  const isSystemKey = providedKey === `pg_system_${systemToken}`;

  if (isSystemKey) {
    const userId = request.headers["x-promptgate-user-id"] as string;
    if (!userId) {
      reply
        .code(400)
        .send(formatError(incomingProtocol, 400, "Missing X-PromptGate-User-Id header"));
      return null;
    }

    return {
      providedKey,
      apiKeyRecord: {
        id: "system",
        userId,
        name: "System Summarizer",
        keyPrefix: "system",
        concurrencyLimit: 100,
      },
      userId,
      isSystemKey: true,
    };
  }

  // ── 3. User key path – hash & DB lookup ──────────────────────────────
  const keyHash = crypto
    .createHash("sha256")
    .update(providedKey)
    .digest("hex");

  const keyRecordList = await db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.keyHash, keyHash));

  if (keyRecordList.length === 0 || keyRecordList[0].status !== "active") {
    if (keyRecordList.length > 0 && keyRecordList[0].status === "revoked") {
      reply
        .code(401)
        .send(
          formatError(
            incomingProtocol,
            401,
            "API Key 已作废",
            "invalid_api_key",
          ),
        );
      return null;
    }
    reply
      .code(401)
      .send(
        formatError(
          incomingProtocol,
          401,
          "API Key 无效或未激活",
          "invalid_api_key",
        ),
      );
    return null;
  }

  const apiKeyRecord = keyRecordList[0];

  if (apiKeyRecord.expiresAt && apiKeyRecord.expiresAt.getTime() < Date.now()) {
    reply
      .code(401)
      .send(
        formatError(
          incomingProtocol,
          401,
          "API Key 已过期",
          "invalid_api_key",
        ),
      );
    return null;
  }

  return {
    providedKey,
    apiKeyRecord,
    userId: apiKeyRecord.userId,
    isSystemKey: false,
  };
}
