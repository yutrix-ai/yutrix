import { describe, expect, test, vi, beforeEach } from 'vitest';
import { handleGatewayResponse } from '../src/routes/gateway/gatewayResponder';
import { openRouterAdapter } from '../src/routes/gateway/providerAdapters/openRouterAdapter';


vi.mock('../src/routes/gateway/logging', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    isAuditExemptUser: vi.fn().mockResolvedValue(false)
  };
});


vi.mock('../src/services/requestLogService', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    updateRequestLog: vi.fn().mockResolvedValue(true)
  };
});

describe('OpenRouter Non-Stream End-to-End Errors', () => {
  let ctx: any;
  let logAction: any;
  let mockReply: any;
  let replySendArg: any;
  let replyCodeArg: any;

  beforeEach(() => {
    replySendArg = null;
    replyCodeArg = null;

    mockReply = {
      raw: { headersSent: false },
      code: vi.fn().mockImplementation((code) => {
        replyCodeArg = code;
        return mockReply;
      }),
      send: vi.fn().mockImplementation((data) => {
        replySendArg = data;
        return mockReply;
      }),
    };

    logAction = vi.fn();

    ctx = {
      request: { headers: {} },
      reply: mockReply,
      body: {},
      startTime: Date.now(),
      auth: { userId: 'u1', apiKeyRecord: { id: 'k1' } },
      routing: { incomingProtocol: 'openai', reqPath: '/v1/chat/completions' },
      baseActionLog: {},
      reqLogId: 'log1',
      currentAttempt: { modelId: 'test-model' },
      calculateCostForTokens: vi.fn().mockReturnValue(0),
      stream: { promptTokens: 0, completionTokens: 0 },
      routingTrace: [],
      clientDisconnected: false,
    };
  });

  test('OpenAI inbound: Non-stream HTTP 200 with choices[0].finish_reason="error" preserves 200 and exact JSON', async () => {
    const data = {
      id: "123",
      choices: [{
        finish_reason: "error",
        error: { code: 429, message: "Rate limited embedded" }
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5 }
    };

    const state = openRouterAdapter.createAttemptState!({} as any);
    const observation = openRouterAdapter.observeNonStreamResponse!(
      data,
      state,
      {} as any
    );

    const responseData = {
      status: 200,
      isStream: false,
      data, // the raw data
      latencyMs: 100,
      queueMs: 0,
      terminalError: state.terminalError,
      observation
    };

    await handleGatewayResponse(ctx, responseData, logAction);

    // Assert that responseData.status remains 200
    expect(responseData.status).toBe(200);

    // Assert the mockReply receives HTTP code 200 (not 502/429)
    expect(replyCodeArg).toBe(200);

    // Assert original JSON is preserved exactly in reply send
    expect(replySendArg).toEqual(data);

    // Assert logAction receives 'request.non_stream_terminal_error' with business error code, NOT 'request.completed'
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({
      code: "request.non_stream_terminal_error",
      errorCode: "429",
      level: "ERROR"
    }));
    expect(logAction).not.toHaveBeenCalledWith(expect.objectContaining({
      code: "request.completed"
    }));
  });

  test('Anthropic inbound: Non-stream HTTP 200 with error translates to 502/429 Anthropic format', async () => {
    ctx.routing.incomingProtocol = 'anthropic';

    const data = {
      id: "123",
      choices: [{
        finish_reason: "error",
        error: { code: 429, message: "Rate limited embedded" }
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5 }
    };

    const state = openRouterAdapter.createAttemptState!({} as any);
    const observation = openRouterAdapter.observeNonStreamResponse!(
      data,
      state,
      {} as any
    );

    const responseData = {
      status: 200,
      isStream: false,
      data,
      latencyMs: 100,
      queueMs: 0,
      terminalError: state.terminalError,
      observation
    };

    await handleGatewayResponse(ctx, responseData, logAction);

    // It should have changed status to 429 and sent an error payload
    expect(replyCodeArg).toBe(429);

    // Since incomingProtocol is Anthropic, it should format as Anthropic error
    expect(replySendArg).toEqual({
      type: "error",
      error: {
        type: "api_error",
        message: "Rate limited embedded",
        error_type: "upstream_error"
      }
    });

    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({
      code: "request.non_stream_terminal_error",
      errorCode: "429",
      level: "ERROR"
    }));
  });
});
