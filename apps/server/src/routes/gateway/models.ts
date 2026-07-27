import type { FastifyRequest, FastifyReply } from "fastify";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { systemSettings } from "../../db/schema";
import { formatError } from "../../utils/gatewayError";
import { extractAndValidateApiKey } from "./auth";

/**
 * Handler for GET /v1/models and GET /models.
 *
 * Authenticates the request via API key, then returns an OpenAI-compatible
 * model list.
 *
 * When model discovery is enabled (default), the list is built purely from
 * the configured custom model lists (OpenAI + Anthropic) stored in
 * systemSettings. This provides maximum compatibility with third-party
 * clients (Claude Desktop, opencode, etc.) since the returned model IDs
 * are well-known official models that clients can recognise.
 *
 * When model discovery is disabled, a single "default" model is returned.
 */
export async function modelsHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  try {
    // Determine incoming protocol (models endpoint is always OpenAI-format,
    // but we still need to pass the protocol for consistent error formatting).
    const reqPath = request.url.split("?")[0];
    let incomingProtocol = "openai";
    if (
      reqPath === "/v1/messages" ||
      reqPath === "/v0/messages" ||
      reqPath === "/v1/complete"
    ) {
      incomingProtocol = "anthropic";
    }

    // --- Auth ---
    const authResult = await extractAndValidateApiKey(
      request,
      reply,
      incomingProtocol,
    );
    if (!authResult) {
      // Reply was already sent with an appropriate error status.
      return;
    }

    const dataList: Array<{
      id: string;
      object: string;
      created: number;
      owned_by: string;
    }> = [];

    // Read model discovery settings from systemSettings
    const settingsRows = await db
      .select()
      .from(systemSettings)
      .where(
        eq(systemSettings.key, "modelDiscoveryEnabled"),
      );
    const enabledRow = settingsRows[0];
    const isEnabled = !enabledRow || enabledRow.value === "true";

    if (isEnabled) {
      // Fetch both OpenAI and Anthropic model lists
      const [openaiRows, anthropicRows] = await Promise.all([
        db
          .select()
          .from(systemSettings)
          .where(eq(systemSettings.key, "modelDiscoveryOpenai")),
        db
          .select()
          .from(systemSettings)
          .where(eq(systemSettings.key, "modelDiscoveryAnthropic")),
      ]);

      const uniqueModelIds = new Set<string>();

      // Parse and add OpenAI models
      const openaiModelsStr = openaiRows[0]?.value;
      if (openaiModelsStr) {
        try {
          const openaiModels = JSON.parse(openaiModelsStr);
          if (Array.isArray(openaiModels)) {
            for (const modelId of openaiModels) {
              const id = String(modelId).trim();
              if (id && !uniqueModelIds.has(id)) {
                uniqueModelIds.add(id);
                dataList.push({
                  id,
                  object: "model",
                  created: 1677610602,
                  owned_by: "openai",
                });
              }
            }
          }
        } catch {
          // Invalid JSON, skip
        }
      }

      // Parse and add Anthropic models
      const anthropicModelsStr = anthropicRows[0]?.value;
      if (anthropicModelsStr) {
        try {
          const anthropicModels = JSON.parse(anthropicModelsStr);
          if (Array.isArray(anthropicModels)) {
            for (const modelId of anthropicModels) {
              const id = String(modelId).trim();
              if (id && !uniqueModelIds.has(id)) {
                uniqueModelIds.add(id);
                dataList.push({
                  id,
                  object: "model",
                  created: 1677610602,
                  owned_by: "anthropic",
                });
              }
            }
          }
        } catch {
          // Invalid JSON, skip
        }
      }
    }

    // If nothing configured or discovery disabled, return a sensible default
    if (dataList.length === 0) {
      dataList.push({
        id: "default",
        object: "model",
        created: 1677610602,
        owned_by: "promptgate",
      });
    }

    return reply.code(200).send({
      object: "list",
      data: dataList,
    });
  } catch (err: any) {
    request.log.error(err, "Error in /v1/models route handler");
    return reply
      .code(500)
      .send(formatError("openai", 500, err.message || "Internal Server Error"));
  }
}
