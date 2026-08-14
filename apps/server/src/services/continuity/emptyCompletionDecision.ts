import { detectProviderUsagePresence, normalizeUsagePayload } from "../../utils/gatewayContent";

export const ZERO_COMPLETION_FALLBACK =
  "\n\n*(系统提示：上游返回 0 输出 token，已重试仍为空。请换模型或重新发送。)*";

export function isExplicitZeroOutput(payload: any, presenceHint?: { outputProvided?: boolean }): boolean {
  const presence = presenceHint || detectProviderUsagePresence(payload);
  if (!presence?.outputProvided) return false;
  return normalizeUsagePayload(payload)?.outputTokens === 0;
}

function explicitOutputTokens(
  payload: any,
  presenceHint?: { outputProvided?: boolean },
): number | undefined {
  const presence = presenceHint || detectProviderUsagePresence(payload);
  if (!presence?.outputProvided) return undefined;
  const tokens = normalizeUsagePayload(payload)?.outputTokens;
  return typeof tokens === "number" ? tokens : undefined;
}

/** Provider-reported completion tokens > 0 — not an empty-output retry. */
export function isExplicitPositiveOutput(responseData: any): boolean {
  const fromData = explicitOutputTokens(responseData?.data, responseData?.rawProviderUsage);
  if (fromData !== undefined && fromData > 0) return true;
  const fromStream = explicitOutputTokens(responseData?.roundStreamUsage);
  return fromStream !== undefined && fromStream > 0;
}

function blockHasText(block: any): boolean {
  if (typeof block === "string") return block.trim().length > 0;
  if (!block || typeof block !== "object") return false;
  if (typeof block.text === "string" && block.text.trim().length > 0) return true;
  if (typeof block.content === "string" && block.content.trim().length > 0) return true;
  if (Array.isArray(block.content)) return block.content.some(blockHasText);
  return false;
}

/** Request would estimate inputTokens > 0 even if the provider omitted usage. */
export function requestHasBillableInput(body: any): boolean {
  if (!body || typeof body !== "object") return false;
  if (typeof body.prompt === "string" && body.prompt.trim().length > 0) return true;
  if (typeof body.system === "string" && body.system.trim().length > 0) return true;
  if (Array.isArray(body.system) && body.system.some(blockHasText)) return true;
  if (Array.isArray(body.input) && body.input.length > 0) return true;
  if (Array.isArray(body.messages) && body.messages.length > 0) return true;
  return false;
}

/**
 * Same totals Request completed would print as in>0 and out=0.
 * Missing usage is not an exemption when the request has billable input
 * and the provider did not report a positive completion.
 */
export function wouldLogZeroEmptyCompletion(
  responseData: any,
  roundUsage?: { inputTokens?: number; outputTokens?: number },
  originalBody?: any,
): boolean {
  if (isExplicitPositiveOutput(responseData)) {
    return false;
  }
  if (isExplicitZeroOutput(responseData?.data, responseData?.rawProviderUsage)) {
    return true;
  }
  if (isExplicitZeroOutput(responseData?.roundStreamUsage)) {
    return true;
  }
  const usage = roundUsage || responseData?.roundUsage;
  if (usage && Number(usage.inputTokens) > 0 && Number(usage.outputTokens) === 0) {
    return true;
  }
  if (requestHasBillableInput(originalBody || responseData?.roundRequestBody)) {
    return true;
  }
  return false;
}

/**
 * Hold an empty stream terminal so one same-body retry can run before the
 * client sees stop / end_turn / [DONE] / message_stop.
 */
export function shouldWithholdEmptyTerminal(input: {
  visibleClientOutputSent: boolean;
  hasReasoningBuffer?: boolean;
  eventHasSemanticContent?: boolean;
  isDone?: boolean;
  finishReason?: string | null;
  anthropicEventType?: string | null;
  anthropicStopReason?: string | null;
}): boolean {
  if (input.visibleClientOutputSent) return false;
  if (input.hasReasoningBuffer) return false;
  if (input.eventHasSemanticContent) return false;

  if (input.isDone) return true;
  if (input.finishReason === "stop" || input.finishReason === "end_turn") return true;
  if (input.anthropicEventType === "message_stop") return true;
  if (
    input.anthropicEventType === "message_delta"
    && (input.anthropicStopReason === "end_turn" || input.anthropicStopReason === "stop")
  ) {
    return true;
  }
  return false;
}
