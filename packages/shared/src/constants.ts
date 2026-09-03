export const API_VERSION = "1.0.0";
export const DEFAULT_PAGE_SIZE = 20;

/**
 * First-answer SLA for a new provider.
 * Hop to the next funnel layer if this provider sends no first stream chunk
 * (or no full non-stream response) within this window.
 *
 * 30s matches LiteLLM's documented stream_timeout example and Portkey's
 * 20–30s user-facing failover band. Fast-model TTFT is typically <3s, so
 * 30s is a hung-provider signal without false-hopping most reasoning starts.
 */
export const DEFAULT_PROVIDER_TIMEOUT_MS = 30_000;

/**
 * Idle limit between upstream stream chunks after the first byte.
 * 5 minutes matches Codex `stream_idle_timeout_ms` (300_000). Shorter
 * values (nginx/ALB 60s, OpenAI streaming-read example 60s) false-kill
 * thinking pauses after the first ping/role/thinking token.
 */
export const DEFAULT_PROVIDER_STREAM_TIMEOUT_MS = 300_000;

export const ERR_SETUP_REQUIRED = "SETUP_REQUIRED";
export const ERR_SETUP_REQUIRED_MESSAGE =
  "System is not initialized. Please complete setup at /setup first.";
export const ERR_MAINTENANCE_ACTIVE = "MAINTENANCE_ACTIVE";
export const ERR_MAINTENANCE_ACTIVE_MESSAGE =
  "System is undergoing database maintenance. Please retry later.";

