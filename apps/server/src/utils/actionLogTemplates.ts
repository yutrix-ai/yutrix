import { ActionLogEvent } from "./actionLogger";

export function renderActionLogServerLine(
  event: ActionLogEvent,
  timestamp: string,
): string {
  const code = event.code || "legacy.log";

  if (code === "system.started") {
    return `${timestamp} ${event.level} System started host=${event.host} port=${event.port} env=${event.env}`;
  }

  if (code === "auth.login.success") {
    return `${timestamp} ${event.level} Login succeeded user=${event.username}`;
  }

  if (code === "auth.login.failed") {
    return `${timestamp} ${event.level} Login failed user=${event.username} reason=${event.reason}`;
  }

  if (code === "request.completed") {
    return `${timestamp} ${event.level} Request completed requestId=${event.requestId} user=${event.username} apiKey=${event.apiKeyPrefix} host=${event.host} path=${event.path} route=${event.routeName} provider=${event.providerName} model=${event.modelId} status=${event.statusCode} inputTokens=${event.promptTokens} outputTokens=${event.completionTokens} totalTokens=${event.totalTokens} latency=${event.latencyMs}ms queue=${event.queueMs}ms fallback=${event.fallbackText}`;
  }

  if (code === "request.started") {
    return `${timestamp} ${event.level} Request started requestId=${event.requestId} path=${event.path} route=${event.routeName}`;
  }

  if (code === "request.cache_hit") {
    return `${timestamp} ${event.level} Request cache hit requestId=${event.requestId} user=${event.username} apiKey=${event.apiKeyPrefix} host=${event.host} path=${event.path} route=${event.routeName} provider=${event.providerName} model=${event.modelId} status=${event.statusCode} inputTokens=${event.promptTokens} outputTokens=${event.completionTokens} totalTokens=${event.totalTokens} latency=${event.latencyMs}ms queue=${event.queueMs}ms cacheId=${event.cacheId}`;
  }

  if (code === "request.queued") {
    return `${timestamp} ${event.level} Request queued provider=${event.providerName} model=${event.modelId} fallback=${event.fallback}`;
  }

  if (code === "request.dequeued") {
    return `${timestamp} ${event.level} Request dequeued queueMs=${event.queueMs} provider=${event.providerName} model=${event.modelId} fallback=${event.fallback}`;
  }

  if (code === "request.failed") {
    return `${timestamp} ${event.level} Request failed requestId=${event.requestId} statusCode=${event.statusCode} error=${event.errorCode} msg=${event.message}`;
  }

  if (code === "request.empty_stream") {
    return `${timestamp} ${event.level} Empty upstream stream requestId=${event.requestId} provider=${event.providerName} model=${event.modelId} fallback=${event.fallback}`;
  }

  if (code === "request.upstream_diagnostic") {
    if (event.statusCode === 429) {
      return `${timestamp} ${event.level} Upstream returned 429 Too Many Requests requestId=${event.requestId} provider=${event.providerName} model=${event.modelId} attempt=${event.attempt}/${event.maxAttempts}`;
    }
    return `${timestamp} ${event.level} Upstream diagnostic requestId=${event.requestId} provider=${event.providerName} model=${event.modelId} status=${event.statusCode} upstream=${event.upstreamUrl} incoming=${event.incomingProtocol} upstreamProtocol=${event.upstreamProtocol} streaming=${event.streaming} attempt=${event.attempt}/${event.maxAttempts} upstreamRequestIds=${event.upstreamRequestIds || "-"} summary=${event.message}`;
  }

  if (code === "request.upstream_retry") {
    return `${timestamp} ${event.level} Upstream retry requestId=${event.requestId} provider=${event.providerName} model=${event.modelId} status=${event.statusCode} attempt=${event.attempt}/${event.maxAttempts} reason=${event.reason} preserveAttemptCount=${event.preserveAttemptCount}`;
  }

  if (code === "request.provider_keys_exhausted_for_attempt") {
    return `${timestamp} ${event.level} Provider keys exhausted for target requestId=${event.requestId} provider=${event.providerName} model=${event.modelId} message=${event.message}`;
  }

  if (code === "request.provider_key_rejected_for_target") {
    return `${timestamp} ${event.level} Provider key rejected for target requestId=${event.requestId} provider=${event.providerName} model=${event.modelId} keyIdSuffix=${event.keyIdSuffix} errorCode=${event.errorCode} status=${event.statusCode}`;
  }

  if (code === "request.provider_compatibility") {
    return `${timestamp} ${event.level} Provider compatibility applied requestId=${event.requestId} provider=${event.providerName} model=${event.modelId} changes=${event.message}`;
  }

  if (code === "request.google_native_adapter") {
    return `${timestamp} ${event.level} Google native adapter enabled requestId=${event.requestId} provider=${event.providerName} model=${event.modelId} upstreamPath=${event.upstreamPath} streaming=${event.streaming}`;
  }

  if (code === "request.fallback") {
    return `${timestamp} ${event.level} Fallback triggered requestId=${event.requestId} user=${event.username} reason=${event.reasonText} primaryProvider=${event.primaryProviderName} primaryModel=${event.primaryModelId} fallbackProvider=${event.fallbackProviderName} fallbackModel=${event.fallbackModelId}`;
  }

  if (code === "request.strategy_routing.applied") {
    return `${timestamp} ${event.level} Strategy routing applied requestId=${event.requestId} task=${event.taskType} target=${event.targetProviderId}/${event.targetModelId} reason=${event.reason}`;
  }

  if (code === "request.strategy_routing.skipped") {
    return `${timestamp} ${event.level} Strategy routing skipped requestId=${event.requestId} task=${event.taskType} target=${event.targetProviderId}/${event.targetModelId} reason=${event.reason} skip=${event.skipReason}`;
  }

  if (code === "request.long_context_override") {
    return `${timestamp} ${event.level} Long context override applied requestId=${event.requestId} originalTask=${event.originalTaskType} originalModel=${event.originalModelId} targetModel=${event.targetModelId} inputTokens=${event.estimatedTokens} limit=${event.modelLimit}`;
  }

  if (code === "request.strategy_routing.error") {
    return `${timestamp} ${event.level} Strategy routing error requestId=${event.requestId} error=${event.error}`;
  }

  if (code === "request.image_detected") {
    return `${timestamp} ${event.level} Image input detected requestId=${event.requestId} provider=${event.providerName} model=${event.modelId} ${event.message || ""}`;
  }

  if (code === "request.image_normalized") {
    return `${timestamp} ${event.level} Image input normalized requestId=${event.requestId} provider=${event.providerName} model=${event.modelId} ${event.message || ""}`;
  }

  if (code === "request.protocol_adapted") {
    return `${timestamp} ${event.level} Protocol adapted (Anthropic -> OpenAI) provider=${event.providerName} model=${event.modelId}`;
  }

  if (code === "request.protocol_adapted_failed") {
    return `${timestamp} ${event.level} Protocol adaptation failed reason=${event.reasonText}`;
  }

  if (code === "request.timeout") {
    return `${timestamp} ${event.level} Request timeout provider=${event.providerName} model=${event.modelId}`;
  }

  if (code === "request.error") {
    return `${timestamp} ${event.level} Request error msg=${event.message}`;
  }

  if (code === "token.max_output.clamped") {
    return `${timestamp} ${event.level} max output tokens clamped requestId=${event.requestId} original=${event.originalValue} clamped=${event.clampedValue}`;
  }

  if (code === "token.max_input.truncated") {
    return `${timestamp} ${event.level} input tokens truncated requestId=${event.requestId} provider=${event.providerName} model=${event.modelId} source=${event.limitSource}:${event.limitSourceLabel} limit=${event.maxInputTokens} budget=${event.budgetTokens} original=${event.originalTokens} final=${event.finalTokens} droppedTurns=${event.droppedTurns} textTruncated=${event.textTruncated}`;
  }

  if (code === "token.max_input.rejected") {
    return `${timestamp} ${event.level} input token limit rejected requestId=${event.requestId} provider=${event.providerName} model=${event.modelId} source=${event.limitSource}:${event.limitSourceLabel} limit=${event.maxInputTokens} msg=${event.message}`;
  }

  if (code === "tokenizer.error") {
    return `${timestamp} ${event.level} Tokenizer failed model=${event.modelId} repo=${event.tokenizerRepo} source=${event.tokenizerSource} reason=${event.fallbackReason} msg=${event.message}`;
  }

  if (code === "tokenizer.loaded") {
    return `${timestamp} ${event.level} Tokenizer loaded successfully model=${event.modelId} repo=${event.tokenizerRepo} source=${event.tokenizerSource}`;
  }

  if (code === "log.test") {
    return `${timestamp} ${event.level} Test log ${event.message}`;
  }

  if (code === "api_key.created") {
    return `${timestamp} ${event.level} API Key created name=${event.keyName}`;
  }

  if (code === "api_key.status_changed") {
    return `${timestamp} ${event.level} API Key status changed status=${event.status}`;
  }

  if (code === "api_key.revoked") {
    return `${timestamp} ${event.level} API Key revoked`;
  }

  if (code === "request.override_ignored") {
    return `${timestamp} ${event.level} Request override ignored model=${event.overrideModelId}`;
  }

  if (code === "route.model_override.set") {
    return `${timestamp} ${event.level} User set model override user=${event.username} route=${event.routeName} routeId=${event.routeId} overrideModel=${event.modelId}`;
  }

  if (code === "request.provider_adapter.selected") {
    return `${timestamp} ${event.level} Provider adapter selected requestId=${event.requestId} provider=${event.providerName} model=${event.modelId} adapter=${event.adapterId} protocol=${event.effectiveProtocol} url=${event.effectiveBaseUrl}`;
  }

  if (code === "request.provider_adapter.stream_error") {
    return `${timestamp} ${event.level} Provider adapter stream error requestId=${event.requestId} adapter=${event.adapterId} errorCode=${event.errorCode} errorType=${event.errorType} msg=${event.message}`;
  }

  if (code === "request.transient_terminal_error") {
    return `${timestamp} ${event.level} Transient terminal error requestId=${event.requestId} provider=${event.providerName} model=${event.modelId} errorType=${event.errorType} msg=${event.message}`;
  }

  if (code === "request.upstream_retry_exhausted") {
    return `${timestamp} ${event.level} Upstream retry exhausted requestId=${event.requestId} provider=${event.providerName} model=${event.modelId} attempts=${event.attempts} msg=${event.message}`;
  }

  if (code === "request.stream_terminal_error") {
    return `${timestamp} ${event.level} Stream terminal error requestId=${event.requestId} provider=${event.providerName} model=${event.modelId} status=${event.statusCode} msg=${event.message}`;
  }

  if (code === "request.non_stream_terminal_error") {
    return `${timestamp} ${event.level} Non-stream terminal error requestId=${event.requestId} provider=${event.providerName} model=${event.modelId} status=${event.statusCode} msg=${event.message}`;
  }

  if (code === "request.model_capability_mismatch") {
    return `${timestamp} ${event.level} Model capability mismatch requestId=${event.requestId} provider=${event.providerName} model=${event.modelId} requiredCapability=${event.requiredCapability} imageCount=${event.imageCount} nextVisionTarget=${event.nextVisionTarget} msg=${event.message}`;
  }

  if (code === "request.vision_context_fallback") {
    return `${timestamp} ${event.level} Vision context fallback requestId=${event.requestId} originalModel=${event.originalModelId} targetModel=${event.targetModelId} estimatedTokens=${event.estimatedTokens} limit=${event.modelLimit}`;
  }

  if (code === "request.fallback_target_skipped") {
    return `${timestamp} ${event.level} Fallback target skipped requestId=${event.requestId} provider=${event.providerId} model=${event.modelId} reason=${event.reason}`;
  }

  if (code === "request.routing_requirements") {
    return `${timestamp} ${event.level} Routing requirements calculated requestId=${event.requestId} intentTaskType=${event.intentTaskType} selectedTaskType=${event.selectedTaskType} requiredCapabilities=${event.requiredCapabilities} imageCount=${event.imageCount} requiresLongContext=${event.requiresLongContext} textTokens=${event.estimatedTextTokens} imageTokens=${event.estimatedImageTokens} totalTokens=${event.estimatedTotalTokens}`;
  }

  if (code === "request.continuity.round_truncated") {
    return `${timestamp} ${event.level} Continuity round truncated requestId=${event.requestId} strategy=${event.strategy} attempt=${event.attempt}`;
  }

  if (code === "request.continuity.exhausted") {
    return `${timestamp} ${event.level} Continuity exhausted requestId=${event.requestId} strategy=${event.strategy || ""} msg=${event.message || ""}`;
  }

  if (code === "token.physical_context_limit.truncated") {
    return `${timestamp} ${event.level} Physical context limit truncated requestId=${event.requestId} provider=${event.providerName} model=${event.modelId} source=${event.limitSource} maxInputTokens=${event.maxInputTokens} droppedTurns=${event.droppedTurns}`;
  }

  if (code === "token.max_output.clamped") {
    return `${timestamp} ${event.level} Max output clamped requestId=${event.requestId} provider=${event.providerName} model=${event.modelId} original=${event.originalValue} clamped=${event.clampedValue}`;
  }

  if (code === "token.max_output.injected") {
    return `${timestamp} ${event.level} Max output injected requestId=${event.requestId} provider=${event.providerName} model=${event.modelId} value=${event.clampedValue}`;
  }

  // Legacy or unmapped fallback
  if (event.action) {
    return `${timestamp} ${event.level} ${event.action}`;
  }

  return `${timestamp} ${event.level} Unknown event code=${code}`;
}
