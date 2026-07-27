/**
 * Safe audit output builder for non-stream responses.
 * Extracts only safe content for audit logging, never leaking:
 * - Anthropic thinking signatures
 * - Redacted thinking data
 * - Encrypted reasoning payloads
 * - Raw ciphertext
 * - Complete response objects
 */
export function buildSafeNonStreamAuditOutput(
  data: any,
  observation: any,
): string {
  if (!data || typeof data !== 'object') {
    return '[unsupported response format]';
  }

  const safeReasoningText = observation?.reasoningText || '';

  // Anthropic format: data.content is array of blocks
  if (Array.isArray(data.content)) {
    return buildAnthropicAuditOutput(data, safeReasoningText);
  }

  // OpenAI format: data.choices[].message
  if (Array.isArray(data.choices)) {
    return buildOpenAIAuditOutput(data, safeReasoningText);
  }

  return '[unsupported response format]';
}

function buildAnthropicAuditOutput(data: any, safeReasoningText: string): string {
  const parts: string[] = [];

  if (safeReasoningText) {
    parts.push(`<think>${safeReasoningText}</think>`);
  }

  for (const block of data.content) {
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    } else if (block.type === 'tool_use') {
      parts.push(`[tool_use: ${block.name || 'unknown'}]`);
    } else if (block.type === 'thinking' && !safeReasoningText) {
      // If the adapter didn't extract reasoningText, but the raw body has a thinking block,
      // we must log it so it's not lost.
      parts.push(`<think>${block.thinking}</think>`);
    }
    // Explicitly skip: redacted_thinking (never log), signature (never log)
  }

  // If we only have reasoning and no visible content, that's ok
  if (parts.length === 0) {
    return '[no visible content]';
  }

  return parts.join('\n');
}

function buildOpenAIAuditOutput(data: any, safeReasoningText: string): string {
  const parts: string[] = [];
  const msg = data.choices?.[0]?.message;

  if (safeReasoningText) {
    parts.push(`<think>${safeReasoningText}</think>`);
  }

  // Extract plain text content only
  if (msg?.content && typeof msg.content === 'string') {
    parts.push(msg.content);
  }

  // Extract tool call names and safe summaries
  if (Array.isArray(msg?.tool_calls)) {
    for (const tc of msg.tool_calls) {
      if (tc.type === 'function' && tc.function) {
        parts.push(`[tool_call: ${tc.function.name || 'unknown'}]`);
      }
    }
  }

  // Never use raw reasoning_content, reasoning_details, or reasoning as fallback
  // Only observation.reasoningText is safe

  if (parts.length === 0) {
    return '[no visible content]';
  }

  return parts.join('\n');
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.substring(0, maxLen) + '…';
}
