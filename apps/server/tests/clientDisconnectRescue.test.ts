import { describe, it, expect, vi, beforeEach } from "vitest";
import { executeGatewayRequest } from "../src/routes/gateway/gatewayExecutor";
import * as gatewayResponder from "../src/routes/gateway/gatewayResponder";
import * as fallback from "../src/routes/gateway/fallback";
import * as upstream from "../src/routes/gateway/upstream";
import { db } from "../src/db";
import {
  CLIENT_CLOSED_CODE,
  CLIENT_CLOSED_ERROR_TYPE,
  CLIENT_CLOSED_RETRY_CLASS,
  CLIENT_CLOSED_STATUS,
  DOWNSTREAM_CONNECTION_CLOSED_MESSAGE,
} from "../src/routes/gateway/clientClosed";
import { renderActionLogServerLine } from "../src/utils/actionLogTemplates";

vi.mock("../src/routes/gateway/gatewayResponder", () => ({
  handleGatewayResponse: vi.fn(),
}));

vi.mock("../src/services/requestLogService", () => ({
  publishRequestLogUpdate: vi.fn(),
  updateRequestLog: vi.fn(),
  insertRequestLog: vi.fn(),
}));

vi.mock("../src/routes/gateway/upstream", () => ({
  executeUpstreamFetch: vi.fn().mockImplementation(async (...args: any[]) => {
    const callback = args[args.length - 1];
    if (typeof callback === "function") {
      return callback({} as any, () => {});
    }
    return {
      status: 200,
      isStream: true,
      data: {},
      provider: { name: "Antigravity_US1" },
    };
  }),
  determineUpstreamPath: vi.fn(),
  buildUpstreamHeaders: vi.fn(),
}));

vi.mock("../src/utils/crypto", () => ({
  decryptText: vi.fn().mockReturnValue("mock-decrypted-key"),
  encryptText: vi.fn().mockReturnValue("mock-encrypted-key"),
}));

vi.mock("../src/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue([{
            id: "antigravity",
            name: "Antigravity_US1",
            enabled: true,
            concurrencyLimit: 10,
            timeoutMs: 10000,
            hourlyTokenLimit: 0,
          }]),
          then: (resolve: any) => {
            resolve([
              { id: "key-1", keyEncrypted: "000000000000000000000000:00000000000000000000000000000000:0000", status: "active" },
              { id: "key-2", keyEncrypted: "000000000000000000000000:00000000000000000000000000000000:0000", status: "active" },
            ]);
          },
        })),
        limit: vi.fn().mockResolvedValue([{
          id: "antigravity",
          name: "Antigravity_US1",
          enabled: true,
          concurrencyLimit: 10,
          timeoutMs: 10000,
          hourlyTokenLimit: 0,
        }]),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          execute: vi.fn().mockResolvedValue({}),
        })),
      })),
    })),
  },
}));

vi.mock("../src/db/schema", () => ({
  providers: {},
  providerModels: {},
  providerApiKeys: {},
  apiKeys: {},
  requestLogs: {},
  systemSettings: {},
}));

vi.mock("../src/routes/gateway/concurrency", () => ({
  getGlobalQueue: vi.fn().mockResolvedValue({ add: (fn: any) => fn() }),
  getApiKeyQueue: vi.fn().mockReturnValue({ add: (fn: any) => fn() }),
  getProviderQueue: vi.fn().mockReturnValue({ add: (fn: any) => fn() }),
}));

vi.mock("../src/routes/gateway/fallback", async () => {
  const actual = await vi.importActual<any>("../src/routes/gateway/fallback");
  return {
    ...actual,
    checkConcurrencyFallback: vi.fn().mockResolvedValue(null),
    checkErrorFallback: vi.fn().mockResolvedValue(null),
  };
});

vi.mock("../src/routes/gateway/providerAdapters/registry", () => ({
  resolveProviderAdapterDetailed: vi.fn().mockReturnValue({
    adapter: {
      id: "transparent",
      createAttemptState: () => ({ terminalError: null }),
      observeStreamChunk: vi.fn(),
      observeNonStreamResponse: vi.fn(),
    },
    ownerId: "transparent",
    disabled: false,
  }),
}));

const DEEPSEEK_ATTEMPT = {
  providerId: "deepseek",
  providerProtocol: "openai",
  modelId: "deepseek-v4-flash",
  promptPolicyId: null,
  isFallback: true,
  fallbackReason: "502 触发降级",
  targetIndex: 1,
};

function availabilityTerminal(statusCode: number, message: string) {
  return {
    statusCode,
    errorType: "upstream_error",
    code: "upstream_error",
    message,
    retryable: false,
    retryClass: "unknown",
    adapterId: "transparent",
  };
}

function clientClosedTerminal(message = DOWNSTREAM_CONNECTION_CLOSED_MESSAGE) {
  return {
    statusCode: CLIENT_CLOSED_STATUS,
    errorType: CLIENT_CLOSED_ERROR_TYPE,
    code: CLIENT_CLOSED_CODE,
    message,
    retryable: false,
    retryClass: CLIENT_CLOSED_RETRY_CLASS,
    adapterId: "transparent",
  };
}

describe("executeGatewayRequest refuses rescue after client disconnect", () => {
  let ctx: any;
  let controller: AbortController;
  let logAction: any;
  let abortHandlers: any;

  beforeEach(() => {
    vi.clearAllMocks();
    controller = new AbortController();
    logAction = vi.fn();
    abortHandlers = {
      abortUpstream: vi.fn(),
      abortOnRequestClose: vi.fn(),
      abortOnReplyClose: vi.fn(),
    };

    ctx = {
      request: {
        headers: {},
        ip: "127.0.0.1",
        raw: { off: vi.fn(), destroyed: false, closed: false },
        log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
      },
      reply: {
        raw: {
          writableEnded: false,
          destroyed: false,
          end: vi.fn(),
          write: vi.fn(),
          off: vi.fn(),
          headersSent: false,
        },
        code: vi.fn().mockReturnThis(),
        send: vi.fn(),
      },
      body: { messages: [{ role: "user", content: "hello" }] },
      startTime: Date.now(),
      auth: {
        userId: "user-1",
        apiKeyRecord: { id: "key-1", concurrencyLimit: 10, name: "Test Key" },
        providedKey: "sk-test",
      },
      routing: {
        incomingProtocol: "anthropic",
        reqPath: "/v1/messages",
        endpoint: { id: "ep-1" },
        route: { strategyRoutingEnabled: false },
      },
      baseActionLog: { requestId: "req-client-closed" },
      reqLogId: "log-1",
      targets: [
        { providerId: "antigravity", modelId: "gemini-3.7-flash-high", retryCount: 2 },
      ],
      currentTargetIndex: 0,
      currentAttempt: {
        providerId: "antigravity",
        providerProtocol: "openai",
        modelId: "gemini-3.7-flash-high",
        isFallback: false,
      },
      stream: {
        accumulatedCompletionText: "",
        accumulatedReasoningText: "",
        accumulatedToolArgs: {},
        estimatedPromptTokens: 10,
        gotFirstChunk: false,
        promptTokens: 0,
        completionTokens: 0,
      },
      isStreaming: true,
      clientDisconnected: false,
      streamLogFinalized: false,
      userRole: "user",
      inputTokenLimit: {
        maxInputTokens: 0,
        source: "endpoint",
        sourceLabel: "ep-1",
      },
      continuity: {
        promptTokens: 0,
        completionTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        usageStatus: "success",
        committedRoundIds: new Set(),
        forwardedStreamText: "",
        hiddenContinuityText: "",
        accumulatedCompletionText: "",
        hasStartedContinuity: false,
        hasForwardedStreamMaterial: false,
        streamRoundCount: 1,
      },
      calculateCostForTokens: vi.fn().mockReturnValue(0),
      routingTrace: [],
    };

    (db.select as any).mockImplementation((schema: any) => ({
      from: vi.fn(() => ({
        where: vi.fn().mockImplementation(() => ({
          limit: vi.fn().mockImplementation(() => {
            if (schema && schema.name === "system_settings") {
              return Promise.resolve([{ value: "" }]);
            }
            return Promise.resolve([{
              id: "antigravity",
              name: "Antigravity_US1",
              enabled: true,
              concurrencyLimit: 10,
              timeoutMs: 10000,
              hourlyTokenLimit: 0,
            }]);
          }),
          then: (resolve: any) => {
            resolve([
              { id: "key-1", keyEncrypted: "000000000000000000000000:00000000000000000000000000000000:0000", status: "active" },
              { id: "key-2", keyEncrypted: "000000000000000000000000:00000000000000000000000000000000:0000", status: "active" },
            ]);
          },
        })),
        limit: vi.fn().mockImplementation(() => {
          if (schema && schema.name === "system_settings") {
            return Promise.resolve([{ value: "" }]);
          }
          return Promise.resolve([{
            id: "antigravity",
            name: "Antigravity_US1",
            enabled: true,
            concurrencyLimit: 10,
            timeoutMs: 10000,
            hourlyTokenLimit: 0,
          }]);
        }),
      })),
    }));
  });

  function logPayloads() {
    return logAction.mock.calls.map((call: any[]) => call[0]);
  }

  function expectNoRescue() {
    expect(fallback.checkErrorFallback).not.toHaveBeenCalled();
    expect(upstream.executeUpstreamFetch).toHaveBeenCalledTimes(1);
    expect(logPayloads().some((e: any) => e.reason === "stream_availability_funnel_fallback")).toBe(false);
  }

  function expectTerminalLogHasMessage() {
    const payloads = logPayloads();
    const terminal = payloads.find((e: any) =>
      e.code === "request.completed"
      || e.code === "request.client_closed"
      || e.code === "request.provider_adapter.stream_error"
    );
    expect(terminal).toBeDefined();
    expect(String(terminal.message || "").trim()).not.toBe("");
    expect(String(terminal.message)).not.toBe("undefined");
    const line = renderActionLogServerLine(
      { ...terminal, id: "1", timestamp: "2026-08-27 09:49:11", params: {}, serverLine: "" } as any,
      "2026-08-27 09:49:11",
    );
    expect(line).not.toContain("msg=undefined");
  }

  it("does not funnel-fallback or fetch again for a client-closed stream terminal", async () => {
    (gatewayResponder.handleGatewayResponse as any).mockResolvedValueOnce({
      isLengthTruncated: false,
      terminalError: clientClosedTerminal(),
      terminalEventSent: false,
      meaningfulClientOutputSent: false,
    });

    await executeGatewayRequest(ctx, controller, 2, logAction, abortHandlers);

    expect(gatewayResponder.handleGatewayResponse).toHaveBeenCalledTimes(1);
    expectNoRescue();
    expectTerminalLogHasMessage();
  });

  it("does not start a fetch when the parent abort is already signaled before the first attempt", async () => {
    controller.abort();
    ctx.clientDisconnected = true;

    await executeGatewayRequest(ctx, controller, 2, logAction, abortHandlers);

    expect(fallback.checkErrorFallback).not.toHaveBeenCalled();
    expect(upstream.executeUpstreamFetch).toHaveBeenCalledTimes(0);
    expect(gatewayResponder.handleGatewayResponse).not.toHaveBeenCalled();
    expect(logPayloads().some((e: any) => e.reason === "stream_availability_funnel_fallback")).toBe(false);
    expectTerminalLogHasMessage();
  });

  it("does not rescue a 502-looking stream error when abort/disconnect is already set", async () => {
    (gatewayResponder.handleGatewayResponse as any).mockImplementation(async () => {
      controller.abort();
      ctx.clientDisconnected = true;
      return {
        isLengthTruncated: false,
        terminalError: availabilityTerminal(502, "Bad Gateway"),
        terminalEventSent: false,
        meaningfulClientOutputSent: false,
      };
    });

    await executeGatewayRequest(ctx, controller, 2, logAction, abortHandlers);

    expect(gatewayResponder.handleGatewayResponse).toHaveBeenCalledTimes(1);
    expectNoRescue();
    expectTerminalLogHasMessage();
  });

  it("does not start a new fetch when the parent abort is already signaled before the next attempt", async () => {
    (gatewayResponder.handleGatewayResponse as any).mockResolvedValueOnce({
      isLengthTruncated: false,
      terminalError: availabilityTerminal(502, "Bad Gateway"),
      terminalEventSent: false,
      meaningfulClientOutputSent: false,
    });
    (fallback.checkErrorFallback as any).mockImplementation(async () => {
      controller.abort();
      ctx.clientDisconnected = true;
      return { newAttempt: { ...DEEPSEEK_ATTEMPT } };
    });

    await executeGatewayRequest(ctx, controller, 2, logAction, abortHandlers);

    expect(fallback.checkErrorFallback).toHaveBeenCalledTimes(1);
    expect(upstream.executeUpstreamFetch).toHaveBeenCalledTimes(1);
    expect(logPayloads().some((e: any) => e.reason === "stream_availability_funnel_fallback")).toBe(true);
  });

  it("still hops on a real stream 502 while the client is connected", async () => {
    (gatewayResponder.handleGatewayResponse as any)
      .mockResolvedValueOnce({
        isLengthTruncated: false,
        terminalError: availabilityTerminal(502, "Bad Gateway"),
        terminalEventSent: false,
        meaningfulClientOutputSent: false,
      })
      .mockResolvedValueOnce({
        isLengthTruncated: false,
        terminalError: undefined,
        terminalEventSent: false,
        meaningfulClientOutputSent: true,
      });
    (fallback.checkErrorFallback as any).mockResolvedValueOnce({
      newAttempt: { ...DEEPSEEK_ATTEMPT },
    });

    await executeGatewayRequest(ctx, controller, 2, logAction, abortHandlers);

    expect(fallback.checkErrorFallback).toHaveBeenCalledTimes(1);
    expect(upstream.executeUpstreamFetch).toHaveBeenCalledTimes(2);
    expect(logPayloads().some((e: any) => e.reason === "stream_availability_funnel_fallback")).toBe(true);
  });

  it("still hops on a real stream 504 timeout while the client is connected", async () => {
    (gatewayResponder.handleGatewayResponse as any)
      .mockResolvedValueOnce({
        isLengthTruncated: false,
        terminalError: availabilityTerminal(504, "Stream chunk timeout"),
        terminalEventSent: false,
        meaningfulClientOutputSent: false,
      })
      .mockResolvedValueOnce({
        isLengthTruncated: false,
        terminalError: undefined,
        terminalEventSent: false,
        meaningfulClientOutputSent: true,
      });
    (fallback.checkErrorFallback as any).mockResolvedValueOnce({
      newAttempt: { ...DEEPSEEK_ATTEMPT },
    });

    await executeGatewayRequest(ctx, controller, 2, logAction, abortHandlers);

    expect(fallback.checkErrorFallback).toHaveBeenCalledTimes(1);
    expect(upstream.executeUpstreamFetch).toHaveBeenCalledTimes(2);
    expect(logPayloads().some((e: any) => e.reason === "stream_availability_funnel_fallback")).toBe(true);
  });
});
