import { detectProviderUsagePresence, normalizeUsagePayload } from "../../utils/gatewayContent";

export const ZERO_COMPLETION_FALLBACK =
  "\n\n*(系统提示：上游返回 0 输出 token，已重试仍为空。请换模型或重新发送。)*";

export function isExplicitZeroOutput(payload: any, presenceHint?: { outputProvided?: boolean }): boolean {
  const presence = presenceHint || detectProviderUsagePresence(payload);
  if (!presence?.outputProvided) return false;
  return normalizeUsagePayload(payload)?.outputTokens === 0;
}

/** Same totals Request completed would print: in>0 and out=0. */
export function wouldLogZeroEmptyCompletion(
  responseData: any,
  roundUsage?: { inputTokens?: number; outputTokens?: number },
): boolean {
  if (isExplicitZeroOutput(responseData?.data, responseData?.rawProviderUsage)) {
    return true;
  }
  if (isExplicitZeroOutput(responseData?.roundStreamUsage)) {
    return true;
  }
  const usage = roundUsage || responseData?.roundUsage;
  if (!usage) return false;
  return Number(usage.inputTokens) > 0 && Number(usage.outputTokens) === 0;
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
