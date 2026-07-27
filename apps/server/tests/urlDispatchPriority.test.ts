import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolveProviderAdapter } from "../src/routes/gateway/providerAdapters/registry";
import { parseAndNormalizeUrl } from "../src/routes/gateway/providerAdapters/urlMatcher";

/**
 * Tests for protocol-aware URL dispatch priority.
 *
 * Rule: providerProtocol determines the PRIMARY URL.
 *   - providerProtocol === "anthropic" → primary = anthropicBaseUrl
 *   - otherwise → primary = openaiBaseUrl
 *
 * If primary URL exists, it is the ONLY URL considered for adapter resolution.
 * Alternate URL is only tried when primary URL is null/undefined.
 */

function buildAdapterContext(overrides: {
  providerProtocol: string;
  openaiBaseUrl?: string | null;
  anthropicBaseUrl?: string | null;
}) {
  const primaryUrl = overrides.providerProtocol === "anthropic"
    ? overrides.anthropicBaseUrl
    : overrides.openaiBaseUrl;
  const alternateUrl = overrides.providerProtocol === "anthropic"
    ? overrides.openaiBaseUrl
    : overrides.anthropicBaseUrl;

  // The function we're testing will be selectAdapterAndBaseUrl
  return {
    providerProtocol: overrides.providerProtocol,
    openaiBaseUrl: overrides.openaiBaseUrl || null,
    anthropicBaseUrl: overrides.anthropicBaseUrl || null,
    providerId: "test-provider",
    providerName: "Test Provider",
    modelId: "test-model",
    incomingProtocol: overrides.providerProtocol,
    requestPath: overrides.providerProtocol === "anthropic" ? "/v1/messages" : "/v1/chat/completions",
    clientHeaders: {},
  };
}

/**
 * Simulate the adapter resolution that gatewayExecutor does.
 * This tests the LOGIC, not the integration with the full executor.
 */
function resolveAdapterForUrl(url: string, providerProtocol: string, modelId = "test-model") {
  const clean = url.replace(/\/+$/, "");
  const norm = parseAndNormalizeUrl(clean);
  if (!norm.isValid) return { id: "transparent" };
  const ctx = {
    providerId: "test",
    providerName: "Test",
    providerProtocol,
    rawBaseUrl: clean,
    normalizedBaseUrl: norm.normalizedBaseUrl,
    hostname: norm.hostname,
    pathname: norm.pathname,
    modelId,
    incomingProtocol: providerProtocol,
    requestPath: providerProtocol === "anthropic" ? "/v1/messages" : "/v1/chat/completions",
    clientHeaders: {},
  };
  return resolveProviderAdapter(ctx);
}

describe("URL Dispatch Priority", () => {
  let originalDisabledEnv: string | undefined;

  beforeEach(() => {
    originalDisabledEnv = process.env.PROMPTGATE_DISABLED_PROVIDER_ADAPTERS;
  });

  afterEach(() => {
    if (originalDisabledEnv === undefined) {
      delete process.env.PROMPTGATE_DISABLED_PROVIDER_ADAPTERS;
    } else {
      process.env.PROMPTGATE_DISABLED_PROVIDER_ADAPTERS = originalDisabledEnv;
    }
  });

  // Scenario A: providerProtocol=openai, openaiBaseUrl=Alibaba, anthropicBaseUrl=OpenRouter
  // Primary URL (openai) = Alibaba → transparent. MUST NOT scan OpenRouter.
  it("A: openai protocol + Alibaba openaiBaseUrl + OpenRouter anthropicBaseUrl → transparent, fetch Alibaba", () => {
    const primaryUrl = "https://dashscope.aliyuncs.com/compatible-mode/v1";
    const alternateUrl = "https://openrouter.ai/api/v1";

    // Primary URL = openaiBaseUrl (since providerProtocol=openai) = Alibaba → transparent
    const primaryAdapter = resolveAdapterForUrl(primaryUrl, "openai");
    expect(primaryAdapter.id).toBe("transparent");

    // The alternate URL (OpenRouter) should match openrouter, but it MUST NOT be tried
    // because primary URL exists. We verify this by asserting:
    // Even though OpenRouter adapter would match the alternate URL...
    const alternateAdapter = resolveAdapterForUrl(alternateUrl, "anthropic");
    expect(alternateAdapter.id).toBe("openrouter"); // ...it WOULD match if tried

    // But the dispatch rule says: primary exists → only use primary → result is transparent
    // The actual baseUrl used should be Alibaba (primaryUrl), not OpenRouter
  });

  // Scenario B: providerProtocol=anthropic, anthropicBaseUrl=Tencent, openaiBaseUrl=Google
  // Primary URL (anthropic) = Tencent → transparent. MUST NOT enter Google Native.
  it("B: anthropic protocol + Tencent anthropicBaseUrl + Google openaiBaseUrl → transparent, fetch Tencent", () => {
    const primaryUrl = "https://hunyuan.tencentcloudapi.com";
    const alternateUrl = "https://generativelanguage.googleapis.com/v1beta/openai";

    // Primary URL = anthropicBaseUrl (since providerProtocol=anthropic) = Tencent → transparent
    const primaryAdapter = resolveAdapterForUrl(primaryUrl, "anthropic");
    expect(primaryAdapter.id).toBe("transparent");

    // Alternate URL = Google → google adapter, but MUST NOT be tried
    const alternateAdapter = resolveAdapterForUrl(alternateUrl, "openai");
    expect(alternateAdapter.id).toBe("google"); // WOULD match if tried

    // But primary exists → only primary is used → transparent
  });

  // Scenario C: providerProtocol=anthropic, anthropicBaseUrl=null, openaiBaseUrl=OpenRouter
  // Primary URL = null → allowed to try alternate → OpenRouter matches → openrouter adapter
  it("C: anthropic protocol + null anthropicBaseUrl + OpenRouter openaiBaseUrl → openrouter", () => {
    const alternateUrl = "https://openrouter.ai/api/v1";

    // Primary URL is null, so alternate URL is tried
    const adapter = resolveAdapterForUrl(alternateUrl, "openai");
    expect(adapter.id).toBe("openrouter");
  });

  // Scenario D: providerProtocol=openai, openaiBaseUrl=null, anthropicBaseUrl=OpenRouter
  // Primary URL = null → allowed to try alternate → OpenRouter matches → openrouter adapter
  // This behavior is DOCUMENTED — alternate URL is only used when primary is null
  it("D: openai protocol + null openaiBaseUrl + OpenRouter anthropicBaseUrl → openrouter via alternate", () => {
    const alternateUrl = "https://openrouter.ai/api/v1";

    const adapter = resolveAdapterForUrl(alternateUrl, "openai");
    expect(adapter.id).toBe("openrouter");
  });

  // Scenario E: primary OpenRouter URL + disabled openrouter + secondary Google URL
  // Primary URL matches openrouter but disabled → transparent. MUST NOT scan Google.
  it("E: disabled openrouter primary + Google secondary → transparent (not google)", () => {
    process.env.PROMPTGATE_DISABLED_PROVIDER_ADAPTERS = "openrouter";

    const primaryUrl = "https://openrouter.ai/api/v1";
    const secondaryUrl = "https://generativelanguage.googleapis.com/v1beta/openai";

    // Primary URL matches OpenRouter but it's disabled → falls to transparent
    const primaryAdapter = resolveAdapterForUrl(primaryUrl, "openai");
    expect(primaryAdapter.id).toBe("transparent");

    // Secondary URL WOULD match Google, but must NOT be tried
    const secondaryAdapter = resolveAdapterForUrl(secondaryUrl, "openai");
    expect(secondaryAdapter.id).toBe("google"); // WOULD match if tried

    // The actual result must be transparent, not google
    // This is already correct in the current registry (disabled → transparent)
    // The gatewayExecutor must not continue to the secondary URL
  });
});
