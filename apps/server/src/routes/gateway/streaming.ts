/**
 * Stream orchestrator — coordinates forwarding with external observation.
 *
 * This module does NOT modify upstream response data. It delegates:
 * - Forwarding → streamForwarder.ts (protocol-compatible proxy)
 * - Observation → StreamAuditObserver (accumulates COPIES for audit/logging)
 *
 * The observer extracts content, reasoning, tool calls, and usage from
 * deep copies of parsed chunks. These accumulated results are used for
 * audit logging, cost calculation, and progress tracking.
 */

import type { FastifyReply } from "fastify";
import crypto from "crypto";
import { db } from "../../db";
import { apiKeys } from "../../db/schema";
import { eq } from "drizzle-orm";
import {
  normalizeUsagePayload,
  firstTokenCount,
} from "../../utils/gatewayContent";
import { estimateTokensFallback } from "../../utils/tokenizer";
import { publishRequestLogUpdate } from "../../services/requestLogService";
import type {
  UpstreamResponseData,
  GatewayRequestContext,
} from "./types";
import {
  forwardSSEStreamAdapted,
  forwardSSEStreamTransparent,
  type StreamForwardObserver,
  type StitchState,
} from "./streamForwarder";
import { TranslatorContext } from "./translators/types";
import type { StreamTerminalError } from "./providerAdapters/types";

export interface StreamForwardResult {
  promptTokens: number;
  completionTokens: number;
  accumulatedCompletionText: string;
  accumulatedReasoningText: string;
  accumulatedToolArgs: Record<string, { name: string; arguments: string }>;
  /** True if the upstream produced 0 valid content chunks. */
  isEmptyStream: boolean;
  /** True if the upstream stream ended because of finish_reason: "length" or equivalent. */
  isLengthTruncated: boolean;
  lastToolCallState?: StitchState;
  closingSentinel?: string;
  terminalEventSent?: boolean;
  meaningfulClientOutputSent?: boolean;
  /** Terminal error detected by provider adapter during stream observation. */
  terminalError?: StreamTerminalError;
  anthropicState?: any;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Audit Observer — accumulates data from COPIES for logging/audit purposes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Observer that accumulates content, reasoning, tool calls, and usage
 * from DEEP COPIES of parsed stream chunks. Used for audit logging,
 * cost calculation, and intermediate progress tracking.
 *
 * This observer does NOT affect the forwarding pipeline.
 */
class StreamAuditObserver implements StreamForwardObserver {
  promptTokens: number;
  completionTokens = 0;
  accumulatedCompletionText = "";
  accumulatedReasoningText = "";
  accumulatedToolArgs: Record<string, { name: string; arguments: string }> = {};
  streamedUsagePayload: any = null;
  streamedTotalTokens: number | undefined;
  cachedTokens = 0;
  ttft = 0;

  private startTime: number;
  private lastEmitTime: number;
  private baseLog: any;
  private responseStatus: number;
  private activeModelConfig: any;
  private apiKeyRecord: any;
  // Track tool call indices for accumulation
  private toolCallIndex: Record<number, { id: string; name: string }> = {};
  private isGoogleThoughtStream = false;
  private providerPromptTokensReceived = false;

  constructor(
    promptTokens: number,
    startTime: number,
    baseLog: any,
    responseStatus: number,
    activeModelConfig: any,
    apiKeyRecord: any,
  ) {
    this.promptTokens = promptTokens;
    this.startTime = startTime;
    this.lastEmitTime = Date.now();
    this.baseLog = baseLog;
    this.responseStatus = responseStatus;
    this.activeModelConfig = activeModelConfig;
    this.apiKeyRecord = apiKeyRecord;
  }

  onFirstChunk(): void {
    this.ttft = Date.now() - this.startTime;
    if (this.responseStatus >= 200 && this.responseStatus < 300) {
      db.update(apiKeys)
        .set({ lastUsedAt: new Date() })
        .where(eq(apiKeys.id, this.apiKeyRecord.id))
        .execute()
        .catch((e) => console.error(e));
    }
  }

  getCompletionTokens(): number {
    return this.completionTokens;
  }

  /**
   * Process a deep copy of a parsed SSE chunk.
   * Extracts content, reasoning, tool calls, and usage for audit purposes.
   */
  onParsedChunk(dataCopy: any): void {
    // ─── Extract reasoning_content (from COPY) ───
    const chunkDelta = dataCopy.choices?.[0]?.delta || dataCopy.choices?.[0]?.message;
    if (chunkDelta?.reasoning_content !== undefined) {
      if (typeof chunkDelta.reasoning_content === "string" && chunkDelta.reasoning_content) {
        this.accumulatedReasoningText += chunkDelta.reasoning_content;
      }
    }

    const isGoogleThoughtChunk = chunkDelta?.extra_content?.google?.thought === true;
    if (isGoogleThoughtChunk) {
      this.isGoogleThoughtStream = true;
    }

    // ─── Extract content text (from COPY) ───
    let deltaText = "";
    if (dataCopy.choices && Array.isArray(dataCopy.choices)) {
      if (dataCopy.choices[0]?.delta?.content) {
        deltaText = dataCopy.choices[0].delta.content;
      } else if (dataCopy.choices[0]?.message?.content) {
        deltaText = dataCopy.choices[0].message.content;
      }
    } else if (dataCopy.delta && typeof dataCopy.delta.text === "string") {
      deltaText = dataCopy.delta.text;
    } else if (typeof dataCopy.completion === "string") {
      deltaText = dataCopy.completion;
    }
    if (deltaText && (this.isGoogleThoughtStream || deltaText.includes("<thought>") || deltaText.includes("</thought>"))) {
      deltaText = deltaText.replace(/<\/?thought>/g, "");
    }
    if (deltaText && isGoogleThoughtChunk) {
      this.accumulatedReasoningText += deltaText;
    } else if (deltaText) {
      this.accumulatedCompletionText += deltaText;
    }

    // ─── Extract usage (from COPY) ───
    const chunkUsage = normalizeUsagePayload(dataCopy);
    if (chunkUsage) {
      const rawUsage = dataCopy.usage || dataCopy.message?.usage;
      if (chunkUsage.inputTokens !== undefined) {
        if (!this.providerPromptTokensReceived) {
          this.promptTokens = chunkUsage.inputTokens;
          this.providerPromptTokensReceived = true;
        } else {
          this.promptTokens = Math.max(this.promptTokens, chunkUsage.inputTokens);
        }
      }
      if (chunkUsage.outputTokens !== undefined) {
        this.completionTokens = Math.max(this.completionTokens, chunkUsage.outputTokens);
      }
      const explicitTotalTokens = firstTokenCount(rawUsage?.total_tokens);
      if (explicitTotalTokens !== undefined) {
        this.streamedTotalTokens = Math.max(
          this.streamedTotalTokens || 0,
          explicitTotalTokens,
        );
      }
      if (chunkUsage.cachedTokens !== undefined) {
        this.cachedTokens = Math.max(this.cachedTokens, chunkUsage.cachedTokens);
      }
      this.streamedUsagePayload = {
        usage: {
          prompt_tokens: this.promptTokens,
          completion_tokens: this.completionTokens,
          total_tokens: this.streamedTotalTokens,
        },
      };
    }

    // ─── Extract tool calls (from COPY) ───
    if (dataCopy.choices && Array.isArray(dataCopy.choices)) {
      const toolCallsDelta = dataCopy.choices[0]?.delta?.tool_calls;
      if (toolCallsDelta && Array.isArray(toolCallsDelta)) {
        for (const tc of toolCallsDelta) {
          if (!this.toolCallIndex[tc.index]) {
            const id = tc.id || `call_${crypto.randomUUID()}`;
            const name = tc.function?.name || "";
            this.toolCallIndex[tc.index] = { id, name };
            this.accumulatedToolArgs[id] = { name, arguments: "" };
          }
          const tool = this.toolCallIndex[tc.index];
          if (tc.function?.name && !tool.name) {
            tool.name = tc.function.name;
            if (this.accumulatedToolArgs[tool.id]) {
              this.accumulatedToolArgs[tool.id].name = tc.function.name;
            }
          }
          if (tc.function?.arguments) {
            const entry = this.accumulatedToolArgs[tool.id];
            if (entry) entry.arguments += tc.function.arguments;
          }
        }
      }
    } else if (dataCopy.type === "content_block_start" && dataCopy.content_block?.type === "tool_use") {
      const index = dataCopy.index;
      const id = dataCopy.content_block.id || `call_${crypto.randomUUID()}`;
      const name = dataCopy.content_block.name || "";
      this.toolCallIndex[index] = { id, name };
      this.accumulatedToolArgs[id] = { name, arguments: "" };
    } else if (dataCopy.type === "content_block_delta" && dataCopy.delta?.type === "input_json_delta") {
      const index = dataCopy.index;
      const tool = this.toolCallIndex[index];
      if (tool && dataCopy.delta.partial_json) {
        const entry = this.accumulatedToolArgs[tool.id];
        if (entry) entry.arguments += dataCopy.delta.partial_json;
      }
    }

    // ─── Intermediate progress emission (every 500ms) ───
    const now = Date.now();
    if (now - this.lastEmitTime > 500) {
      this.lastEmitTime = now;

      const currentCompletionTokens = this.completionTokens > 0
        ? this.completionTokens
        : estimateTokensFallback(this.accumulatedCompletionText + this.accumulatedReasoningText);
      const currentTotalTokens = this.promptTokens + currentCompletionTokens;

      let calculatedCost: number | null = null;
      if (this.activeModelConfig) {
        const inputPrice = this.activeModelConfig.inputTokenPricePerM;
        const outputPrice = this.activeModelConfig.outputTokenPricePerM;
        if (inputPrice !== null && inputPrice !== undefined && outputPrice !== null && outputPrice !== undefined) {
          calculatedCost = (this.promptTokens * inputPrice / 1000000) + (currentCompletionTokens * outputPrice / 1000000);
        }
      }

      publishRequestLogUpdate({
        ...(this.baseLog || {}),
        status: this.responseStatus,
        statusCode: this.responseStatus,
        inputTokens: this.promptTokens,
        outputTokens: currentCompletionTokens,
        totalTokens: currentTotalTokens,
        latencyMs: Date.now() - this.startTime,
        usageStatus: "processing",
        cost: calculatedCost,
        alias: this.activeModelConfig?.alias,
      });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Main entry point — orchestrates forwarding + observation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Forward an SSE stream from upstream to the client.
 *
 * Delegates to streamForwarder.ts for transparent forwarding, and uses
 * StreamAuditObserver for accumulating data from copies.
 *
 * NOTE: The caller is responsible for writing SSE headers BEFORE calling this function.
 */
export async function forwardStream(
  reply: FastifyReply,
  responseData: UpstreamResponseData,
  ctx: GatewayRequestContext,
  baseLog: any,
  stitchState?: StitchState,
  streamTimeoutMs?: number,
  anthropicState?: any
): Promise<StreamForwardResult> {
  const {
    currentAttempt,
    stream: acc,
    startTime,
    auth,
    routing,
    activeModelConfig,
  } = ctx;

  // Reset stream accumulator for this attempt
  acc.gotFirstChunk = false;
  acc.promptTokens = responseData.isFakeStream ? 0 : acc.estimatedPromptTokens;
  acc.completionTokens = 0;
  acc.accumulatedCompletionText = "";
  acc.accumulatedReasoningText = "";
  acc.accumulatedToolArgs = {};
  acc.streamedUsagePayload = null;
  acc.streamedTotalTokens = undefined;
  acc.cachedTokens = 0;
  acc.isAborted = false;
  acc.ttft = 0;

  const effectiveProtocol = ctx.activeProviderAdapter?.effectiveUpstreamProtocol && ctx.activeProviderAdapterContext
    ? ctx.activeProviderAdapter.effectiveUpstreamProtocol(ctx.activeProviderAdapterContext) || currentAttempt.providerProtocol
    : currentAttempt.providerProtocol;

  const isAnthropicAdaptation =
    routing.incomingProtocol !== responseData.streamProtocol &&
    routing.incomingProtocol === "anthropic";

  // Create the audit observer — works on COPIES, does not affect forwarding
  const observer = new StreamAuditObserver(
    responseData.isFakeStream ? 0 : acc.estimatedPromptTokens,
    startTime,
    baseLog,
    responseData.status,
    activeModelConfig,
    auth.apiKeyRecord,
  );

  let gotFirstChunk: boolean;
  let isLengthTruncated = false;
  let lastToolCallState: StitchState | undefined;
  let closingSentinel: string | undefined;
  let terminalEventSent = false;
  let meaningfulClientOutputSent = false;

  const translatorContext: TranslatorContext = {
    modelId: currentAttempt.modelId,
    providerProtocol: currentAttempt.providerProtocol,
  };

  if (isAnthropicAdaptation) {
    // ─── Cross-protocol path ───
    // Parse upstream OpenAI SSE and re-emit as Anthropic SSE events.
    // Content (text, tool calls) is preserved verbatim.
    // Observer receives copies for audit accumulation.
    const result = await forwardSSEStreamAdapted(
      reply,
      responseData.stream,
      {
        targetProtocol: "anthropic",
        messageId: `msg_${crypto.randomUUID()}`,
        modelId: currentAttempt.modelId,
        promptTokens: acc.estimatedPromptTokens,
      },
      observer,
      stitchState,
      streamTimeoutMs,
      translatorContext,
      ctx.activeProviderAdapter,
      ctx.activeProviderAdapterState,
      ctx.activeProviderAdapterContext,
      ctx.logAction,
      { ...ctx.baseActionLog, providerName: ctx.activeProvider?.name },
      anthropicState
    );
    gotFirstChunk = result.gotFirstChunk;
    isLengthTruncated = result.isLengthTruncated || false;
    closingSentinel = result.closingSentinel;
    terminalEventSent = result.terminalEventSent || false;
    meaningfulClientOutputSent = result.meaningfulClientOutputSent || false;
    anthropicState = (result as any).anthropicState;
  } else {
    // ─── Same-protocol path ───
    // Forward SSE data transparently, allowing scoped protocol compatibility
    // normalization such as Google thought metadata extraction.
    // Observer receives copies for audit accumulation.
    const result = await forwardSSEStreamTransparent(
      reply,
      responseData.stream,
      observer,
      stitchState,
      streamTimeoutMs,
      routing.incomingProtocol,
      translatorContext,
      ctx.activeProviderAdapter,
      ctx.activeProviderAdapterState,
      ctx.activeProviderAdapterContext,
      ctx.logAction,
      { ...ctx.baseActionLog, providerName: ctx.activeProvider?.name },
      responseData.sourceProtocol,
    );
    gotFirstChunk = result.gotFirstChunk;
    isLengthTruncated = result.isLengthTruncated || false;
    lastToolCallState = result.lastToolCallState;
    closingSentinel = result.closingSentinel;
    terminalEventSent = result.terminalEventSent || false;
    meaningfulClientOutputSent = result.meaningfulClientOutputSent || false;
  }

  // ─── Post-stream processing ───

  const accumulatedCompletionText = observer.accumulatedCompletionText;
  const accumulatedReasoningText = observer.accumulatedReasoningText;
  const accumulatedToolArgs = observer.accumulatedToolArgs;
  const promptTokens = observer.promptTokens;
  const completionTokens = observer.completionTokens;

  // Detect empty upstream streams
  const isEmptyStream = (!gotFirstChunk || (
    !accumulatedCompletionText &&
    !accumulatedReasoningText &&
    Object.keys(accumulatedToolArgs).length === 0
  )) && !ctx.activeProviderAdapterState?.terminalError && !ctx.activeProviderAdapterState?.hadMeaningfulAdapterEvent;

  // Sync accumulated data back to context
  acc.gotFirstChunk = gotFirstChunk;
  acc.ttft = observer.ttft;
  acc.cachedTokens = observer.cachedTokens;
  acc.promptTokens = promptTokens;
  acc.completionTokens = completionTokens;
  acc.accumulatedCompletionText = accumulatedCompletionText;
  acc.accumulatedReasoningText = accumulatedReasoningText;
  Object.assign(acc.accumulatedToolArgs, accumulatedToolArgs);
  acc.streamedUsagePayload = observer.streamedUsagePayload;
  acc.streamedTotalTokens = observer.streamedTotalTokens;

  return {
    promptTokens,
    completionTokens,
    accumulatedCompletionText,
    accumulatedReasoningText,
    accumulatedToolArgs,
    isEmptyStream,
    isLengthTruncated,
    lastToolCallState,
    closingSentinel,
    terminalEventSent,
    meaningfulClientOutputSent,
    terminalError: ctx.activeProviderAdapterState?.terminalError || undefined,
    anthropicState: anthropicState,
  };
}
