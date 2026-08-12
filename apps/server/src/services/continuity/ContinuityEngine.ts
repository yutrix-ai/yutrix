import { ContinuityStrategy, ContinuityContext, ContinuityDecision } from "./types";
import { MaxTokensTruncationStrategy } from "./strategies/MaxTokensTruncationStrategy";
import { ReasoningExhaustionStrategy } from "./strategies/ReasoningExhaustionStrategy";
export class ContinuityEngine {
  private strategies: ContinuityStrategy[] = [];

  // Keep track of retry counts for each strategy within a single request cycle
  private strategyRetries: Map<string, number> = new Map();

  constructor() {
    // Register strategies
    this.strategies.push(new MaxTokensTruncationStrategy());
    this.strategies.push(new ReasoningExhaustionStrategy());
    // EmptyOutput is intentionally not registered: holding empty stop/[DONE]
    // plus auto-continue blanked OpenCode (OpenAI protocol) in production.
    // Strategy + tests remain; do not re-enable without a live OpenCode soak.
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
  async evaluateAll(context: ContinuityContext): Promise<ContinuityDecision> {
    for (const strategy of this.strategies) {
      const currentRetries = this.strategyRetries.get(strategy.name) || 0;

      const decision = await strategy.evaluate(context);

      if (decision.shouldIntervene) {
        if (currentRetries < strategy.maxRetries) {
          // Allowed to intervene
          this.strategyRetries.set(strategy.name, currentRetries + 1);
          return decision;
        } else {
          // Exhausted retries, trigger exhaustion hook
          if (strategy.onExhausted) {
            context.responseData = await strategy.onExhausted(context);
          }
          return { shouldIntervene: false, isExhausted: true, strategyName: strategy.name };
        }
      }
    }

    return { shouldIntervene: false };
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
