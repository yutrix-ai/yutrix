import { ContinuityStrategy, ContinuityContext, ContinuityDecision } from "./types";
import { ReasoningExhaustionStrategy } from "./strategies/ReasoningExhaustionStrategy";
import { EmptyOutputStrategy } from "./strategies/EmptyOutputStrategy";
export class ContinuityEngine {
  private strategies: ContinuityStrategy[] = [];

  // Keep track of retry counts for each strategy within a single request cycle
  private strategyRetries: Map<string, number> = new Map();

  constructor() {
    // MaxTokensTruncation (response-stage length stitching) is intentionally
    // not registered: finish_reason=length is passed through to the client.
    this.strategies.push(new ReasoningExhaustionStrategy());
    // Zero-completion only: same-body retry before the client sees stop/[DONE].
    // Does not inject a "continue" user turn (that blanked OpenCode).
    this.strategies.push(new EmptyOutputStrategy());
  }

  /**
   * Resets the retry counters. Call this at the start of a fresh user request.
   */
  reset() {
    this.strategyRetries.clear();
  }

  /**
   * Evaluates all registered strategies to see if one needs to intervene.
   * Strategies are evaluated in order; the first one that triggers wins.
   */
  async evaluateAll(
    context: ContinuityContext,
    options?: { skipOnExhausted?: boolean },
  ): Promise<ContinuityDecision> {
    for (const strategy of this.strategies) {
      const currentRetries = this.strategyRetries.get(strategy.name) || 0;

      const decision = await strategy.evaluate(context);

      if (decision.shouldIntervene) {
        if (currentRetries < strategy.maxRetries) {
          // Allowed to intervene
          this.strategyRetries.set(strategy.name, currentRetries + 1);
          return decision;
        } else {
          if (!options?.skipOnExhausted && strategy.onExhausted) {
            context.responseData = await strategy.onExhausted(context);
          }
          return { shouldIntervene: false, isExhausted: true, strategyName: strategy.name };
        }
      }
    }

    return { shouldIntervene: false };
  }

  async applyExhaustedHook(context: ContinuityContext, strategyName?: string): Promise<void> {
    const strategy = this.strategies.find((item) => item.name === strategyName);
    if (strategy?.onExhausted) {
      context.responseData = await strategy.onExhausted(context);
    }
  }

  /**
   * Helper to get the current retry count for logging.
   */
  getRetryCount(strategyName: string): number {
    return this.strategyRetries.get(strategyName) || 0;
  }
}

// Export a singleton instance if desired, or let gatewayExecutor instantiate it per request.
// Given that it holds state (strategyRetries), it MUST be instantiated PER REQUEST.
