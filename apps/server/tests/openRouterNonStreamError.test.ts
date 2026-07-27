import { describe, expect, test, vi, beforeEach } from 'vitest';
import { handleGatewayResponse } from '../src/routes/gateway/gatewayResponder';
import { openRouterAdapter } from '../src/routes/gateway/providerAdapters/openRouterAdapter';

describe('OpenRouter Non-Stream Errors and Reasoning', () => {
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
      routing: { incomingProtocol: 'anthropic', reqPath: '/v1/messages' },
      baseActionLog: {},
      reqLogId: 'log1',
      currentAttempt: { modelId: 'test-model' },
      calculateCostForTokens: vi.fn().mockReturnValue(0),
      stream: { promptTokens: 0, completionTokens: 0 },
      routingTrace: [],
      clientDisconnected: false,
    };
  });

  test('Non-stream HTTP 200 with choices[0].finish_reason="error" acts as error', async () => {
    // 1. Simulate the fetch response logic in upstream.ts calling adapter.observeNonStreamResponse
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

    // It should have changed transport status to 429 and sent an error payload
    expect(replyCodeArg).toBe(429);

    // Since incomingProtocol is Anthropic, it should format as Anthropic error
    expect(replySendArg).toEqual({
      type: "error",
      error: {
        type: "api_error",
        message: "Rate limited embedded",
        error_type: "upstream_error" // it builds it from 429
      }
    });

    // We shouldn't have logged request.completed
    expect(logAction).not.toHaveBeenCalledWith(expect.objectContaining({
      code: "request.completed"
    }));
  });

  test('Non-stream reasoning correctly observed', async () => {
    const data = {
      id: "123",
      choices: [{
        message: {
          role: "assistant",
          content: "Final answer",
          reasoning_content: "My thoughts"
        },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5 }
    };

    const state = openRouterAdapter.createAttemptState!({} as any);
    const observation = openRouterAdapter.observeNonStreamResponse!(
      data,
      state,
      {} as any
    );

    expect(observation?.meaningful).toBe(true);
    expect(observation?.reasoningText).toBe("My thoughts");
    expect(state.terminalError).toBeFalsy();
  });
});
