import { describe, it, expect } from "vitest";
import { buildUpstreamHeaders } from "../src/routes/gateway/upstream";
import { openRouterAdapter } from "../src/routes/gateway/providerAdapters/openRouterAdapter";
import { ProviderAdapterContext } from "../src/routes/gateway/providerAdapters/types";

describe("buildUpstreamHeaders for Anthropic / OpenRouter passthrough", () => {
  const decryptedKey = "test-provider-key";
  const dummyContext: ProviderAdapterContext = {
    providerId: "openrouter",
    providerName: "OpenRouter",
    // Native Anthropic surface: selected base URL bound as anthropic
    providerProtocol: "anthropic",
    rawBaseUrl: "https://openrouter.ai/api/v1",
    normalizedBaseUrl: "https://openrouter.ai/api/v1",
    hostname: "openrouter.ai",
    pathname: "/api/v1",
    modelId: "anthropic/claude-3.5-sonnet",
    incomingProtocol: "anthropic",
    requestPath: "/v1/messages",
    clientHeaders: {}
  };

  it("passes through anthropic-version, anthropic-beta, x-anthropic-client, user-agent", () => {
    const clientHeaders = {
      "anthropic-version": "2023-01-01",
      "anthropic-beta": "tools-2024-04-04",
      "x-anthropic-client": "test-client",
      "user-agent": "test-agent/1.0"
    };

    const baseHeaders = buildUpstreamHeaders(decryptedKey, true, "/v1/messages");
    const result = openRouterAdapter.adaptUpstreamHeaders!({ ...dummyContext, clientHeaders }, baseHeaders)!;

    expect(result["anthropic-version"]).toBe("2023-01-01");
    expect(result["anthropic-beta"]).toBe("tools-2024-04-04");
    expect(result["x-anthropic-client"]).toBe("test-client");
    expect(result["user-agent"]).toBe("test-agent/1.0");
  });

  it("rebuilds x-api-key from provider API key and strips client x-api-key / authorization", () => {
    const clientHeaders = {
      "x-api-key": "client-malicious-key",
      "authorization": "Bearer client-malicious-token"
    };

    const resultAnthropic = buildUpstreamHeaders(decryptedKey, true, "/v1/messages");
    const finalAnthropic = openRouterAdapter.adaptUpstreamHeaders!({ ...dummyContext, clientHeaders }, resultAnthropic)!;
    expect(finalAnthropic["authorization"]).toBe(`Bearer ${decryptedKey}`);
    expect(finalAnthropic["x-api-key"]).toBeUndefined();

    const resultNonAnthropic = buildUpstreamHeaders(decryptedKey, false, "/v1/messages");
    const finalNonAnthropic = openRouterAdapter.adaptUpstreamHeaders!({ ...dummyContext, clientHeaders }, resultNonAnthropic)!;
    expect(finalNonAnthropic["Authorization"]).toBe(`Bearer ${decryptedKey}`);
    expect(finalNonAnthropic["x-api-key"]).toBeUndefined();
  });

  it("excludes hop-by-hop headers", () => {
    const clientHeaders = {
      "connection": "keep-alive",
      "keep-alive": "timeout=5",
      "proxy-authenticate": "Basic",
      "proxy-authorization": "Basic xyz",
      "te": "trailers",
      "trailer": "Max-Forwards",
      "transfer-encoding": "chunked",
      "upgrade": "HTTP/2.0",
      "host": "localhost:3000",
      "content-length": "123",
      "x-custom-header": "allowed"
    };

    const baseHeaders = buildUpstreamHeaders(decryptedKey, true, "/v1/messages");
    const result = openRouterAdapter.adaptUpstreamHeaders!({ ...dummyContext, clientHeaders }, baseHeaders)!;

    expect(result["connection"]).toBeUndefined();
    expect(result["keep-alive"]).toBeUndefined();
    expect(result["proxy-authenticate"]).toBeUndefined();
    expect(result["proxy-authorization"]).toBeUndefined();
    expect(result["te"]).toBeUndefined();
    expect(result["trailer"]).toBeUndefined();
    expect(result["transfer-encoding"]).toBeUndefined();
    expect(result["upgrade"]).toBeUndefined();
    expect(result["host"]).toBeUndefined();
    expect(result["content-length"]).toBeUndefined();
    expect(result["x-custom-header"]).toBeUndefined(); // Only whitelisted headers allowed
  });

  it("preserves multiple/comma-separated anthropic-beta values", () => {
    const clientHeadersArray = {
      "anthropic-beta": ["beta-1", "beta-2"]
    } as any;
    const baseHeaders = buildUpstreamHeaders(decryptedKey, true, "/v1/messages");
    const resultArray = openRouterAdapter.adaptUpstreamHeaders!({ ...dummyContext, clientHeaders: clientHeadersArray }, baseHeaders)!;
    expect(resultArray["anthropic-beta"]).toBe("beta-1, beta-2");

    const clientHeadersString = {
      "anthropic-beta": "beta-1, beta-2"
    };
    const resultString = openRouterAdapter.adaptUpstreamHeaders!({ ...dummyContext, clientHeaders: clientHeadersString }, baseHeaders)!;
    expect(resultString["anthropic-beta"]).toBe("beta-1, beta-2");
  });

  it("defaults anthropic-version to 2023-06-01 if missing", () => {
    const baseHeaders = buildUpstreamHeaders(decryptedKey, true, "/v1/messages");
    const result = openRouterAdapter.adaptUpstreamHeaders!({ ...dummyContext, clientHeaders: {} }, baseHeaders)!;
    expect(result["anthropic-version"]).toBe("2023-06-01");
  });
});
