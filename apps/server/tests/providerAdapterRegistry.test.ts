import { describe, expect, it, afterEach } from "vitest";
import { resolveProviderAdapter, adaptersRegistry } from "../src/routes/gateway/providerAdapters/registry";
import { ProviderAdapterContext } from "../src/routes/gateway/providerAdapters/types";
import fs from "fs";
import path from "path";

function makeContext(overrides: Partial<ProviderAdapterContext>): ProviderAdapterContext {
  return {
    providerId: "test-p",
    providerName: "Test Provider",
    providerProtocol: "openai",
    rawBaseUrl: "https://api.openai.com/v1",
    normalizedBaseUrl: "https://api.openai.com/v1",
    hostname: "api.openai.com",
    pathname: "/v1",
    modelId: "gpt-4o",
    incomingProtocol: "openai",
    requestPath: "/v1/chat/completions",
    ...overrides,
  };
}

describe("Provider Adapter Registry — priority resolution", () => {
  afterEach(() => {
    delete process.env.PROMPTGATE_DISABLED_PROVIDER_ADAPTERS;
  });

  // ═══════════════════════════════════════════════════════════════════════
  //  §2 Core: OpenRouter URL must beat Google model-name matching
  // ═══════════════════════════════════════════════════════════════════════

  it("OpenRouter URL + google/gemini-3.1-pro-preview → openrouter (not google)", () => {
    const ctx = makeContext({
      rawBaseUrl: "https://openrouter.ai/api/v1",
      hostname: "openrouter.ai",
      pathname: "/api/v1",
      modelId: "google/gemini-3.1-pro-preview",
      providerName: "OpenRouter",
    });
    expect(resolveProviderAdapter(ctx).id).toBe("openrouter");
  });

  it("OpenRouter URL + google/gemma-3-27b → openrouter (not google)", () => {
    const ctx = makeContext({
      rawBaseUrl: "https://openrouter.ai/api/v1",
      hostname: "openrouter.ai",
      pathname: "/api/v1",
      modelId: "google/gemma-3-27b",
      providerName: "OpenRouter",
    });
    expect(resolveProviderAdapter(ctx).id).toBe("openrouter");
  });

  it("OpenRouter URL + providerName 'Google via OpenRouter' → openrouter (not google)", () => {
    const ctx = makeContext({
      rawBaseUrl: "https://openrouter.ai/api/v1",
      hostname: "openrouter.ai",
      pathname: "/api/v1",
      modelId: "google/gemini-2.5-flash",
      providerName: "Google via OpenRouter",
    });
    expect(resolveProviderAdapter(ctx).id).toBe("openrouter");
  });

  // ═══════════════════════════════════════════════════════════════════════
  //  Google URL matching — correct cases
  // ═══════════════════════════════════════════════════════════════════════

  it("Real Google URL + Gemini model → google", () => {
    const ctx = makeContext({
      rawBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
      hostname: "generativelanguage.googleapis.com",
      pathname: "/v1beta",
      modelId: "gemini-2.5-flash",
      providerName: "Google AI Studio",
    });
    expect(resolveProviderAdapter(ctx).id).toBe("google");
  });

  it("Compatible provider URL + gemini model → transparent (legacy fallback removed)", () => {
    const ctx = makeContext({
      rawBaseUrl: "https://api.someproxy.com/v1",
      hostname: "api.someproxy.com",
      pathname: "/v1",
      modelId: "gemini-2.5-flash",
      providerName: "Custom Proxy",
    });
    expect(resolveProviderAdapter(ctx).id).toBe("transparent");
  });

  it("Compatible provider + google protocol → transparent (legacy fallback removed)", () => {
    const ctx = makeContext({
      rawBaseUrl: "https://api.someproxy.com/v1",
      hostname: "api.someproxy.com",
      pathname: "/v1",
      modelId: "some-model",
      providerProtocol: "google",
      providerName: "Custom Proxy",
    });
    expect(resolveProviderAdapter(ctx).id).toBe("transparent");
  });

  // ═══════════════════════════════════════════════════════════════════════
  //  Google hostname security — reject malicious domains
  // ═══════════════════════════════════════════════════════════════════════

  it("evilgoogleapis.com → NOT google", () => {
    const ctx = makeContext({
      rawBaseUrl: "https://evilgoogleapis.com/v1",
      hostname: "evilgoogleapis.com",
      pathname: "/v1",
      modelId: "gpt-4o",
      providerName: "Evil Provider",
    });
    expect(resolveProviderAdapter(ctx).id).not.toBe("google");
  });

  it("googleapis.com.example.com → NOT google", () => {
    const ctx = makeContext({
      rawBaseUrl: "https://googleapis.com.example.com/v1",
      hostname: "googleapis.com.example.com",
      pathname: "/v1",
      modelId: "gpt-4o",
      providerName: "Evil Provider",
    });
    expect(resolveProviderAdapter(ctx).id).not.toBe("google");
  });

  // ═══════════════════════════════════════════════════════════════════════
  //  OpenRouter URL matching — correct and negative cases
  // ═══════════════════════════════════════════════════════════════════════

  it("openrouter.ai/api/v1 → openrouter", () => {
    const ctx = makeContext({
      rawBaseUrl: "https://openrouter.ai/api/v1",
      hostname: "openrouter.ai",
      pathname: "/api/v1",
    });
    expect(resolveProviderAdapter(ctx).id).toBe("openrouter");
  });

  it("openrouter.ai/api/v1/ (trailing slash) → openrouter", () => {
    const ctx = makeContext({
      rawBaseUrl: "https://openrouter.ai/api/v1/",
      hostname: "openrouter.ai",
      pathname: "/api/v1/",
    });
    expect(resolveProviderAdapter(ctx).id).toBe("openrouter");
  });

  it("OPENROUTER.AI (case insensitive) → openrouter", () => {
    const ctx = makeContext({
      rawBaseUrl: "https://OPENROUTER.AI/api/v1",
      hostname: "openrouter.ai", // parseAndNormalizeUrl lowercases
      pathname: "/api/v1",
    });
    expect(resolveProviderAdapter(ctx).id).toBe("openrouter");
  });

  it("openrouter.ai.example.com → NOT openrouter", () => {
    const ctx = makeContext({
      rawBaseUrl: "https://openrouter.ai.example.com/api/v1",
      hostname: "openrouter.ai.example.com",
      pathname: "/api/v1",
    });
    expect(resolveProviderAdapter(ctx).id).not.toBe("openrouter");
  });

  it("example.com with openrouter in query → NOT openrouter", () => {
    const ctx = makeContext({
      rawBaseUrl: "https://example.com/api/v1?provider=openrouter",
      hostname: "example.com",
      pathname: "/api/v1",
    });
    expect(resolveProviderAdapter(ctx).id).not.toBe("openrouter");
  });

  // ═══════════════════════════════════════════════════════════════════════
  //  Default fallback
  // ═══════════════════════════════════════════════════════════════════════

  it("standard OpenAI URL → transparent", () => {
    const ctx = makeContext({
      rawBaseUrl: "https://api.openai.com/v1",
      hostname: "api.openai.com",
      pathname: "/v1",
      modelId: "gpt-4o",
    });
    expect(resolveProviderAdapter(ctx).id).toBe("transparent");
  });

  // ═══════════════════════════════════════════════════════════════════════
  //  Emergency disable
  // ═══════════════════════════════════════════════════════════════════════

  it("disabled openrouter → does NOT accidentally fall to google for OpenRouter Gemini models", () => {
    process.env.PROMPTGATE_DISABLED_PROVIDER_ADAPTERS = "openrouter";
    const ctx = makeContext({
      rawBaseUrl: "https://openrouter.ai/api/v1",
      hostname: "openrouter.ai",
      pathname: "/api/v1",
      modelId: "google/gemini-3.1-pro-preview",
      providerName: "OpenRouter",
    });
    // When OpenRouter is disabled, it should fall to transparent (not google)
    // because the hostname is openrouter.ai, not googleapis.com.
    // The model name alone should not trigger google when URL is clearly non-Google.
    const resolved = resolveProviderAdapter(ctx);
    expect(resolved.id).not.toBe("google");
  });

  it("disabled openrouter + google → transparent", () => {
    process.env.PROMPTGATE_DISABLED_PROVIDER_ADAPTERS = "openrouter, google";
    const ctx = makeContext({
      rawBaseUrl: "https://openrouter.ai/api/v1",
      hostname: "openrouter.ai",
      pathname: "/api/v1",
      modelId: "google/gemini-3.1-pro-preview",
      providerName: "OpenRouter",
    });
    expect(resolveProviderAdapter(ctx).id).toBe("transparent");
  });

  it("disabled with extra spacing/unknown names → ignores unknown, applies valid disables", () => {
    process.env.PROMPTGATE_DISABLED_PROVIDER_ADAPTERS = "  unknown-adapter ,  another-one ";
    const ctx = makeContext({
      rawBaseUrl: "https://openrouter.ai/api/v1",
      hostname: "openrouter.ai",
      pathname: "/api/v1",
    });
    expect(resolveProviderAdapter(ctx).id).toBe("openrouter");
  });

  // ═══════════════════════════════════════════════════════════════════════
  //  Fallback after provider change re-resolves adapter
  // ═══════════════════════════════════════════════════════════════════════

  it("re-resolution for fallback attempt with different URL → different adapter", () => {
    // First attempt: OpenRouter
    const ctxOR = makeContext({
      rawBaseUrl: "https://openrouter.ai/api/v1",
      hostname: "openrouter.ai",
      pathname: "/api/v1",
      modelId: "google/gemini-3.1-pro-preview",
    });
    expect(resolveProviderAdapter(ctxOR).id).toBe("openrouter");

    // Fallback attempt: Google directly
    const ctxGoogle = makeContext({
      rawBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
      hostname: "generativelanguage.googleapis.com",
      pathname: "/v1beta",
      modelId: "gemini-2.5-flash",
      providerName: "Google AI Studio",
    });
    expect(resolveProviderAdapter(ctxGoogle).id).toBe("google");
  });

  describe("URL Ownership and Disabled Adapters", () => {
    it("disabled OpenRouter + providerName 'Google via OpenRouter' -> transparent", () => {
      process.env.PROMPTGATE_DISABLED_PROVIDER_ADAPTERS = "openrouter";
      const ctx = makeContext({
        rawBaseUrl: "https://openrouter.ai/api/v1",
        hostname: "openrouter.ai",
        pathname: "/api/v1",
        modelId: "google/gemini-2.5-flash",
        providerName: "Google via OpenRouter",
      });
      expect(resolveProviderAdapter(ctx).id).toBe("transparent");
    });

    it("disabled OpenRouter + bare Gemini model -> transparent", () => {
      process.env.PROMPTGATE_DISABLED_PROVIDER_ADAPTERS = "openrouter";
      const ctx = makeContext({
        rawBaseUrl: "https://openrouter.ai/api/v1",
        hostname: "openrouter.ai",
        pathname: "/api/v1",
        modelId: "gemini-2.5-flash",
      });
      expect(resolveProviderAdapter(ctx).id).toBe("transparent");
    });

    it("disabled OpenRouter + google/gemini vendor model -> transparent", () => {
      process.env.PROMPTGATE_DISABLED_PROVIDER_ADAPTERS = "openrouter";
      const ctx = makeContext({
        rawBaseUrl: "https://openrouter.ai/api/v1",
        hostname: "openrouter.ai",
        pathname: "/api/v1",
        modelId: "google/gemini-3.1-pro-preview",
      });
      expect(resolveProviderAdapter(ctx).id).toBe("transparent");
    });

    it("disabled Google URL -> transparent", () => {
      process.env.PROMPTGATE_DISABLED_PROVIDER_ADAPTERS = "google";
      const ctx = makeContext({
        rawBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
        hostname: "generativelanguage.googleapis.com",
        pathname: "/v1beta",
        modelId: "gemini-2.5-flash",
        providerName: "Google AI Studio",
      });
      expect(resolveProviderAdapter(ctx).id).toBe("transparent");
    });

    it("真 Google URL + disabled OpenRouter -> Google", () => {
      process.env.PROMPTGATE_DISABLED_PROVIDER_ADAPTERS = "openrouter";
      const ctx = makeContext({
        rawBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
        hostname: "generativelanguage.googleapis.com",
        pathname: "/v1beta",
        modelId: "gemini-2.5-flash",
        providerName: "Google AI Studio",
      });
      expect(resolveProviderAdapter(ctx).id).toBe("google");
    });

    it("未知 URL + bare Gemini -> transparent (legacy fallback removed)", () => {
      process.env.PROMPTGATE_DISABLED_PROVIDER_ADAPTERS = "openrouter";
      const ctx = makeContext({
        rawBaseUrl: "https://api.unknown-proxy.com/v1",
        hostname: "api.unknown-proxy.com",
        pathname: "/v1",
        modelId: "gemini-2.5-flash",
      });
      expect(resolveProviderAdapter(ctx).id).toBe("transparent");
    });
  });

  describe("Enforce Strict Google URL Matching & Registry Constraints", () => {
    it("1. api.openai.com + providerProtocol=google → transparent", () => {
      const ctx = makeContext({
        hostname: "api.openai.com",
        providerProtocol: "google",
      });
      expect(resolveProviderAdapter(ctx).id).toBe("transparent");
    });

    it("2. api.openai.com + gemini-2.5-flash → transparent", () => {
      const ctx = makeContext({
        hostname: "api.openai.com",
        modelId: "gemini-2.5-flash",
      });
      expect(resolveProviderAdapter(ctx).id).toBe("transparent");
    });

    it("3. api.openai.com + google/gemini-* → transparent", () => {
      const ctx = makeContext({
        hostname: "api.openai.com",
        modelId: "google/gemini-2.5-pro",
      });
      expect(resolveProviderAdapter(ctx).id).toBe("transparent");
    });

    it("4. 阿里 URL + providerProtocol=google → transparent", () => {
      const ctx = makeContext({
        rawBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        hostname: "dashscope.aliyuncs.com",
        pathname: "/compatible-mode/v1",
        providerProtocol: "google",
      });
      expect(resolveProviderAdapter(ctx).id).toBe("transparent");
    });

    it("5. 腾讯 URL + gemini模型 → transparent", () => {
      const ctx = makeContext({
        rawBaseUrl: "https://api.hunyuan.cloud.tencent.com/v1",
        hostname: "api.hunyuan.cloud.tencent.com",
        pathname: "/v1",
        modelId: "gemini-2.5-flash",
      });
      expect(resolveProviderAdapter(ctx).id).toBe("transparent");
    });

    it("6. 私有代理 + providerName=Google → transparent", () => {
      const ctx = makeContext({
        rawBaseUrl: "https://llm.internal.example/v1",
        hostname: "llm.internal.example",
        pathname: "/v1",
        providerName: "Google",
      });
      expect(resolveProviderAdapter(ctx).id).toBe("transparent");
    });

    it("7. 真 Google URL + 任意模型 → google", () => {
      const ctx = makeContext({
        rawBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
        hostname: "generativelanguage.googleapis.com",
        pathname: "/v1beta",
        modelId: "custom-model-id",
      });
      expect(resolveProviderAdapter(ctx).id).toBe("google");
    });

    it("8. evilgoogleapis.com → transparent", () => {
      const ctx = makeContext({
        rawBaseUrl: "https://evilgoogleapis.com",
        hostname: "evilgoogleapis.com",
        pathname: "",
        modelId: "gemini-2.5-flash",
      });
      expect(resolveProviderAdapter(ctx).id).toBe("transparent");
    });

    it("9. googleapis.com.example.com → transparent", () => {
      const ctx = makeContext({
        rawBaseUrl: "https://googleapis.com.example.com",
        hostname: "googleapis.com.example.com",
        pathname: "",
        modelId: "gemini-2.5-flash",
      });
      expect(resolveProviderAdapter(ctx).id).toBe("transparent");
    });

    it("静态约束：adaptersRegistry 只包含 google 和 openrouter", () => {
      expect(adaptersRegistry.map(a => a.id).sort()).toStrictEqual(["google", "openrouter"]);
    });

    it("静态约束：resolveProviderAdapter(unknown) -> transparent", () => {
      const ctx = makeContext({
        hostname: "unknown-host.com",
      });
      expect(resolveProviderAdapter(ctx).id).toBe("transparent");
    });

    it("静态约束：扫描 providerAdapters 目录，允许的文件仅包含指定三个 Adapter 文件", () => {
      const dir = path.resolve(__dirname, "../src/routes/gateway/providerAdapters");
      const files = fs.readdirSync(dir);

      const adapterFiles = files.filter(f => f.endsWith("Adapter.ts"));
      expect(adapterFiles.sort()).toStrictEqual([
        "googleAdapter.ts",
        "openRouterAdapter.ts",
        "transparentAdapter.ts"
      ]);
    });
  });
});
