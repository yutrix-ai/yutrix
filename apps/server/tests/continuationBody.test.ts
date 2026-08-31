import { describe, it, expect } from 'vitest';
import { MaxTokensTruncationStrategy } from '../src/services/continuity/strategies/MaxTokensTruncationStrategy';
import { ContinuityEngine } from '../src/services/continuity/ContinuityEngine';
import { ContinuityContext } from '../src/services/continuity/types';

describe('MaxTokensTruncationStrategy (retired)', () => {
  const strategy = new MaxTokensTruncationStrategy();

  function lengthContext(overrides: Partial<ContinuityContext> = {}): ContinuityContext {
    return {
      originalBody: {
        model: 'claude-3-5-sonnet-20241022',
        system: 'You are a helpful assistant.',
        messages: [{ role: 'user', content: 'Write a long essay about AI.' }],
        max_tokens: 100,
      },
      responseData: { data: { choices: [{ finish_reason: 'length' }] } },
      streamResult: { isLengthTruncated: true } as any,
      accumulatedCompletionText: 'This is the first part of the essay about AI.',
      baseActionLog: {},
      currentAttempt: { providerProtocol: 'anthropic', modelId: 'claude-3-5-sonnet' },
      state: new Map(),
      ...overrides,
    };
  }

  it('never intervenes on finish_reason=length (response-stage stitching retired)', async () => {
    const decision = await strategy.evaluate(lengthContext());
    expect(decision.shouldIntervene).toBe(false);
    expect(decision.modifiedBody).toBeUndefined();
  });

  it('is not registered on ContinuityEngine', async () => {
    const engine = new ContinuityEngine();
    const decision = await engine.evaluateAll(lengthContext());
    expect(decision.shouldIntervene).toBe(false);
    expect(decision.strategyName).not.toBe('MaxTokensTruncation');
  });
});
