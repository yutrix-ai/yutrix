import { FastifyRequest, FastifyReply } from "fastify";
import { db } from "../db";
import { providers, providerModels, providerTestSessions, providerApiKeys } from "../db/schema";
import { eq, and } from "drizzle-orm";
import crypto from "crypto";
import { decryptText } from "../utils/crypto";
import { logAction } from "../utils/actionLogger";
import {
  isMaskedApiKey,
  testProviderSchema,
  runSingleTest
} from "../services/providerService";

export const listProviders = async (request: FastifyRequest, reply: FastifyReply) => {
      const list = await db.select().from(providers);
      const allModels = await db.select().from(providerModels);

      const countsByProvider = new Map<string, number>();
      for (const p of list) {
         countsByProvider.set(p.id, 0);
      }
      for (const m of allModels) {
         const count = countsByProvider.get(m.providerId) || 0;
         countsByProvider.set(m.providerId, count + 1);
      }

      const allKeys = await db.select().from(providerApiKeys);
      const keysCountByProvider = new Map<string, { total: number, active: number }>();
      for (const p of list) {
         keysCountByProvider.set(p.id, { total: 0, active: 0 });
      }
      for (const k of allKeys) {
         const count = keysCountByProvider.get(k.providerId) || { total: 0, active: 0 };
         count.total += 1;
         if (k.status === 'active') count.active += 1;
         keysCountByProvider.set(k.providerId, count);
      }

      return list.map((p: any) => ({
        id: p.id,
        name: p.name,
        openaiBaseUrl: p.openaiBaseUrl,
        anthropicBaseUrl: p.anthropicBaseUrl,
        concurrencyLimit: p.concurrencyLimit,
        timeoutMs: p.timeoutMs,
        streamTimeoutMs: p.streamTimeoutMs,
        maxOutputTokens: p.maxOutputTokens,
        hourlyTokenLimit: p.hourlyTokenLimit,
        enabled: p.enabled,
        upstreamProxyUrl: p.upstreamProxyUrl,
        weightProxyUrl: p.weightProxyUrl,
        lastTestAt: p.lastTestAt,
        lastTestStatus: p.lastTestStatus,
        createdAt: p.createdAt,
        modelsCount: countsByProvider.get(p.id) || 0,
        keysCount: keysCountByProvider.get(p.id)?.total || 0,
        activeKeysCount: keysCountByProvider.get(p.id)?.active || 0,
        manualModels: p.manualModels ? JSON.parse(p.manualModels) : [],
      }));
    };

export const testProvider = async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user as any;
      const parsed = testProviderSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "参数错误", details: parsed.error.issues });
      }

      const {
        openaiBaseUrl,
        anthropicBaseUrl,
        apiKey,
        upstreamProxyUrl,
        manualModels,
        providerId
      } = parsed.data;

      let finalApiKey = apiKey;
      let finalUpstreamProxyUrl = upstreamProxyUrl;

      if (providerId) {
        const existingProviders = await db.select().from(providers).where(eq(providers.id, providerId));
        if (existingProviders.length > 0) {
          if (!finalUpstreamProxyUrl) {
            finalUpstreamProxyUrl = existingProviders[0].upstreamProxyUrl || undefined;
          }
        }

        if (!finalApiKey || isMaskedApiKey(finalApiKey)) {
          const existingKeys = await db.select().from(providerApiKeys).where(and(eq(providerApiKeys.providerId, providerId), eq(providerApiKeys.status, 'active')));
          if (existingKeys.length > 0) {
            existingKeys.sort((a, b) => a.id.localeCompare(b.id));
            finalApiKey = decryptText(existingKeys[0].keyEncrypted);
          }
        }
      }

      const testOpenai = !!openaiBaseUrl;
      const testAnthropic = !!anthropicBaseUrl;

      if (!testOpenai && !testAnthropic) {
        return reply.code(400).send({ error: "请至少填写 OpenAI 或 Anthropic 协议 URL 中的一个" });
      }

      logAction({
        level: "信息",
        action: "供应商测试开始",
        username: user.username,
        message: `测试OpenAI=${testOpenai} 测试Anthropic=${testAnthropic}`,
      });

      let mergedModels: any[] = [];
      let discoveredModels: any[] = [];
      let openaiWorkingUrl = "";
      let anthropicWorkingUrl = "";

      if (testOpenai) {
        const openaiRes = await runSingleTest({
          protocol: "openai",
          baseUrl: openaiBaseUrl!,
          apiKey: finalApiKey || "",
          upstreamProxyUrl: finalUpstreamProxyUrl,
          manualModels
        });
        if (!openaiRes.success) {
          logAction({
            level: "警告",
            action: "供应商测试失败 (OpenAI)",
            username: user.username,
            message: openaiRes.message,
          });
          return { success: false, message: openaiRes.message, models: [] };
        }
        mergedModels = [...mergedModels, ...(openaiRes.models || [])];
        if (!manualModels || manualModels.length === 0) {
            discoveredModels = openaiRes.models || [];
        }
        openaiWorkingUrl = openaiRes.workingUrl!;
      }

      if (testAnthropic) {
        const anthropicRes = await runSingleTest({
          protocol: "anthropic",
          baseUrl: anthropicBaseUrl!,
          apiKey: finalApiKey || "",
          upstreamProxyUrl: finalUpstreamProxyUrl,
          manualModels,
          discoveredModels
        });
        if (!anthropicRes.success) {
          logAction({
            level: "警告",
            action: "供应商测试失败 (Anthropic)",
            username: user.username,
            message: anthropicRes.message,
          });
          return { success: false, message: anthropicRes.message, models: [] };
        }
        mergedModels = [...mergedModels, ...(anthropicRes.models || [])];
        anthropicWorkingUrl = anthropicRes.workingUrl!;
      }

      try {
        const sessionId = crypto.randomUUID();
        let protocolStr = "openai";
        let baseUrlHashInput = "";
        let apiKeyHashInput = "";

        if (testOpenai && testAnthropic) {
          protocolStr = "both";
          baseUrlHashInput = `${openaiWorkingUrl}|${anthropicWorkingUrl}`;
          apiKeyHashInput = finalApiKey || "";
        } else if (testOpenai) {
          protocolStr = "openai";
          baseUrlHashInput = openaiWorkingUrl;
          apiKeyHashInput = finalApiKey || "";
        } else {
          protocolStr = "anthropic";
          baseUrlHashInput = anthropicWorkingUrl;
          apiKeyHashInput = finalApiKey || "";
        }

        const baseUrlHash = crypto.createHash("sha256").update(baseUrlHashInput).digest("hex");
        const apiKeyHash = crypto.createHash("sha256").update(apiKeyHashInput).digest("hex");

        await db.insert(providerTestSessions).values({
          id: sessionId,
          protocol: protocolStr,
          baseUrlHash,
          apiKeyHash,
          models: JSON.stringify(mergedModels),
          expiresAt: new Date(Date.now() + 10 * 60 * 1000),
          createdAt: new Date(),
        });

        logAction({
          level: "信息",
          action: "供应商测试成功",
          username: user.username,
          message: `测试通过 模型数量=${mergedModels.length}`,
        });

        return {
          success: true,
          testSessionId: sessionId,
          models: mergedModels,
          isManual: !!manualModels && manualModels.length > 0,
        };
      } catch (e: any) {
        return { success: false, message: e.message, models: [] };
      }
    };

export const deleteProvider = async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as any;
      await db.delete(providers).where(eq(providers.id, id));
      await db.delete(providerModels).where(eq(providerModels.providerId, id));
      await db.delete(providerApiKeys).where(eq(providerApiKeys.providerId, id));
      return { success: true };
    };
