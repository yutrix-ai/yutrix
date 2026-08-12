import type { FastifyRequest, FastifyReply } from "fastify";
import { eq, and } from "drizzle-orm";
import { db } from "../../db";
import { systemSettings, endpoints, endpointRoutes, subdomains } from "../../db/schema";
import { formatError } from "../../utils/gatewayError";
import { extractAndValidateApiKey } from "./auth";

/**
 * Infer `owned_by` from provider protocol and model ID heuristic.
 */
function inferOwnedBy(providerProtocol: string, modelId: string): string {
  if (providerProtocol === "anthropic") return "anthropic";
  if (/^claude/i.test(modelId)) return "anthropic";
  if (/^gemini/i.test(modelId)) return "google";
  return "openai";
}

/**
 * Build model list dynamically from route configuration for the requesting
 * hostname. Returns the union of all L0 model IDs (or virtualModelAlias
 * when set) across enabled routes matching the current subdomain.
 *
 * Mirrors the subdomain / route filtering logic in routing.ts to ensure
 * consistency between what `/v1/models` advertises and what the gateway
 * can actually route.
 */
async function buildModelsFromRoutes(
  request: FastifyRequest,
): Promise<Array<{ id: string; object: string; created: number; owned_by: string }>> {
  const hostname = request.hostname; // Fastify strips port automatically

  // --- 1. Resolve subdomain ---
  const subdomainRows = await db
    .select()
    .from(subdomains)
    .where(eq(subdomains.hostname, hostname));
  const subdomainRecord = subdomainRows.length > 0 ? subdomainRows[0] : null;

  // If the hostname matched a configured subdomain but it's disabled, return
  // empty – the proxy handler would also reject with 403.
  if (subdomainRecord && !subdomainRecord.enabled) {
    return [];
  }

  // --- 2. Query all active & enabled endpoints ---
  const allEndpoints = await db
    .select()
    .from(endpoints)
    .where(
      and(
        eq(endpoints.status, "active"),
        eq(endpoints.enabled, true),
      ),
    );

  if (allEndpoints.length === 0) return [];

  const endpointMap = new Map(allEndpoints.map((ep) => [ep.id, ep]));

  // --- 3. Query all active & enabled routes ---
  const allRoutes = await db
    .select()
    .from(endpointRoutes)
    .where(
      and(
        eq(endpointRoutes.status, "active"),
        eq(endpointRoutes.enabled, true),
      ),
    );

  // --- 4. Filter & collect L0 models ---
  const uniqueModels = new Map<
    string,
    { id: string; object: string; created: number; owned_by: string }
  >();

  for (const route of allRoutes) {
    const endpoint = endpointMap.get(route.endpointId);
    if (!endpoint) continue;

    // Subdomain filtering – same logic as routing.ts resolveEndpointAndRoute
    if (subdomainRecord) {
      // When we have a subdomain, accept routes bound to this subdomain
      // OR wildcard routes (no subdomainId).
      if (route.subdomainId && route.subdomainId !== subdomainRecord.id) continue;
    } else {
      // No subdomain matched – only include wildcard routes.
      if (route.subdomainId) continue;
    }

    // Extract L0 model ID
    let l0ModelId = route.modelId;
    let l0Protocol = route.providerProtocol || "openai";

    if (route.targets) {
      try {
        const targets =
          typeof route.targets === "string"
            ? JSON.parse(route.targets)
            : route.targets;
        if (Array.isArray(targets) && targets.length > 0) {
          const l0Target = targets[0];
          if (l0Target.modelId) l0ModelId = l0Target.modelId;
          if (l0Target.providerProtocol) l0Protocol = l0Target.providerProtocol;
        }
      } catch {
        // Invalid targets JSON – fall back to route-level fields
      }
    }

    // Determine client-facing model ID:
    // If endpoint defines a virtualModelAlias, the client uses that name
    // in body.model; otherwise use the L0 modelId directly.
    const exposedModelId = endpoint.virtualModelAlias || l0ModelId;
    if (!exposedModelId) continue;

    if (!uniqueModels.has(exposedModelId)) {
      uniqueModels.set(exposedModelId, {
        id: exposedModelId,
        object: "model",
        created: 1677610602,
        owned_by: inferOwnedBy(l0Protocol, exposedModelId),
      });
    }
  }

  return Array.from(uniqueModels.values());
}

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
 * When model discovery is disabled, the list is built dynamically from
 * the actual route configuration – collecting the L0 (primary) model of
 * every enabled route that matches the requesting hostname / subdomain.
 * If no routes are configured, a single "default" placeholder is returned.
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
    } else {
      // Model discovery disabled – derive list from actual route config
      const routeModels = await buildModelsFromRoutes(request);
      dataList.push(...routeModels);
    }

    // If nothing configured or no routes found, return a sensible default
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
