import type { FastifyRequest, FastifyReply } from "fastify";

/**
 * Auth context produced by API key extraction & validation.
 */
export interface AuthContext {
  providedKey: string;
  apiKeyRecord: {
    id: string;
    userId: string;
    name: string;
    keyPrefix: string;
    concurrencyLimit: number;
    [key: string]: any;
  };
  userId: string;
  isSystemKey: boolean;
}

/**
 * Routing context produced by subdomain/endpoint/route resolution.
 */
export interface RoutingContext {
  incomingProtocol: string;
  reqPath: string;
  endpoint: any;
  route: any;
  subdomainRecord: any;
}

/**
 * Mutable state tracking the current upstream attempt (switches on fallback).
 */
export interface AttemptState {
  providerId: string;
  providerProtocol: string;
  modelId: string;
  promptPolicyId: string | null;
  isFallback: boolean;
  fallbackReason: string;
  targetIndex: number;
  strategyTaskType?: string;
  strategyReason?: string;
  /** After EmptyOutput/429 vertical hop, re-run this layer's strategy rules. */
  reapplyLayerStrategy?: boolean;
}

export interface RoutingTraceEntry {
  fromProviderId: string;
  fromProviderName?: string;
  fromModelId: string;
  toProviderId: string;
  toProviderName?: string;
  toProviderProtocol: string;
  toModelId: string;
  reason: string;
  hop: number;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  createdAt: string;
}

/**
 * Accumulator for streaming content, tokens, and tool calls.
 */
export interface StreamAccumulator {
  gotFirstChunk: boolean;
  ttft: number;
  promptTokens: number;
  completionTokens: number;
  estimatedPromptTokens: number;
  accumulatedCompletionText: string;
  accumulatedReasoningText: string;
  accumulatedToolArgs: Record<string, { name: string; arguments: string }>;
  streamedUsagePayload: any;
  streamedTotalTokens: number | undefined;
  cachedTokens: number;
  isAborted: boolean;
}

/**
 * Upstream response data returned by the fetch execution layer.
 */
export interface UpstreamResponseData {
  status: number;
  statusText?: string;
  data?: any;
  stream?: ReadableStream;
  isStream: boolean;
  isFakeStream?: boolean;
  fakeStreamText?: string;
  errorDetail?: string;
  upstreamRequestIds?: string;
  upstreamUrl?: string;
  effectiveUpstreamProtocol?: string;
  effectiveBaseUrl?: string;
  latencyMs: number;
  queueMs: number;
  provider?: any;
  baseLog?: any;
  observation?: any; // StreamObservation
  terminalError?: any; // StreamTerminalError
  releaseSlots?: () => void;
  adapterState?: any;
  sourceProtocol?: "openai" | "anthropic";
  streamProtocol?: "openai" | "anthropic";
  /** The actual wire protocol of responseData.data or responseData.stream content.
   *  Distinct from effectiveUpstreamProtocol (what we SENT). This is what we RECEIVED/CONVERTED TO. */
  responseProtocol?: "openai" | "anthropic";
  roundUsage?: any; // RoundUsage
  roundUsageCommitted?: boolean;
  roundRequestBody?: any;
  roundId?: string;
  rawProviderUsage?: any;
  roundStreamUsage?: any;
  roundOutputSnapshot?: any;
}

/**
 * Base action log fields used throughout the request lifecycle.
 */
export interface BaseActionLog {
  requestId: string;
  userId: string;
  username?: string;
  apiKeyPrefix: string;
  host: string;
  path: string;
  routeName: string;
  ip?: string;
  [key: string]: any;
}

export interface RoutingRequirements {
  intentTaskType: "debug" | "code" | "long_context" | "writing" | "general";
  requiredCapabilities: {
    vision: boolean;
  };
  currentUserTurnHasImage: boolean;
  outboundPayloadHasImage: boolean;
  imageCount: number;
  requiresLongContext: boolean;
  estimatedTextTokens: number;
  estimatedImageTokens: number;
  estimatedTotalTokens: number;
}

/**
 * Full request context that aggregates all sub-contexts.
 * Passed between gateway modules during request processing.
 */
export interface GatewayRequestContext {
  request: FastifyRequest;
  reply: FastifyReply;
  body: any;
  startTime: number;
  routingRequirements?: RoutingRequirements;


  // Auth
  auth: AuthContext;

  // Routing
  routing: RoutingContext;

  // Attempt tracking
  currentAttempt: AttemptState;

  // Logging
  baseActionLog: BaseActionLog;
  username?: string;
  userRole: string;

  // Request state
  reqLogId: string;
  isLogInserted: boolean;
  isStreaming: boolean;
  activeModelConfig: any;
  activeProvider?: any;
  usageRequestBody: any;
  clientDisconnected: boolean;
  streamLogFinalized: boolean;
  routingTrace: RoutingTraceEntry[];
  inputTokenLimit: {
    maxInputTokens: number;
    source: string;
    sourceLabel: string;
  };
  /** EmptyOutput already walked to a later funnel layer at least once. */
  emptyOutputLayerHopApplied?: boolean;
  /** A long_context or later-vision overflow hop already ran; skip re-applying group/user clip. */
  overflowHopApplied?: boolean;

  // Provider Adapter State
  activeProviderAdapter?: any;
  activeProviderAdapterContext?: any;
  activeProviderAdapterState?: any;
  activeEffectiveUpstreamProtocol?: string;
  activeEffectiveBaseUrl?: string;

  // Stream accumulator
  stream: StreamAccumulator;

  continuity: {
    accumulatedCompletionText: string;
    hiddenContinuityText: string;
    forwardedStreamText: string;
    promptTokens: number;
    completionTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    usageStatus: "success" | "estimated" | "missing" | "failed";
    committedRoundIds: Set<string>;
    isLastCycle?: boolean;
    hasStartedContinuity?: boolean;
    hasForwardedStreamMaterial?: boolean;
    streamRoundCount?: number;
    stitchState?: any;
  };

  // Helpers
  calculateCostForTokens: (inputTokens: number, outputTokens: number) => number | null;
  logAction?: any;
}

export interface AnthropicStreamEnvelopeState {
  hasStartedMessage: boolean;
  activeBlockIndex: number;
  isInsideTextBlock: boolean;
  activeToolCalls: Record<number, { id: string; name: string; emittedStart: boolean; closed: boolean }>;
}

/**
 * Creates a fresh StreamAccumulator with default values.
 */
export function createStreamAccumulator(): StreamAccumulator {
  return {
    gotFirstChunk: false,
    ttft: 0,
    promptTokens: 0,
    completionTokens: 0,
    estimatedPromptTokens: 0,
    accumulatedCompletionText: "",
    accumulatedReasoningText: "",
    accumulatedToolArgs: {},
    streamedUsagePayload: null,
    streamedTotalTokens: undefined,
    cachedTokens: 0,
    isAborted: false,
  };
}

export type RoundUsageStatus = "success" | "estimated" | "missing" | "failed";

export interface RoundUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  usageStatus: RoundUsageStatus;
  inputSource: "provider" | "estimated" | "missing";
  outputSource: "provider" | "estimated" | "missing";
}

export type ProviderKeySelectionResult =
  | {
      kind: "selected";
      keyId: string;
      decryptedKey: string;
    }
  | {
      kind: "no_active_keys";
    }
  | {
      kind: "all_active_keys_tried";
      triedKeyIds: string[];
    };
