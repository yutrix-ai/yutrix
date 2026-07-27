import { describe, it, expect } from 'vitest';
import { buildSafeNonStreamAuditOutput } from '../src/routes/gateway/auditSanitizer';

describe('buildSafeNonStreamAuditOutput', () => {
  // Test 1: thinking + signature, no text
  it('strips signature from thinking-only Anthropic response', () => {
    const data = {
      content: [
        { type: 'thinking', thinking: 'My internal reasoning', signature: 'sig_abc123_secret_signature_value' },
      ],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 20 },
    };
    const observation = { reasoningText: 'My internal reasoning' };
    const result = buildSafeNonStreamAuditOutput(data, observation);
    expect(result).not.toContain('sig_abc123_secret_signature_value');
    expect(result).toContain('My internal reasoning');
    expect(result).toContain('<think>');
  });

  // Test 2: redacted_thinking + data, no text
  it('strips redacted_thinking data from Anthropic response', () => {
    const data = {
      content: [
        { type: 'redacted_thinking', data: 'AABBCCDD_REDACTED_BINARY_PAYLOAD_ENCRYPTED' },
      ],
      stop_reason: 'end_turn',
    };
    const observation = {};
    const result = buildSafeNonStreamAuditOutput(data, observation);
    expect(result).not.toContain('AABBCCDD_REDACTED_BINARY_PAYLOAD_ENCRYPTED');
    expect(result).not.toContain('redacted');
  });

  // Test 3: thinking + redacted_thinking + tool_use, no text
  it('handles mixed thinking, redacted, and tool_use blocks safely', () => {
    const data = {
      content: [
        { type: 'thinking', thinking: 'Step by step analysis', signature: 'sig_xyz789' },
        { type: 'redacted_thinking', data: 'SECRET_ENCRYPTED_DATA_BLOCK' },
        { type: 'tool_use', id: 'tu_1', name: 'get_weather', input: { location: 'Tokyo', units: 'celsius' } },
      ],
      stop_reason: 'tool_use',
    };
    const observation = { reasoningText: 'Step by step analysis' };
    const result = buildSafeNonStreamAuditOutput(data, observation);
    expect(result).not.toContain('sig_xyz789');
    expect(result).not.toContain('SECRET_ENCRYPTED_DATA_BLOCK');
    expect(result).toContain('Step by step analysis');
    expect(result).toContain('get_weather');
  });

  // Test 4: OpenAI content=null + encrypted reasoning_details + tool_calls
  it('strips encrypted reasoning from OpenAI response with tool_calls', () => {
    const data = {
      choices: [{
        message: {
          content: null,
          reasoning_content: null,
          reasoning: null,
          reasoning_details: [{ type: 'encrypted', ciphertext: 'BASE64_ENCRYPTED_REASONING_PAYLOAD' }],
          tool_calls: [
            { id: 'tc_1', type: 'function', function: { name: 'search_docs', arguments: '{"query": "test"}' } },
          ],
        },
        finish_reason: 'tool_calls',
      }],
    };
    const observation = {};
    const result = buildSafeNonStreamAuditOutput(data, observation);
    expect(result).not.toContain('BASE64_ENCRYPTED_REASONING_PAYLOAD');
    expect(result).not.toContain('ciphertext');
    expect(result).toContain('search_docs');
  });

  // Test 5: encrypted-only reasoning
  it('strips encrypted-only reasoning from OpenAI response', () => {
    const data = {
      choices: [{
        message: {
          content: null,
          reasoning_content: 'ENCRYPTED:abc123def456_ciphertext_blob',
        },
        finish_reason: 'stop',
      }],
    };
    const observation = { reasoningText: 'Safe reasoning summary' };
    const result = buildSafeNonStreamAuditOutput(data, observation);
    expect(result).not.toContain('ENCRYPTED:abc123def456_ciphertext_blob');
    expect(result).toContain('Safe reasoning summary');
  });

  // Test 6: normal text response preserved
  it('preserves normal text response content', () => {
    const data = {
      choices: [{
        message: {
          content: 'Hello, how can I help you today?',
        },
        finish_reason: 'stop',
      }],
    };
    const observation = {};
    const result = buildSafeNonStreamAuditOutput(data, observation);
    expect(result).toBe('Hello, how can I help you today?');
  });

  // Test 7: normal Anthropic text response preserved
  it('preserves normal Anthropic text response', () => {
    const data = {
      content: [
        { type: 'text', text: 'Here is my answer.' },
      ],
      stop_reason: 'end_turn',
    };
    const observation = {};
    const result = buildSafeNonStreamAuditOutput(data, observation);
    expect(result).toBe('Here is my answer.');
  });

  // Test 8: OpenAI with reasoning + content
  it('includes safe reasoning in think tags for OpenAI', () => {
    const data = {
      choices: [{
        message: {
          content: 'The answer is 42.',
          reasoning_content: 'I thought about the meaning of life.',
        },
        finish_reason: 'stop',
      }],
    };
    const observation = { reasoningText: 'I thought about the meaning of life.' };
    const result = buildSafeNonStreamAuditOutput(data, observation);
    expect(result).toContain('<think>I thought about the meaning of life.</think>');
    expect(result).toContain('The answer is 42.');
  });

  // Test 9: Tool call input is redacted (OpenAI)
  it('redacts tool call arguments entirely for OpenAI', () => {
    const data = {
      choices: [{
        message: {
          content: null,
          tool_calls: [
            { id: 'tc_1', type: 'function', function: { name: 'long_tool', arguments: JSON.stringify({ signature: "sig123", ciphertext: "encrypted_abc", api_key: "sk-xyz", token: "tok123" }) } },
          ],
        },
        finish_reason: 'tool_calls',
      }],
    };
    const observation = {};
    const result = buildSafeNonStreamAuditOutput(data, observation);
    expect(result).toContain('[tool_call: long_tool]');
    expect(result).not.toContain('sig123');
    expect(result).not.toContain('api_key');
    expect(result).not.toContain('signature');
    expect(result).not.toContain('token');
    expect(result).not.toContain('[REDACTED]');
  });

  // Test 10: null/undefined data returns safe fallback
  it('returns safe fallback for null data', () => {
    const result = buildSafeNonStreamAuditOutput(null, {});
    expect(result).toBe('[unsupported response format]');
    expect(result).not.toContain('null');
  });

  // Test 11: Anthropic tool_use with thinking
  it('extracts tool names from Anthropic tool_use blocks and redacts inputs', () => {
    const data = {
      content: [
        { type: 'thinking', thinking: 'Planning tool call', signature: 'sig_secret' },
        { type: 'tool_use', id: 'tu_1', name: 'calculator', input: { data: 'some_data', encrypted_payload: 'encrypted_xyz', authorization: 'Bearer token123' } },
      ],
      stop_reason: 'tool_use',
    };
    const observation = { reasoningText: 'Planning tool call' };
    const result = buildSafeNonStreamAuditOutput(data, observation);
    expect(result).toContain('[tool_use: calculator]');
    expect(result).not.toContain('sig_secret');
    expect(result).not.toContain('some_data');
    expect(result).not.toContain('encrypted_xyz');
    expect(result).not.toContain('Bearer token123');
    expect(result).not.toContain('encrypted_payload');
    expect(result).not.toContain('authorization');
    expect(result).not.toContain('[REDACTED]');
  });
});
