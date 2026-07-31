import { eq } from "drizzle-orm";
import { db } from "../../db";
import { providerApiKeys } from "../../db/schema";

export async function processErrorRetryLogic(params: {
  responseData: any;
  activeKeyId: string | null;
  availableKeys: any[];
  triedKeys: Set<string>;
  attemptCount: number;
  maxAttempts: number;
  allowTransientSameKeyRetry?: boolean;
  capacityExhausted?: boolean;
}): Promise<{ shouldRetrySameProvider: boolean; preserveAttemptCount: boolean; reason?: string; isAuthenticationError?: boolean }> {
  const {
    responseData,
    activeKeyId,
    availableKeys,
    triedKeys,
    attemptCount,
    maxAttempts,
    allowTransientSameKeyRetry = true,
    capacityExhausted = false,
  } = params;
  let shouldRetrySameProvider = false;
  let preserveAttemptCount = false;
  let reason: string | undefined;
  let isAuthenticationError = false;

  if (capacityExhausted) {
    return { shouldRetrySameProvider: false, preserveAttemptCount: false, isAuthenticationError: false };
  }

  if (!responseData.isStream && responseData.status >= 400) {
    const bodyStr = typeof responseData.data === "string" ? responseData.data : JSON.stringify(responseData.data);
    let isExhausted = false;
    let isRateLimit = false;
    const isTransientUpstreamError = [500, 502, 503, 504, 529].includes(responseData.status);

    if (
      bodyStr.includes("\"insufficient_quota\"") ||
      bodyStr.includes("account_deactivated") ||
      bodyStr.includes("billing_hard_limit_reached")
    ) {
      isExhausted = true;
    } else if (
      bodyStr.includes("\"invalid_api_key\"") ||
      bodyStr.includes("\"authentication_error\"")
    ) {
      // 401 invalid_api_key / authentication_error: the key may be model-specific
      // (e.g., a provider plan key that works for model A but returns 401 for model B).
      // Do NOT permanently mark the key as exhausted in the DB.
      // Instead, add the key to triedKeys so we try other keys, then fallback.
      isRateLimit = true; // treat like rate-limit: rotate keys, don't deactivate
      isAuthenticationError = true;
    } else if (responseData.status === 429) {
      isRateLimit = true;
    }

    if (isExhausted && activeKeyId) {
      await db.update(providerApiKeys).set({ status: "exhausted" }).where(eq(providerApiKeys.id, activeKeyId));
    }

    if ((isExhausted || isRateLimit || isTransientUpstreamError)) {
      if (activeKeyId) {
        triedKeys.add(activeKeyId);
      }
      const untriedCount = availableKeys.filter(k => !triedKeys.has(k.id)).length;
      if (untriedCount > 0) {
        shouldRetrySameProvider = true;
        preserveAttemptCount = true;
        reason = "provider_key_rotation";
      } else if (allowTransientSameKeyRetry && isTransientUpstreamError && attemptCount < maxAttempts) {
        shouldRetrySameProvider = true;
        preserveAttemptCount = false;
        reason = "transient_upstream_5xx";
        if (activeKeyId) {
          triedKeys.delete(activeKeyId);
        }
      }
    }
  }
  return { shouldRetrySameProvider, preserveAttemptCount, reason, isAuthenticationError };
}

export function selectProviderKey(params: {
  activeKeysList: any[];
  triedKeys: Set<string>;
  providerKeyCursors: Map<string, number>;
  providerId: string;
  preferredActiveKeyId: string | null;
  decryptText: (text: string) => string;
}): import("./types").ProviderKeySelectionResult {
  const { activeKeysList, triedKeys, providerKeyCursors, providerId, preferredActiveKeyId, decryptText } = params;

  if (activeKeysList.length === 0) {
    return { kind: "no_active_keys" };
  }

  const availableKeys = activeKeysList.filter((k: any) => !triedKeys.has(k.id));

  if (availableKeys.length === 0) {
    return { kind: "all_active_keys_tried", triedKeyIds: Array.from(triedKeys) };
  }

  let activeKeyId: string | null = null;
  let decryptedKey: string | null = null;

  if (preferredActiveKeyId) {
    const isKeyForCurrentProvider = activeKeysList.some((k: any) => k.id === preferredActiveKeyId);
    let validPreferredKeyId = isKeyForCurrentProvider ? preferredActiveKeyId : null;

    if (validPreferredKeyId && !triedKeys.has(validPreferredKeyId)) {
       activeKeyId = validPreferredKeyId;
       const foundKey = activeKeysList.find((k: any) => k.id === activeKeyId);
       if (foundKey) {
          decryptedKey = decryptText(foundKey.keyEncrypted);
          return { kind: "selected", keyId: activeKeyId as string, decryptedKey };
       }
    }
  }

  // Round-robin selection
  availableKeys.sort((a, b) => a.id.localeCompare(b.id));
  let cursor = providerKeyCursors.get(providerId) || 0;
  cursor = cursor % availableKeys.length;
  const selectedKey = availableKeys[cursor];
  providerKeyCursors.set(providerId, cursor + 1);

  activeKeyId = selectedKey.id;
  decryptedKey = decryptText(selectedKey.keyEncrypted) || "";

  return { kind: "selected", keyId: activeKeyId as string, decryptedKey };
}

export function isOpenRouterCapacityError(error: any): boolean {
  if (!error) return false;
  return (
    error.adapterId === "openrouter" &&
    error.code === "provider_capacity_exhausted" &&
    error.retryClass === "provider_capacity" &&
    error.retryable === true
  );
}

/**
 * Resolve the model's context budget for preemptive long_context routing.
 *
 * Priority:
 * 1. Explicit provider_models.contextWindowTokens column (admin-configured)
 * 2. Metadata in rawJson (contextWindowTokens / context_window / …)
 * 3. Unknown (limit=0) — do NOT preemptive-override; let the request run and
 *    fall back on real upstream context errors
 *
 * maxOutputTokens is intentionally NOT used here: it only clamps client
 * max_tokens / max_completion_tokens in the output pipeline.
 */
export function resolveModelContextWindow(modelConfig: any): { limit: number, kind: "total_context" | "max_input", source: string } {
  if (!modelConfig) return { limit: 0, kind: "total_context", source: "unknown" };

  const columnLimit = modelConfig.contextWindowTokens;
  if (typeof columnLimit === "number" && Number.isFinite(columnLimit) && columnLimit > 0) {
    return { limit: Math.floor(columnLimit), kind: "total_context", source: "contextWindowTokens" };
  }

  if (modelConfig.rawJson) {
    try {
      const raw = typeof modelConfig.rawJson === 'string' ? JSON.parse(modelConfig.rawJson) : modelConfig.rawJson;
      if (raw) {
        const fields = [
          { name: "contextWindowTokens", kind: "total_context" },
          { name: "context_window", kind: "total_context" },
          { name: "contextWindow", kind: "total_context" },
          { name: "context_length", kind: "total_context" },
          { name: "max_context_length", kind: "total_context" },
          { name: "max_input_tokens", kind: "max_input" },
          { name: "maxInputTokens", kind: "max_input" }
        ] as const;
        
        for (const field of fields) {
          const val = raw[field.name] || (raw.top_provider && raw.top_provider[field.name]);
          if (typeof val === 'number' && val > 0) {
            return { limit: val, kind: field.kind, source: field.name };
          }
        }
      }
    } catch (e) {}
  }

  return { limit: 0, kind: "total_context", source: "unknown" };
}

export function fitsContextBudget({
  inputTokens,
  requestedOutputTokens,
  safetyMargin,
  budget
}: {
  inputTokens: number,
  requestedOutputTokens: number,
  safetyMargin: number,
  budget: { limit: number, kind: "total_context" | "max_input", source: string }
}): boolean {
  if (budget.source === "unknown" || budget.limit <= 0) return true; // Can act as final candidate
  if (budget.kind === "total_context") {
    return inputTokens + requestedOutputTokens + safetyMargin <= budget.limit;
  } else {
    return inputTokens + safetyMargin <= budget.limit;
  }
}
