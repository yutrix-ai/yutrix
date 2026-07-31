import { FastifyRequest, FastifyReply } from "fastify";
import { db } from "../db";
import { providers, providerModels, providerTestSessions, providerApiKeys } from "../db/schema";
import { eq, and } from "drizzle-orm";
import crypto from "crypto";
import { encryptText, decryptText } from "../utils/crypto";
import {
  createProviderSchema,
  updateProviderSchema,
} from "../services/providerService";

async function getFirstActiveProviderApiKey(providerId: string): Promise<string> {
  const existingKeys = await db.select().from(providerApiKeys).where(and(eq(providerApiKeys.providerId, providerId), eq(providerApiKeys.status, "active")));
  existingKeys.sort((a, b) => a.id.localeCompare(b.id));
  return existingKeys.length > 0 ? decryptText(existingKeys[0].keyEncrypted) : "";
}

export const createProvider = async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = createProviderSchema.safeParse(request.body);
      if (!parsed.success)
        return reply
          .code(400)
          .send({ error: "Invalid input", details: parsed.error.issues });

      const data = parsed.data;
      const providerApiKey = data.apiKey || "";

      if (!data.testSessionId) {
        return reply.code(400).send({
          error:
            "Must provide testSessionId from /test API",
        });
      }

      let testedModelsList: any[] | null = null;
      let testedProtocol = "openai";
      if (data.testSessionId) {
        const sessionList = await db
          .select()
          .from(providerTestSessions)
          .where(eq(providerTestSessions.id, data.testSessionId));
        if (
          sessionList.length === 0 ||
          sessionList[0].expiresAt.getTime() < Date.now()
        ) {
          return reply
            .code(400)
            .send({ error: "Invalid or expired testSessionId" });
        }

        testedProtocol = sessionList[0].protocol;

        if (testedProtocol === "both") {
          const cleanOpenaiUrl = (data.openaiBaseUrl || "").endsWith("/") ? (data.openaiBaseUrl || "").slice(0, -1) : (data.openaiBaseUrl || "");
          const cleanAnthropicUrl = (data.anthropicBaseUrl || "").endsWith("/") ? (data.anthropicBaseUrl || "").slice(0, -1) : (data.anthropicBaseUrl || "");
          const currentBaseUrlHash = crypto.createHash("sha256").update(cleanOpenaiUrl + "|" + cleanAnthropicUrl).digest("hex");

          const currentApiKeyHash = crypto.createHash("sha256").update(providerApiKey).digest("hex");

          if (currentBaseUrlHash !== sessionList[0].baseUrlHash || currentApiKeyHash !== sessionList[0].apiKeyHash) {
            return reply.code(400).send({ error: "供应商密钥或地址已变更，必须重新进行连接测试" });
          }
        } else {
          let targetBaseUrl = testedProtocol === "openai" ? data.openaiBaseUrl : data.anthropicBaseUrl;

          if (!targetBaseUrl) {
            return reply.code(400).send({ error: `Missing baseUrl for tested protocol ${testedProtocol}` });
          }

          let sanitizedBaseUrl = targetBaseUrl;
          if (sanitizedBaseUrl.endsWith("/")) sanitizedBaseUrl = sanitizedBaseUrl.slice(0, -1);

          const currentBaseUrlHash = crypto.createHash("sha256").update(sanitizedBaseUrl).digest("hex");
          const currentApiKeyHash = crypto.createHash("sha256").update(providerApiKey).digest("hex");

          if (currentBaseUrlHash !== sessionList[0].baseUrlHash || currentApiKeyHash !== sessionList[0].apiKeyHash) {
            return reply.code(400).send({ error: "供应商密钥已变更，必须重新进行连接测试" });
          }
        }

        testedModelsList = JSON.parse(sessionList[0].models);
      }

      // Removed hasOpenAITestSession check to allow Anthropic-only tests

      const providerId = crypto.randomUUID();

      await db.insert(providers).values({
        id: providerId,
        name: data.name,
        openaiBaseUrl: data.openaiBaseUrl,
        anthropicBaseUrl: data.anthropicBaseUrl,
        concurrencyLimit: data.concurrencyLimit,
        timeoutMs: data.timeoutMs,
        streamTimeoutMs: data.streamTimeoutMs,
        maxOutputTokens: data.maxOutputTokens,
        hourlyTokenLimit: data.hourlyTokenLimit,
        enabled: data.enabled !== false,
        upstreamProxyUrl: data.upstreamProxyUrl || null,
        weightProxyUrl: data.weightProxyUrl || null,
        manualModels: data.manualModels ? JSON.stringify(data.manualModels) : null,
        lastTestStatus: data.testSessionId ? "success" : "failed",
        lastTestAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Save models with deduplication
      const modelsToInsert = new Map<string, any>();

      if (testedModelsList) {
        for (const m of testedModelsList) {
          const modelId = m.id || m;
          modelsToInsert.set(`${modelId}`, {
            id: crypto.randomUUID(),
            providerId,
            modelId: modelId,
            displayName: m.displayName || modelId,
            enabled: true,
            createdAt: new Date(),
          });
        }
      }

      // Also insert manualModels into provider_models (backward-compatible: manual models get a real DB row)
      if (data.manualModels && Array.isArray(data.manualModels)) {
        for (const modelId of data.manualModels) {
          const key = `${modelId}`;
          if (!modelsToInsert.has(key)) {
            modelsToInsert.set(key, {
              id: crypto.randomUUID(),
              providerId,
              modelId: modelId,
              displayName: modelId,
              enabled: true,
              createdAt: new Date(),
            });
          }
        }
      }

      for (const m of modelsToInsert.values()) {
        await db.insert(providerModels).values(m);
      }

      if (providerApiKey) {
        await db.insert(providerApiKeys).values({
          id: crypto.randomUUID(),
          providerId,
          keyEncrypted: encryptText(providerApiKey),
          status: "active",
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }

      return { success: true, id: providerId };
    };

export const updateProvider = async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as any;
      const parsed = updateProviderSchema.safeParse(request.body);
      if (!parsed.success)
        return reply.code(400).send({ error: "Invalid input", details: parsed.error.issues });

      const data = parsed.data;

      const existingProviders = await db.select().from(providers).where(eq(providers.id, id));
      if (existingProviders.length === 0) return reply.code(404).send({ error: "Provider not found" });
      const existing = existingProviders[0];

      let openaiCoreChanged = false;
      if (data.openaiBaseUrl !== undefined && data.openaiBaseUrl !== existing.openaiBaseUrl) openaiCoreChanged = true;

      let anthropicCoreChanged = false;
      if (data.anthropicBaseUrl !== undefined && data.anthropicBaseUrl !== existing.anthropicBaseUrl) anthropicCoreChanged = true;



      let testedModelsList: any[] | null = null;
      let testedProtocol = "openai";
      if (data.testSessionId) {
        const sessionList = await db
          .select()
          .from(providerTestSessions)
          .where(eq(providerTestSessions.id, data.testSessionId));
        if (
          sessionList.length === 0 ||
          sessionList[0].expiresAt.getTime() < Date.now()
        ) {
          return reply
            .code(400)
            .send({ error: "Invalid or expired testSessionId" });
        }

        testedProtocol = sessionList[0].protocol;

        if (testedProtocol === "both") {
          const cleanOpenaiUrl = (data.openaiBaseUrl !== undefined ? data.openaiBaseUrl : existing.openaiBaseUrl || "").endsWith("/") ? (data.openaiBaseUrl !== undefined ? data.openaiBaseUrl : existing.openaiBaseUrl || "").slice(0, -1) : (data.openaiBaseUrl !== undefined ? data.openaiBaseUrl : existing.openaiBaseUrl || "");
          const cleanAnthropicUrl = (data.anthropicBaseUrl !== undefined ? data.anthropicBaseUrl : existing.anthropicBaseUrl || "").endsWith("/") ? (data.anthropicBaseUrl !== undefined ? data.anthropicBaseUrl : existing.anthropicBaseUrl || "").slice(0, -1) : (data.anthropicBaseUrl !== undefined ? data.anthropicBaseUrl : existing.anthropicBaseUrl || "");
          const currentBaseUrlHash = crypto.createHash("sha256").update(cleanOpenaiUrl + "|" + cleanAnthropicUrl).digest("hex");
          const currentApiKeyHash = crypto.createHash("sha256").update(await getFirstActiveProviderApiKey(id)).digest("hex");

          if (currentBaseUrlHash !== sessionList[0].baseUrlHash || currentApiKeyHash !== sessionList[0].apiKeyHash) {
            return reply.code(400).send({ error: "供应商密钥或地址已变更，必须重新进行连接测试" });
          }
        } else {
          let targetBaseUrl: string | undefined | null = testedProtocol === "openai" ? data.openaiBaseUrl : data.anthropicBaseUrl;
          if (targetBaseUrl === undefined) {
             targetBaseUrl = testedProtocol === "openai" ? existing.openaiBaseUrl : existing.anthropicBaseUrl;
          }

          if (!targetBaseUrl) {
            return reply.code(400).send({ error: `Missing baseUrl for tested protocol ${testedProtocol}` });
          }

          let sanitizedBaseUrl = targetBaseUrl;
          if (sanitizedBaseUrl.endsWith("/")) sanitizedBaseUrl = sanitizedBaseUrl.slice(0, -1);

          const currentBaseUrlHash = crypto.createHash("sha256").update(sanitizedBaseUrl).digest("hex");
          const currentApiKeyHash = crypto.createHash("sha256").update(await getFirstActiveProviderApiKey(id)).digest("hex");

          if (currentBaseUrlHash !== sessionList[0].baseUrlHash || currentApiKeyHash !== sessionList[0].apiKeyHash) {
            return reply.code(400).send({ error: "供应商密钥已变更，必须重新进行连接测试" });
          }
        }

        testedModelsList = JSON.parse(sessionList[0].models);
      }

      let modelsChanged = false;
      if (data.manualModels !== undefined) {
         const oldModels = existing.manualModels ? JSON.parse(existing.manualModels) : [];
         const newModels = data.manualModels || [];
         if (oldModels.join(',') !== newModels.join(',')) {
            modelsChanged = true;
         }
      }

      const coreChanged = openaiCoreChanged || anthropicCoreChanged;
      if (coreChanged && !data.testSessionId) {
        return reply.code(400).send({ error: "修改了核心配置，必须重新进行连接测试" });
      }

      const updateData: any = { updatedAt: new Date() };

      if (data.name !== undefined) updateData.name = data.name;
      if (data.openaiBaseUrl !== undefined)
        updateData.openaiBaseUrl = data.openaiBaseUrl;
      if (data.anthropicBaseUrl !== undefined)
        updateData.anthropicBaseUrl = data.anthropicBaseUrl;
      if (data.concurrencyLimit !== undefined)
        updateData.concurrencyLimit = data.concurrencyLimit;
      if (data.timeoutMs !== undefined) updateData.timeoutMs = data.timeoutMs;
      if (data.streamTimeoutMs !== undefined) updateData.streamTimeoutMs = data.streamTimeoutMs;
      if (data.maxOutputTokens !== undefined) updateData.maxOutputTokens = data.maxOutputTokens;
      if (data.hourlyTokenLimit !== undefined) updateData.hourlyTokenLimit = data.hourlyTokenLimit;
      if (data.enabled !== undefined) updateData.enabled = data.enabled;
      if (data.upstreamProxyUrl !== undefined) updateData.upstreamProxyUrl = data.upstreamProxyUrl || null;
      if (data.weightProxyUrl !== undefined) updateData.weightProxyUrl = data.weightProxyUrl || null;
      if (data.manualModels !== undefined) updateData.manualModels = data.manualModels ? JSON.stringify(data.manualModels) : null;

      if (testedModelsList) {
        updateData.lastTestStatus = "success";
        updateData.lastTestAt = new Date();
      }

      await db.update(providers).set(updateData).where(eq(providers.id, id));

      // Handle model updates and deduplication
      if (testedModelsList) {
        const existing = await db
          .select()
          .from(providerModels)
          .where(
            eq(providerModels.providerId, id)
          );
        const existingMap = new Map(existing.map(m => [`${m.modelId}`, m]));
        const incomingKeys = new Set(testedModelsList.map(m => `${m.id || m}`));

        // Delete/Deactivate existing ones that are not in the new list
        for (const m of existing) {
          const key = `${m.modelId}`;
          if (!incomingKeys.has(key)) {
            const hasCustomConfig =
              (m.contextWindowTokens && m.contextWindowTokens > 0) ||
              (m.maxOutputTokens && m.maxOutputTokens > 0) ||
              m.inputTokenPricePerM !== null ||
              m.outputTokenPricePerM !== null ||
              m.enabled === false;
            if (hasCustomConfig) {
              if (m.active) {
                await db
                  .update(providerModels)
                  .set({ active: false })
                  .where(eq(providerModels.id, m.id));
              }
            } else {
              await db
                .delete(providerModels)
                .where(eq(providerModels.id, m.id));
            }
          } else if (incomingKeys.has(key)) {
            // It is in the incoming list, ensure active is set to true
            if (!m.active) {
              await db
                .update(providerModels)
                .set({ active: true })
                .where(eq(providerModels.id, m.id));
            }
          }
        }

        // Insert new ones (or update active state if they are already in the DB but inactive)
        for (const m of testedModelsList) {
          const modelId = m.id || m;
          const key = `${modelId}`;
          const displayName = m.displayName || m.id || modelId;
          if (!existingMap.has(key)) {
            await db.insert(providerModels).values({
              id: crypto.randomUUID(),
              providerId: id,
              modelId: modelId,
              displayName: displayName,
              enabled: true,
              active: true,
              createdAt: new Date(),
            });
          } else {
            const existingModel = existingMap.get(key);
            if (existingModel && !existingModel.active) {
              await db
                .update(providerModels)
                .set({ active: true })
                .where(eq(providerModels.id, existingModel.id));
            }
          }
        }
      }

      // Sync manualModels to provider_models (even without testSessionId)
      if (modelsChanged && data.manualModels && Array.isArray(data.manualModels)) {
        const existingModels = await db
          .select()
          .from(providerModels)
          .where(eq(providerModels.providerId, id));
        const existingKeys = new Set(existingModels.map(m => `${m.modelId}`));

        for (const modelId of data.manualModels) {
          const key = `${modelId}`;
          if (!existingKeys.has(key)) {
            await db.insert(providerModels).values({
              id: crypto.randomUUID(),
              providerId: id,
              modelId: modelId,
              displayName: modelId,
              enabled: true,
              active: true,
              createdAt: new Date(),
            });
          }
        }
      }

      return { success: true };
    };
