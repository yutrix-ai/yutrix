import { describe, it, expect } from 'vitest';
import { MaxTokensTruncationStrategy } from '../src/services/continuity/strategies/MaxTokensTruncationStrategy';
import { ContinuityContext } from '../src/services/continuity/types';

describe('MaxTokensTruncationStrategy continuation body', () => {
  const strategy = new MaxTokensTruncationStrategy();

  it('does not inject system role in continuation messages', async () => {
    const context: ContinuityContext = {
      originalBody: {
        model: 'claude-3-5-sonnet-20241022',
        system: 'You are a helpful assistant.',
        messages: [{ role: 'user', content: 'Write a long essay about AI.' }],
        max_tokens: 100,
      },
      responseData: { data: { stop_reason: 'max_tokens' } },
      streamResult: { isLengthTruncated: true },
      accumulatedCompletionText: 'This is the first part of the essay about AI. It covers the history',
      baseActionLog: {},
      currentAttempt: { providerProtocol: 'anthropic', modelId: 'claude-3-5-sonnet' },
      state: new Map(),
    };

    const decision = await strategy.evaluate(context);
    expect(decision.shouldIntervene).toBe(true);

    const msgs = decision.modifiedBody!.messages;
    // No message should have role: "system"
    const systemMessages = msgs.filter((m: any) => m.role === 'system');
    expect(systemMessages).toHaveLength(0);
  });

  it('preserves original top-level system field', async () => {
    const context: ContinuityContext = {
      originalBody: {
        model: 'claude-3-5-sonnet',
        system: 'You are a coding assistant.',
        messages: [{ role: 'user', content: 'Write code' }],
        max_tokens: 100,
      },
      responseData: { data: { stop_reason: 'max_tokens' } },
      streamResult: { isLengthTruncated: true },
      accumulatedCompletionText: 'def hello():',
      baseActionLog: {},
      currentAttempt: {},
      state: new Map(),
    };

    const decision = await strategy.evaluate(context);
    expect(decision.shouldIntervene).toBe(true);
    expect(decision.modifiedBody!.system).toBe('You are a coding assistant.');
  });

  it('includes accumulated partial text in assistant message', async () => {
    const accumulated = 'Part 1 of the response. It discusses';
    const context: ContinuityContext = {
      originalBody: {
        messages: [{ role: 'user', content: 'Tell me a story' }],
        max_tokens: 50,
      },
      responseData: { data: { choices: [{ finish_reason: 'length' }] } },
      streamResult: { isLengthTruncated: true },
      accumulatedCompletionText: accumulated,
      baseActionLog: {},
      currentAttempt: {},
      state: new Map(),
    };

    const decision = await strategy.evaluate(context);
    expect(decision.shouldIntervene).toBe(true);

    const msgs = decision.modifiedBody!.messages;
    const assistantMsg = msgs.find((m: any) => m.role === 'assistant');
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg!.content).toBe(accumulated);
  });


  it('continuation prompt uses user role, not system', async () => {
    const context: ContinuityContext = {
      originalBody: {
        messages: [{ role: 'user', content: 'hi' }],
      },
      responseData: { data: { choices: [{ finish_reason: 'length' }] } },
      streamResult: { isLengthTruncated: true },
      accumulatedCompletionText: 'hello',
      baseActionLog: {},
      currentAttempt: {},
      state: new Map(),
    };

    const decision = await strategy.evaluate(context);
    expect(decision.shouldIntervene).toBe(true);
    const msgs = decision.modifiedBody!.messages;
    const lastMsg = msgs[msgs.length - 1];
    expect(lastMsg.role).toBe('user');
    expect(lastMsg.role).not.toBe('system');
  });
});
