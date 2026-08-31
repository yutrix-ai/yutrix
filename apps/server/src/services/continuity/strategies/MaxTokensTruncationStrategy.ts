import { ContinuityStrategy, ContinuityContext, ContinuityDecision } from "../types";

/**
 * Retired: response-stage "length" stitching is no longer part of the gateway.
 *
 * finish_reason=length / stop_reason=max_tokens is an upstream signal. The
 * gateway must not invent a synthetic "please continue" turn or re-issue the
 * request — that corrupted agent tool loops and ballooned context. Output
 * ceilings, if any, belong only on the request path via model-config
 * maxOutputTokens clamping client max_tokens that exceed the configured value.
 *
 * Class kept so historical imports/tests resolve; evaluate is a permanent no-op.
 */
export class MaxTokensTruncationStrategy implements ContinuityStrategy {
  name = "MaxTokensTruncation";
  maxRetries = 0;

  async evaluate(_context: ContinuityContext): Promise<ContinuityDecision> {
    return { shouldIntervene: false };
  }
}
