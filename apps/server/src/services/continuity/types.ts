import type { GatewayRequestClass } from "../requestRoutingClass";

/**
 * Context provided to strategies for evaluation.
 */
export interface ContinuityContext {
  originalBody: any;
  responseData: any;
  /** Sidecar / title / classifier turns must not be retried. */
  requestClass?: GatewayRequestClass;
  streamResult?: {
    isLengthTruncated: boolean;
    lastToolCallState?: any;
    /** True when client already received meaningful stream content (blocks empty-output retry). */
    meaningfulClientOutputSent?: boolean;
    /** Visible answer text or tool calls were sent (excludes reasoning-only). */
    visibleClientOutputSent?: boolean;
    /** Terminal stream error from forwarder/adapters (blocks empty-output retry). */
    terminalError?: any;
    terminalEventSent?: boolean;
    withheldEmptyTerminal?: boolean;
  };
  accumulatedCompletionText: string;
  baseActionLog: any;
  currentAttempt: any;
  state: Map<string, any>;
}

/**
 * The decision returned by a strategy.
 */
export interface ContinuityDecision {
  shouldIntervene: boolean;
  strategyName?: string;
  modifiedBody?: any;
  isExhausted?: boolean;
}

/**
 * A strategy that determines if and how a response should be automatically continued.
 */
export interface ContinuityStrategy {
  /** The unique name of the strategy */
  name: string;

  /** The maximum number of times this strategy is allowed to trigger per request */
  maxRetries: number;

  /**
   * Evaluates the current state and returns a decision.
   * If intervention is needed, modifiedBody should contain the new payload to send upstream.
   */
  evaluate(context: ContinuityContext): Promise<ContinuityDecision>;

  /**
   * Called if the strategy hits its maxRetries limit.
   * Can be used to inject fallback messages into the final response before it's sent to the client.
   * Returns the modified responseData.
   */
  onExhausted?(context: ContinuityContext): Promise<any>;
}
