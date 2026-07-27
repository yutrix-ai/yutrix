import { db } from "../db";
import { providers, providerModels, providerTestSessions, providerApiKeys } from "../db/schema";
import { eq, and } from "drizzle-orm";
import crypto from "crypto";
import { z } from "zod";
import { encryptText, decryptText } from "../utils/crypto";
import { logAction } from "../utils/actionLogger";

export function maskApiKey(key: string | null | undefined): string {
  if (!key) return "";
  const dots = "••••••••••••";
  if (key.startsWith("sk-proj-")) {
    if (key.length > 14) {
      const prefix = key.slice(0, 12);
      const suffix = key.slice(-4);
      return prefix + dots + suffix;
    }
    return "sk-proj-" + dots;
  }
  if (key.startsWith("sk-")) {
    if (key.length > 14) {
      const prefix = key.slice(0, 7);
      const suffix = key.slice(-4);
      return prefix + dots + suffix;
    }
    return "sk-" + dots;
  }
  if (key.length > 8) {
    const prefix = key.slice(0, 4);
    const suffix = key.slice(-4);
    return prefix + dots + suffix;
  }
  return dots;
}

export function isMaskedApiKey(key: string | null | undefined): boolean {
  if (!key) return false;
  return key.includes("...") || key.includes("*") || key.includes("•");
}

export const createProviderSchema = z.object({
  name: z.string().min(1),
  openaiBaseUrl: z.string().url().optional().or(z.literal("")),
  anthropicBaseUrl: z.string().url().optional().or(z.literal("")),
  apiKey: z.string().optional(),
  testSessionId: z.string().optional(),
  timeoutMs: z.number().int().nonnegative().default(60000),
  streamTimeoutMs: z.number().int().nonnegative().default(180000),
  concurrencyLimit: z.number().int().positive().default(10),
  maxOutputTokens: z.number().int().nonnegative().default(0),
  hourlyTokenLimit: z.number().int().nonnegative().default(0),
  enabled: z.boolean().default(true),
  upstreamProxyUrl: z.string().url().optional().or(z.literal("")),
  weightProxyUrl: z.string().url().optional().or(z.literal("")),
  manualModels: z.array(z.string()).optional(),
});

export const updateProviderSchema = createProviderSchema.omit({ apiKey: true }).partial();

export const testProviderSchema = z.object({
  openaiBaseUrl: z.string().url().optional().or(z.literal("")),
  anthropicBaseUrl: z.string().url().optional().or(z.literal("")),
  apiKey: z.string().optional(),
  upstreamProxyUrl: z.string().url().optional().or(z.literal("")),
  manualModels: z.array(z.string()).optional(),
  providerId: z.string().optional(),
});

export const testManualSchema = z.object({
  protocol: z.enum(["openai", "anthropic"]),
  baseUrl: z.string().url(),
  apiKey: z.string().optional(),
  models: z.array(z.string()).min(1),
});

export async function runSingleTest({
  protocol,
  baseUrl,
  apiKey,
  upstreamProxyUrl,
  manualModels,
  discoveredModels,
}: {
  protocol: "openai" | "anthropic";
  baseUrl: string;
  apiKey: string;
  upstreamProxyUrl?: string;
  manualModels?: string[];
  discoveredModels?: any[];
}) {
  let doFetch = fetch as any;
  let fetchOptions: any = {
    headers: {
      ...(apiKey ? (protocol === "openai" ? { Authorization: `Bearer ${apiKey}` } : { "x-api-key": apiKey }) : {}),
    },
  };

  if (upstreamProxyUrl) {
    const { request, ProxyAgent } = await import("undici");
    const dispatcher = new ProxyAgent(upstreamProxyUrl);
    doFetch = async (url: string, options: any) => {
      const res = await request(url, {
        dispatcher,
        method: options.method || "GET",
        headers: options.headers,
        body: options.body,
        signal: options.signal,
      });
      return {
        ok: res.statusCode >= 200 && res.statusCode < 300,
        status: res.statusCode,
        json: async () => await res.body.json(),
        text: async () => await res.body.text(),
      };
    };
  }

  let sanitizedBaseUrl = baseUrl;
  if (sanitizedBaseUrl.endsWith("/")) sanitizedBaseUrl = sanitizedBaseUrl.slice(0, -1);

  let testModelIds: string[] = [];
  let finalModels: any[] = [];
  let errorResponse: any = null;

  // Helper: filter for text/chat models from a model list
  const filterTextModels = (models: any[]) => {
    return models.filter(m => {
      const id = m.id.toLowerCase();
      const isText = Array.isArray(m.task_type) && (m.task_type.includes("TextGeneration") || m.task_type.includes("ChatCompletion"));
      return isText || id.includes("gpt") || id.includes("claude") || id.includes("text") || id.includes("chat") || id.includes("lite") || id.includes("pro") || id.includes("mini") || id.includes("deepseek") || id.includes("v4") || id.includes("3.5") || id.includes("glm") || id.includes("gemini") || id.includes("code") || id.includes("seed") || id.includes("qwen") || id.includes("llama");
    });
  };

  if (manualModels && manualModels.length > 0) {
    testModelIds = [manualModels[0]];
    finalModels = manualModels.map(m => ({ id: m, displayName: m }));
  } else if (discoveredModels && discoveredModels.length > 0) {
    finalModels = discoveredModels;
    const textModels = filterTextModels(finalModels);
    testModelIds = textModels.length > 0 ? textModels.slice(0, 3).map(m => m.id) : finalModels.slice(0, 3).map(m => m.id);
  } else {
    // Auto fetch models — use baseUrl + /models directly (same as providerModelController)
    try {
      const modelsUrl = `${sanitizedBaseUrl}/models`;
      const response = await doFetch(modelsUrl, fetchOptions);
      if (response.ok) {
        const data = await response.json();
        if (data && data.data && Array.isArray(data.data) && data.data.length > 0) {
          finalModels = data.data.map((m: any) => ({ id: m.id, displayName: m.id, task_type: m.task_type }));
          const textModels = filterTextModels(finalModels);
          testModelIds = textModels.length > 0 ? textModels.slice(0, 3).map(m => m.id) : finalModels.slice(0, 3).map(m => m.id);
        } else {
          errorResponse = { message: `${protocol} 获取模型列表为空` };
        }
      } else {
        errorResponse = { status: response.status, message: `${protocol} 无法获取模型列表` };
      }
    } catch (e: any) {
      errorResponse = { message: `${protocol} 网络请求失败: ${e.message}` };
    }
  }

  if (testModelIds.length > 0) {
    let lastErrorMsg = "";
    let allNetworkError = true;

    for (const testModelId of testModelIds) {
      let llmResponse: any;
      let fetchError = false;
      let errorResponseInner: any = null;
      try {
        if (protocol === "openai") {
          // OpenAI: baseUrl + /chat/completions (matches gateway upstream.ts L107 + L395)
          const llmOptions = {
            ...fetchOptions,
            method: "POST",
            headers: {
              ...fetchOptions.headers,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: testModelId,
              messages: [{ role: "user", content: "Return OK only" }],
              max_tokens: 10,
            }),
          };
          const testUrl = `${sanitizedBaseUrl}/chat/completions`;
          llmResponse = await doFetch(testUrl, llmOptions);
        } else {
          // Anthropic: baseUrl + /v1/messages (matches gateway upstream.ts L110 + L395)
          const llmOptions = {
            ...fetchOptions,
            method: "POST",
            headers: {
              ...fetchOptions.headers,
              "anthropic-version": "2023-06-01",
              "content-type": "application/json",
            },
            body: JSON.stringify({
              model: testModelId,
              messages: [{ role: "user", content: "Return OK only" }],
              max_tokens: 10,
            }),
          };
          const testUrl = `${sanitizedBaseUrl}/v1/messages`;
          llmResponse = await doFetch(testUrl, llmOptions);
        }
      } catch (e: any) {
        fetchError = true;
        console.error("Fetch failed detailed error:", e);
        if (e.cause) console.error("Fetch failed cause:", e.cause);
        errorResponseInner = { message: `${protocol} LLM测试请求发生网络错误: ${e.message}${e.cause ? ` (${e.cause.message || e.cause})` : ""}` };
      }

      if (fetchError) {
        lastErrorMsg = errorResponseInner.message;
        continue;
      }

      // We got an HTTP response (even if error), so network is reachable
      allNetworkError = false;

      if (llmResponse.ok) {
        return { success: true, models: finalModels, workingUrl: sanitizedBaseUrl };
      } else {
        const errText = await llmResponse.text().catch(() => "");
        lastErrorMsg = `${protocol} 模型 ${testModelId} 测试失败 HTTP ${llmResponse.status}: ${errText.slice(0, 100)}`;

        // If it's auth error, we shouldn't consider it successful
        if (llmResponse.status === 401 || llmResponse.status === 403) {
            return { success: false, message: lastErrorMsg };
        }
      }
    }

    // Lenient fallback: if models were auto-discovered (not manually specified),
    // AND at least one attempt got an HTTP response (not all network errors),
    // the connection and API key are generally valid.
    if ((!manualModels || manualModels.length === 0) && !allNetworkError) {
        return { success: true, models: finalModels, workingUrl: sanitizedBaseUrl };
    }

    return {
      success: false,
      message: lastErrorMsg
    };
  }

  return { success: false, message: errorResponse?.message || `${protocol} 没有可用模型进行连通性测试` };
}
