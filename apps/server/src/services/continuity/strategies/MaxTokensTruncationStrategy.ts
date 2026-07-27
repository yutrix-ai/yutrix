import { ContinuityStrategy, ContinuityContext, ContinuityDecision } from "../types";

export class MaxTokensTruncationStrategy implements ContinuityStrategy {
  name = "MaxTokensTruncation";
  maxRetries = 3;

  async evaluate(context: ContinuityContext): Promise<ContinuityDecision> {
    const { streamResult, responseData, originalBody, accumulatedCompletionText } = context;

    // 1. Never intervene for native Anthropic responses since we don't support Anthropic SSE stitching yet.
    if (responseData?.sourceProtocol === "anthropic") {
      return { shouldIntervene: false };
    }

    let isTruncated = false;
    if (streamResult) {
      isTruncated = streamResult.isLengthTruncated;
    } else if (responseData?.data?.choices?.[0]?.finish_reason === "length") {
      isTruncated = true;
    } else if (responseData?.data?.stop_reason === "max_tokens") {
      isTruncated = true;
    }

    if (isTruncated) {
      const messages = [...(originalBody.messages || [])];

      // Inject the accumulated text from all previous fetches
      messages.push({ role: "assistant", content: accumulatedCompletionText });

      // Inject the continuation prompt
      messages.push({
        role: "user",
        content: "Your previous response was cut off. Please continue from exactly the last character. Do not include any intros or JSON formatting prefixes, just output the raw text."
      });

      const modifiedBody = { ...originalBody, messages };

      return {
        shouldIntervene: true,
        strategyName: this.name,
        modifiedBody
      };
    }

    return { shouldIntervene: false };
  }
}
