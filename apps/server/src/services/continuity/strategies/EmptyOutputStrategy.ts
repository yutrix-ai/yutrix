import { detectProviderUsagePresence, normalizeUsagePayload } from "../../../utils/gatewayContent";
import { ContinuityStrategy, ContinuityContext, ContinuityDecision } from "../types";

const ZERO_COMPLETION_FALLBACK =
  "\n\n*(系统提示：上游返回 0 输出 token，已重试仍为空。请换模型或重新发送。)*";

function hasValidContentOrActionInPayload(parsedData: any): boolean {
  if (!parsedData || typeof parsedData !== "object") return false;

  const checkBlocks = (blocks: any[]): boolean => {
    if (!Array.isArray(blocks)) return false;
    for (const b of blocks) {
      if (!b) continue;
      if (typeof b === "string" && b.trim().length > 0) return true;
      if (typeof b === "object") {
        if (b.type === "tool_use" || b.type === "thinking" || b.type === "redacted_thinking") return true;
        if (typeof b.text === "string" && b.text.trim().length > 0) return true;
        if (typeof b.thinking === "string" && b.thinking.trim().length > 0) return true;
        if (b.tool_calls || b.function) return true;
      }
    }
    return false;
  };

  const message = parsedData.choices?.[0]?.message;
  if (message) {
    if (message.tool_calls && message.tool_calls.length > 0) return true;
    if (message.reasoning_content && message.reasoning_content.trim().length > 0) return true;
    if (typeof message.content === "string" && message.content.trim().length > 0) return true;
    if (Array.isArray(message.content) && checkBlocks(message.content)) return true;
  }

  if (typeof parsedData.content === "string" && parsedData.content.trim().length > 0) return true;
  if (Array.isArray(parsedData.content) && checkBlocks(parsedData.content)) return true;

  return false;
}

/** Only trust an explicit upstream completion/output count of 0. Missing usage is not zero. */
export function providerReportedZeroOutput(responseData: any): boolean {
  const data = responseData?.data;
  const presence = responseData?.rawProviderUsage || detectProviderUsagePresence(data);
  if (!presence?.outputProvided) return false;
  const normalized = normalizeUsagePayload(data);
  return normalized?.outputTokens === 0;
}

export class EmptyOutputStrategy implements ContinuityStrategy {
  name = "EmptyOutput";
  maxRetries = 1;

  async evaluate(context: ContinuityContext): Promise<ContinuityDecision> {
    const { responseData, originalBody, accumulatedCompletionText, streamResult, requestClass } = context;

    if (!responseData || responseData.status >= 400) {
      return { shouldIntervene: false };
    }

    if (requestClass === "client_sidecar") {
      return { shouldIntervene: false };
    }

    // Live SSE still in flight — wait for streamResult. Fake streams are complete JSON.
    if (responseData?.isStream && !responseData?.isFakeStream && !streamResult) {
      return { shouldIntervene: false };
    }

    // Stop/[DONE] already left the gateway — never hold or retry (OpenCode hang).
    if (streamResult?.terminalEventSent) {
      return { shouldIntervene: false };
    }

    const visibleAlreadySent = streamResult?.visibleClientOutputSent === true
      || (streamResult?.visibleClientOutputSent !== false && streamResult?.meaningfulClientOutputSent === true && streamResult?.visibleClientOutputSent === undefined);
    if (visibleAlreadySent || streamResult?.terminalError) {
      return { shouldIntervene: false };
    }

    let parsedData = responseData?.data;
    if (hasValidContentOrActionInPayload(parsedData)) {
      return { shouldIntervene: false };
    }

    let textToCheck = accumulatedCompletionText || "";
    if (responseData?.isFakeStream && responseData?.fakeStreamText) {
      textToCheck = responseData.fakeStreamText;
    } else if (!parsedData && responseData?.isFakeStream && textToCheck) {
      try { parsedData = JSON.parse(textToCheck); } catch (_) {}
      if (hasValidContentOrActionInPayload(parsedData)) {
        return { shouldIntervene: false };
      }
    }

    if (textToCheck && (textToCheck.includes("<tool_calls>") || textToCheck.includes("\"tool_calls\""))) {
      return { shouldIntervene: false };
    }

    let cleanVisibleText = textToCheck
      .replace(/<reasoning>[\s\S]*?<\/reasoning>/g, "")
      .replace(/<think>[\s\S]*?<\/think>/g, "")
      .trim();

    if (cleanVisibleText !== "") {
      return { shouldIntervene: false };
    }

    if (!providerReportedZeroOutput(responseData)) {
      return { shouldIntervene: false };
    }

    // Same payload. Do not inject a user "continue" — that is not this case's practice.
    return {
      shouldIntervene: true,
      strategyName: this.name,
      modifiedBody: originalBody,
    };
  }

  async onExhausted(context: ContinuityContext): Promise<any> {
    const { responseData } = context;
    const fallbackMsg = ZERO_COMPLETION_FALLBACK;

    if (responseData.data?.choices?.[0]?.message) {
      responseData.data.choices[0].message.content = (responseData.data.choices[0].message.content || "") + fallbackMsg;
    } else if (responseData.data?.content && Array.isArray(responseData.data.content)) {
      responseData.data.content.push({ type: "text", text: fallbackMsg });
    } else if (responseData.data) {
      responseData.data.response = (responseData.data.response || "") + fallbackMsg;
    }

    return responseData;
  }
}
