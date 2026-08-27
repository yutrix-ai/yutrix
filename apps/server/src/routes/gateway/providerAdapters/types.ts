export interface ProviderAdapterContext {
  providerId: string;
  providerName: string;
  providerProtocol: string; // "openai" | "anthropic" | "google-native" etc.
  rawBaseUrl: string;
  normalizedBaseUrl: string;
  hostname: string;
  pathname: string;
  modelId: string;
  incomingProtocol: string; // "openai" | "anthropic"
  requestPath: string;
  clientHeaders?: Record<string, string | string[] | undefined>;
}

export interface ProviderDispatchPlan {
  adapterId: ProviderAdapterId;
  adapter: ProviderAdapter;
  adapterContext: ProviderAdapterContext;
  adapterState: unknown;

  configuredProtocol: string;
  effectiveProtocol: string;

  configuredBaseUrl: string;
  effectiveBaseUrl: string;
  effectiveUpstreamPath: string;
  streamProtocol: "openai" | "anthropic";

  bypassProtocolAdaptation: boolean;
}

export interface ProviderRequestPolicy {
  exemptAssistantHistoryFields?: string[];
  /** Fields to preserve in fake stream conversion. If undefined, default behavior. */
  preserveFakeStreamFields?: string[];
}

export interface StreamTerminalError {
  statusCode: number;
  code?: string;
  errorType: string;
  message: string;
  retryable?: boolean;
  retryClass?: "rate_limit" | "provider_capacity" | "provider_unavailable" | "network" | "timeout" | "authentication" | "invalid_request" | "protocol_payload_incompatible" | "client_closed" | "unknown";
  adapterId?: "openrouter" | "google" | "transparent";
  upstreamProvider?: string;
  upstreamCode?: string;
  upstreamErrorType?: string;
  upstreamRequestId?: string;
  safeMetadata?: Record<string, string | number | boolean | null>;
  fingerprint?: string;
  phase?: "http" | "nonstream" | "fake_stream" | "stream";
  targetScoped?: boolean;
  persistentKeyDisable?: boolean;
}

export interface StreamObservation {
  meaningful?: boolean;
  reasoningText?: string;
  terminalError?: StreamTerminalError;
  usage?: any;
}

export interface ProviderAdapterResolution {
  adapter: ProviderAdapter;
  ownerId: ProviderAdapterId | null;
  disabled: boolean;
}

export type ProviderAdapterId = "google" | "openrouter" | "transparent";

export interface ProviderAdapter {
  id: ProviderAdapterId;
  match(context: ProviderAdapterContext): boolean;
  createAttemptState?(context: ProviderAdapterContext): any;
  getRequestPolicy?(context: ProviderAdapterContext): ProviderRequestPolicy;

  // --- Upstream Protocol Override Hooks ---
  effectiveUpstreamProtocol?(context: ProviderAdapterContext): string | undefined;
  overrideUpstreamBaseUrl?(context: ProviderAdapterContext, originalBaseUrl: string): string | undefined;
  overrideUpstreamPath?(context: ProviderAdapterContext, originalPath: string): string | undefined;
  adaptUpstreamHeaders?(context: ProviderAdapterContext, originalHeaders: Record<string, string>): Record<string, string> | undefined;
  bypassProtocolAdaptation?(context: ProviderAdapterContext): boolean | undefined;
  adaptRequestBody?(context: ProviderAdapterContext, body: any, helpers: { logAction: any, baseActionLog: any }): any;

  classifyUpstreamError?(
    input: {
      rawError: unknown;
      statusCode?: number;
      phase: "http" | "nonstream" | "fake_stream" | "stream";
    },
    context: ProviderAdapterContext,
  ): StreamTerminalError | undefined;

  observeStreamChunk?(chunkCopy: any, state: any, context: ProviderAdapterContext): StreamObservation | void;
  transformStreamChunk?(chunk: any, state: any, context: ProviderAdapterContext): boolean;
  observeNonStreamResponse?(responseCopy: any, state: any, context: ProviderAdapterContext): StreamObservation | void;
  transformNonStreamResponse?(response: any, context: ProviderAdapterContext): boolean;
}
