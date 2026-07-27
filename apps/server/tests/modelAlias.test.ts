import { describe, expect, it } from "vitest";
import { withPublicModelName } from "../src/utils/modelAlias";
import { buildBaseLog } from "../src/routes/gateway/logging";

describe("model alias redaction", () => {
  it("uses aliases for public realtime log payloads", async () => {
    const payload = await withPublicModelName({
      id: "log-1",
      providerId: "provider-1",
      model: "gemma-4-31b-it",
      alias: "Qwen3.6-27B",
    });

    expect(payload.model).toBe("Qwen3.6-27B");
    expect(payload).not.toHaveProperty("alias");
  });

  it("keeps alias on gateway base logs for the first queued event", () => {
    const baseLog = buildBaseLog({
      reqLogId: "log-1",
      baseActionLog: { requestId: "request-1" },
      auth: {
        userId: "user-1",
        apiKeyRecord: { id: "api-key-1" },
      },
      routing: {
        endpoint: { id: "endpoint-1" },
        subdomainRecord: null,
      },
      currentAttempt: {
        providerProtocol: "openai",
        modelId: "gemma-4-31b-it",
      },
      activeModelConfig: {
        alias: "Qwen3.6-27B",
      },
      request: {
        ip: "127.0.0.1",
      },
      isStreaming: true,
    } as any, { id: "provider-1" });

    expect(baseLog.model).toBe("gemma-4-31b-it");
    expect(baseLog.alias).toBe("Qwen3.6-27B");
  });
});
