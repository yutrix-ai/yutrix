import { FastifyRequest, FastifyReply } from "fastify";
import { db } from "../db";
import { providers, providerModels, providerApiKeys } from "../db/schema";
import { eq, and } from "drizzle-orm";
import crypto from "crypto";
import { z } from "zod";
import { decryptText } from "../utils/crypto";
import { clearModelAliasCache } from "../utils/modelAlias";

export const getProviderModels = async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as any;
      return await db
        .select()
        .from(providerModels)
        .where(
          and(
            eq(providerModels.providerId, id),
            eq(providerModels.active, true)
          )
        );
    };

export const getAllModels = async (request: FastifyRequest, reply: FastifyReply) => {
      return await db
        .select()
        .from(providerModels)
        .where(eq(providerModels.active, true));
    };

export const updateModelConfig = async (request: FastifyRequest, reply: FastifyReply) => {
      const { providerId, modelId } = request.params as any;
      const updateModelSchema = z.object({
        enabled: z.boolean().optional(),
        maxOutputTokens: z.number().int().nonnegative().nullable().optional(),
        inputTokenPricePerM: z.number().nonnegative().nullable().optional(),
        outputTokenPricePerM: z.number().nonnegative().nullable().optional(),
        tokenizerRepo: z.string().nullable().optional(),
        alias: z.string().nullable().optional(),
      });

      const parsed = updateModelSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "参数错误", details: parsed.error.issues });
      }

      const data = parsed.data;
      const updateData: any = {};
      if (data.enabled !== undefined) updateData.enabled = data.enabled;
      if (data.maxOutputTokens !== undefined) updateData.maxOutputTokens = data.maxOutputTokens;
      if (data.inputTokenPricePerM !== undefined) updateData.inputTokenPricePerM = data.inputTokenPricePerM;
      if (data.outputTokenPricePerM !== undefined) updateData.outputTokenPricePerM = data.outputTokenPricePerM;
      if (data.tokenizerRepo !== undefined) updateData.tokenizerRepo = data.tokenizerRepo;
      if (data.alias !== undefined) updateData.alias = data.alias;

      await db
        .update(providerModels)
        .set(updateData)
        .where(
          and(
            eq(providerModels.providerId, providerId),
            eq(providerModels.modelId, modelId)
          )
        );

      if (data.alias !== undefined) {
        clearModelAliasCache(providerId, modelId);
      }

      return { success: true };
    };

export const bulkUpdateModels = async (request: FastifyRequest, reply: FastifyReply) => {
      const { providerId } = request.params as any;
      const bulkUpdateModelsSchema = z.array(
        z.object({
          modelId: z.string(),
          enabled: z.boolean().optional(),
          maxOutputTokens: z.number().int().nonnegative().nullable().optional(),
          inputTokenPricePerM: z.number().nonnegative().nullable().optional(),
          outputTokenPricePerM: z.number().nonnegative().nullable().optional(),
          tokenizerRepo: z.string().nullable().optional(),
          alias: z.string().nullable().optional(),
        })
      );

      const parsed = bulkUpdateModelsSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "参数错误", details: parsed.error.issues });
      }

      const updates = parsed.data;

      await db.transaction(async (tx) => {
        for (const item of updates) {
          const updateData: any = {};
          if (item.enabled !== undefined) updateData.enabled = item.enabled;
          if (item.maxOutputTokens !== undefined) updateData.maxOutputTokens = item.maxOutputTokens;
          if (item.inputTokenPricePerM !== undefined) updateData.inputTokenPricePerM = item.inputTokenPricePerM;
          if (item.outputTokenPricePerM !== undefined) updateData.outputTokenPricePerM = item.outputTokenPricePerM;
          if (item.tokenizerRepo !== undefined) updateData.tokenizerRepo = item.tokenizerRepo;
          if (item.alias !== undefined) updateData.alias = item.alias;

          await tx
            .update(providerModels)
            .set(updateData)
            .where(
              and(
                eq(providerModels.providerId, providerId),
                eq(providerModels.modelId, item.modelId)
              )
            );

          if (item.alias !== undefined) {
            clearModelAliasCache(providerId, item.modelId);
          }
        }
      });

      return { success: true };
    };

export const refreshModels = async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as any;
      const existingList = await db
        .select()
        .from(providers)
        .where(eq(providers.id, id));

      if (existingList.length === 0) {
        return reply.code(404).send({ error: "Provider not found" });
      }

      const provider = existingList[0];
      if (!provider.openaiBaseUrl) {
        return reply.code(400).send({ error: "Provider has no OpenAI base URL configured." });
      }

      let sanitizedBaseUrl = provider.openaiBaseUrl;
      if (sanitizedBaseUrl.endsWith("/")) {
        sanitizedBaseUrl = sanitizedBaseUrl.slice(0, -1);
      }

      const activeKeys = await db
        .select()
        .from(providerApiKeys)
        .where(and(eq(providerApiKeys.providerId, id), eq(providerApiKeys.status, "active")));
      activeKeys.sort((a, b) => a.id.localeCompare(b.id));
      const apiKey = activeKeys.length > 0 ? decryptText(activeKeys[0].keyEncrypted) : "";

      try {
        let doFetch = fetch;
        let fetchOptions: any = {
          headers: {
            Authorization: apiKey ? `Bearer ${apiKey}` : "",
          },
        };

        if (provider.upstreamProxyUrl) {
          const undici = await import("undici");
          doFetch = undici.fetch as any;
          fetchOptions.dispatcher = new undici.ProxyAgent(provider.upstreamProxyUrl);
        }

        const response = await doFetch(`${sanitizedBaseUrl}/models`, fetchOptions);

        if (!response.ok) {
          await db.update(providers).set({
            lastTestAt: new Date(),
            lastTestStatus: "failed",
            lastTestMessage: `上游返回 HTTP ${response.status}`,
          }).where(eq(providers.id, id));
          return { success: false, message: `上游返回 HTTP ${response.status}` };
        }

        const data = await response.json();
        if (data && data.data && Array.isArray(data.data)) {
          const existing = await db
            .select()
            .from(providerModels)
            .where(
              eq(providerModels.providerId, id)
            );
          const existingMap = new Map(existing.map(m => [m.modelId, m]));
          const incomingModelIds = new Set(data.data.map((m: any) => m.id));

          // 1. Process existing models: mark as inactive if custom config exists but not in new list, delete if no custom config, and set active = true if in the list
          for (const m of existing) {
            if (!incomingModelIds.has(m.modelId)) {
              const hasCustomConfig =
                (m.maxOutputTokens && m.maxOutputTokens > 0) ||
                m.inputTokenPricePerM !== null ||
                m.outputTokenPricePerM !== null ||
                m.enabled === false;
              if (hasCustomConfig) {
                await db
                  .update(providerModels)
                  .set({ active: false })
                  .where(eq(providerModels.id, m.id));
              } else {
                await db
                  .delete(providerModels)
                  .where(eq(providerModels.id, m.id));
              }
            } else {
              // It is in the incoming list, ensure active is set to true
              if (!m.active) {
                await db
                  .update(providerModels)
                  .set({ active: true })
                  .where(eq(providerModels.id, m.id));
              }
            }
          }

          // 2. Insert new ones (or update active state if they are already in the DB but inactive)
          let newInsertedCount = 0;
          for (const m of data.data) {
            const modelId = m.id;
            if (!existingMap.has(modelId)) {
              await db.insert(providerModels).values({
                id: crypto.randomUUID(),
                providerId: id,
                modelId: modelId,
                displayName: m.id || modelId,
                enabled: true,
                active: true,
                createdAt: new Date(),
              });
              newInsertedCount++;
            } else {
              const existingModel = existingMap.get(modelId);
              if (existingModel && !existingModel.active) {
                await db
                  .update(providerModels)
                  .set({ active: true })
                  .where(eq(providerModels.id, existingModel.id));
              }
            }
          }

          await db.update(providers).set({
            lastTestAt: new Date(),
            lastTestStatus: "success",
            lastTestMessage: null,
          }).where(eq(providers.id, id));

          return { success: true, count: newInsertedCount };
        }

        await db.update(providers).set({
          lastTestAt: new Date(),
          lastTestStatus: "failed",
          lastTestMessage: "Invalid format from /models",
        }).where(eq(providers.id, id));

        return { success: false, message: "Invalid format from /models" };
      } catch (e: any) {
        await db.update(providers).set({
          lastTestAt: new Date(),
          lastTestStatus: "failed",
          lastTestMessage: e.message,
        }).where(eq(providers.id, id));
        return { success: false, message: e.message };
      }
    };
