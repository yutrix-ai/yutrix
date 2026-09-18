import { COMPATIBILITY_RULES } from "./compatibility/rules";
import { resolveCompatibilityProfile } from "./compatibility/profiles";
import type { CompatibilityLog, CompatibilityOptions } from "./compatibility/spec";

export type { CompatibilityLog, CompatibilityOptions, CompatibilityProfile } from "./compatibility/spec";
export { sanitizeGeminiSchema } from "./compatibility/geminiSchema";
export {
  isGoogleOpenAICompatibleProvider,
  resolveCompatibilityProfile,
} from "./compatibility/profiles";

function summarizeCompatibilityLogs(logs: CompatibilityLog[]): string {
  return logs
    .map((log) => {
      if (log.code === "max_tokens_clamped") {
        return `max_tokens(${log.originalMaxTokens || "?"}->${log.clampedMaxTokens})`;
      }
      if (log.code === "tools_schema_sanitized") return `tools_schema(${log.toolCount})`;
      return log.code;
    })
    .join(", ");
}

/**
 * Unconditional entry point: no-op unless the provider matches a profile.
 * Do not gate this on adapter.id === "google".
 */
export function applyProviderCompatibility(body: any, options: CompatibilityOptions): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;

  const profile = resolveCompatibilityProfile(options);
  if (profile === "none") return null;

  const logs: CompatibilityLog[] = [];
  for (const rule of COMPATIBILITY_RULES) {
    try {
      if (!rule.appliesTo(profile)) continue;
      const log = rule.apply(body, options);
      if (log) logs.push(log);
    } catch {
      // Isolate a single rule so schema sanitize still runs after clamp/stream failures.
    }
  }

  if (logs.length === 0) return null;
  const summary = summarizeCompatibilityLogs(logs);

  if (options.logAction) {
    try {
      options.logAction({
        ...(options.baseActionLog || {}),
        level: "WARN",
        code: "request.provider_compatibility",
        providerName: options.providerName,
        modelId: options.modelId,
        profile,
        message: summary,
      });
    } catch {
      // Logging must never fail the request rewrite.
    }
  }

  return summary;
}
