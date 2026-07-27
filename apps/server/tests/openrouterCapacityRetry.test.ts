import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { executeGatewayRequest } from '../src/routes/gateway/gatewayExecutor';
import { GatewayRequestContext } from '../src/routes/gateway/types';
import * as gatewayResponder from '../src/routes/gateway/gatewayResponder';
import * as requestLogService from '../src/services/requestLogService';
import * as upstream from '../src/routes/gateway/upstream';
import { db } from '../src/db';

vi.mock('../src/routes/gateway/gatewayResponder', () => ({
  handleGatewayResponse: vi.fn(),
}));

vi.mock('../src/services/requestLogService', () => ({
  publishRequestLogUpdate: vi.fn(),
  updateRequestLog: vi.fn(),
  insertRequestLog: vi.fn(),
}));

vi.mock('../src/routes/gateway/upstream', () => ({
  executeUpstreamFetch: vi.fn().mockImplementation(async (...args: any[]) => {
    const callback = args[args.length - 1];
    if (typeof callback === 'function') {
      return callback({} as any, () => {});
    }
    return {
      status: 200,
      isStream: true,
      data: {},
      provider: { name: 'openrouter' },
    };
  }),
  determineUpstreamPath: vi.fn(),
  buildUpstreamHeaders: vi.fn(),
}));

vi.mock('../src/utils/crypto', () => ({
  decryptText: vi.fn().mockReturnValue('mock-decrypted-key'),
  encryptText: vi.fn().mockReturnValue('mock-encrypted-key'),
}));

// Mock db specifically for getting provider and model config
vi.mock('../src/db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue([{
            id: 'openrouter',
            name: 'openrouter',
            enabled: true,
            concurrencyLimit: 10,
            timeoutMs: 10000,
            hourlyTokenLimit: 0
          }]),
        })),
        limit: vi.fn().mockResolvedValue([{
          id: 'openrouter',
          name: 'openrouter',
          enabled: true,
          concurrencyLimit: 10,
          timeoutMs: 10000,
          hourlyTokenLimit: 0
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

vi.mock('../src/db/schema', () => ({
  providers: {},
  providerModels: {},
  providerApiKeys: {},
  apiKeys: {},
  requestLogs: {},
  systemSettings: {},
}));

vi.mock('../src/routes/gateway/concurrency', () => ({
  getGlobalQueue: vi.fn().mockResolvedValue({ add: (fn: any) => fn() }),
  getApiKeyQueue: vi.fn().mockReturnValue({ add: (fn: any) => fn() }),
  getProviderQueue: vi.fn().mockReturnValue({ add: (fn: any) => fn() }),
}));

vi.mock('../src/routes/gateway/fallback', async () => {
  const actual = await vi.importActual<any>('../src/routes/gateway/fallback');
  return {
    ...actual,
    checkConcurrencyFallback: vi.fn().mockResolvedValue(null),
    checkErrorFallback: vi.fn().mockResolvedValue(null),
    processErrorRetryLogic: vi.fn().mockResolvedValue({
      shouldRetrySameProvider: true,
      preserveAttemptCount: true,
      reason: "transient_capacity"
    }),
  };
});

vi.mock('../src/routes/gateway/providerAdapters/registry', () => ({
  resolveProviderAdapterDetailed: vi.fn().mockReturnValue({
    adapter: {
      id: 'openrouter',
      createAttemptState: () => ({ terminalError: null }),
      observeStreamChunk: vi.fn(),
      observeNonStreamResponse: vi.fn(),
    },
    ownerId: 'openrouter',
    disabled: false,
  })
}));

describe('OpenRouter Capacity Retry Scenarios (A-K)', () => {
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
      request: { headers: {}, ip: '127.0.0.1', raw: { off: vi.fn() }, log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } },
      reply: { raw: { writableEnded: false, destroyed: false, end: vi.fn(), write: vi.fn(), off: vi.fn(), headersSent: false }, code: vi.fn().mockReturnThis(), send: vi.fn() },
      body: { messages: [{ role: 'user', content: 'hello' }] },
      startTime: Date.now(),
      auth: {
        userId: 'user-1',
        apiKeyRecord: { id: 'key-1', concurrencyLimit: 10, name: 'Test Key' },
        providedKey: 'sk-test'
      },
      routing: {
        incomingProtocol: 'openai',
        reqPath: '/v1/chat/completions',
        endpoint: { id: 'ep-1' },
        route: { strategyRoutingEnabled: false },
      },
      baseActionLog: { requestId: 'req-1' },
      reqLogId: 'log-1',
      targets: [
        { providerId: 'openrouter', modelId: 'nvidia/nemotron-4-340b-instruct', retryCount: 2 }
      ],
      currentTargetIndex: 0,
      currentAttempt: {
        providerId: 'openrouter',
        providerProtocol: 'openai',
        modelId: 'nvidia/nemotron-4-340b-instruct',
        isFallback: false,
      },
      stream: {
        accumulatedCompletionText: '',
        accumulatedReasoningText: '',
        accumulatedToolArgs: {},
      },
      isStreaming: true,
      inputTokenLimit: {
        maxInputTokens: 0,
        source: 'endpoint',
        sourceLabel: 'ep-1'
      },
      continuity: {
        promptTokens: 0,
        completionTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        usageStatus: 'success',
        committedRoundIds: new Set(),
        forwardedStreamText: '',
        hiddenContinuityText: '',
        accumulatedCompletionText: '',
        hasStartedContinuity: false,
        hasForwardedStreamMaterial: false,
        streamRoundCount: 1,
      },
      calculateCostForTokens: vi.fn().mockReturnValue(0),
      routingTrace: [],
    };

    // Mock active keys list to have multiple keys available
    (db.select as any).mockImplementation((schema: any) => ({
      from: vi.fn(() => ({
        where: vi.fn().mockImplementation((condition: any) => ({
           limit: vi.fn().mockImplementation(() => {
             // If we're mocking the systemSettings for audit
             if (schema && schema.name === 'system_settings') {
               return Promise.resolve([{ value: '' }]); // No exempt users
             }
             return Promise.resolve([]);
           }),
           then: (resolve: any) => {
             // Default for when limit() isn't called, e.g. getting keys
             // Use valid format iv:authTag:encryptedData for decryptText to avoid error, although we don't care about the real decrypted value
             resolve([
               { id: 'key-1', keyEncrypted: '000000000000000000000000:00000000000000000000000000000000:0000', status: 'active' },
               { id: 'key-2', keyEncrypted: '000000000000000000000000:00000000000000000000000000000000:0000', status: 'active' }
             ]);
           }
        })),
        limit: vi.fn().mockImplementation(() => {
           if (schema && schema.name === 'system_settings') {
             return Promise.resolve([{ value: '' }]);
           }
           return Promise.resolve([]);
        })
      }))
    }));
  });

  it('Scenario A: Transient error before meaningful content triggers retry', async () => {
    // We mock handleGatewayResponse to return a retryable terminal error without meaningfulClientOutputSent
    (gatewayResponder.handleGatewayResponse as any)
      .mockResolvedValueOnce({
        isLengthTruncated: false,
        terminalError: {
          errorType: "upstream_capacity_error",
          statusCode: 503,
          code: "provider_capacity_exhausted",
          adapterId: "openrouter",
          message: "Upstream error from Nvidia: ResourceExhausted: Worker local total request limit reached (79/32)",
          retryable: true,
          retryClass: "provider_capacity",
          metadata: { provider: "Nvidia" }
        },
        terminalEventSent: false,
        meaningfulClientOutputSent: false
      })
      .mockResolvedValueOnce({
        isLengthTruncated: false,
        terminalError: undefined,
        terminalEventSent: false,
        meaningfulClientOutputSent: true
      });

    try {
      await executeGatewayRequest(ctx, controller, 2, logAction, abortHandlers);
    } catch (e: any) {
      console.error("Test caught error:", e);
    }

    // Should have retried once, so handleGatewayResponse called twice
    expect(gatewayResponder.handleGatewayResponse).toHaveBeenCalledTimes(2);
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({
      code: "request.upstream_retry",
      reason: "provider_capacity"
    }));
  });

  it('Scenario B: Transient error after meaningful content prevents retry', async () => {
    // If meaningfulClientOutputSent is true, handleGatewayResponse should return it, and executor should NOT retry
    (gatewayResponder.handleGatewayResponse as any)
      .mockResolvedValueOnce({
        isLengthTruncated: false,
        terminalError: {
          errorType: "upstream_capacity_error",
          code: "provider_capacity_exhausted",
          adapterId: "openrouter",
          message: "Upstream error from Nvidia: ResourceExhausted",
          retryable: true,
          retryClass: "provider_capacity",
        },
        terminalEventSent: true, // If we sent content, we likely sent the event or it's too late
        meaningfulClientOutputSent: true
      });

    await executeGatewayRequest(ctx, controller, 2, logAction, abortHandlers);

    // Should NOT retry, so handleGatewayResponse called once
    expect(gatewayResponder.handleGatewayResponse).toHaveBeenCalledTimes(1);

    // The executor logic we added specifically checks for !meaningfulClientOutputSent
    // If it's true, it skips the retry block and proceeds to finalization.
    expect(logAction).not.toHaveBeenCalledWith(expect.objectContaining({
      code: "request.upstream_retry",
      reason: "transient_capacity"
    }));
  });

  it('Scenario C: Non-retryable error never retries', async () => {
    (gatewayResponder.handleGatewayResponse as any)
      .mockResolvedValueOnce({
        isLengthTruncated: false,
        terminalError: {
          errorType: "upstream_server_error",
          statusCode: 500,
          message: "Internal Server Error",
          retryable: false,
        },
        terminalEventSent: true,
        meaningfulClientOutputSent: false
      });

    await executeGatewayRequest(ctx, controller, 2, logAction, abortHandlers);

    expect(gatewayResponder.handleGatewayResponse).toHaveBeenCalledTimes(1);
    expect(logAction).not.toHaveBeenCalledWith(expect.objectContaining({
      code: "request.upstream_retry",
    }));
  });
});
