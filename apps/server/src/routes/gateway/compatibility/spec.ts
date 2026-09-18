/**
 * SDD: Google / Gemini outbound compatibility.
 *
 * Profiles (closed set, matchers are open):
 * - first_party_google_openai: official Google OpenAI-compatible hosts only.
 *   Schema sanitize + max_tokens clamp + stream_options removal.
 * - gemini_schema_proxy: known Gemini function_declarations proxies only
 *   (Antigravity, gcli2api). Schema sanitize only — never clamp tokens or
 *   drop stream_options. A gemini-* model name or "Google"/"Gemini" brand
 *   on a transparent host is NOT enough (boundary sealing).
 * - none: leave the body untouched.
 *
 * Enum policy (Gemini proto `enum` is string[]):
 * - All-string enums stay as enums.
 * - Non-string enums are dropped; JSON types are preserved (boolean stays
 *   boolean, integer stays integer). Never coerce `true` → `"true"`.
 * - Singleton / numeric / mixed dropped values may be hinted in description.
 *
 * Callers must invoke applyProviderCompatibility unconditionally; the function
 * is a no-op when the profile is none.
 */

export const COMPATIBILITY_PROFILES = [
  "first_party_google_openai",
  "gemini_schema_proxy",
  "none",
] as const;

export type CompatibilityProfile = (typeof COMPATIBILITY_PROFILES)[number];

export const FIRST_PARTY_ONLY_RULE_IDS = [
  "stream_options_removed",
  "max_tokens_clamped",
] as const;

export const SHARED_GEMINI_SCHEMA_RULE_IDS = ["tools_schema_sanitized"] as const;

export const MAX_GEMINI_SCHEMA_DEPTH = 32;

export const GEMINI_STRING_FORMATS = new Set(["date-time", "enum"]);

export type CompatibilityOptions = {
  providerName?: string;
  baseUrl?: string;
  providerProtocol?: string;
  modelId?: string;
  logAction?: Function;
  baseActionLog?: any;
};

export type CompatibilityLog = {
  code: string;
  message: string;
  [key: string]: any;
};

export type CompatibilityRule = {
  id: string;
  appliesTo(profile: CompatibilityProfile): boolean;
  apply(body: any, options: CompatibilityOptions): CompatibilityLog | null;
};
