import type { CompatibilityOptions, CompatibilityProfile } from "./spec";

export type NormalizedProviderSurface = {
  name: string;
  url: string;
  host: string;
  path: string;
  model: string;
  protocol: string;
};

type ProfileMatcher = {
  profile: Exclude<CompatibilityProfile, "none">;
  match(surface: NormalizedProviderSurface): boolean;
};

export function normalizeProviderSurface(options: CompatibilityOptions): NormalizedProviderSurface {
  const rawUrl = String(options.baseUrl || "").trim();
  let host = "";
  let path = "";
  if (rawUrl) {
    try {
      const parsed = new URL(rawUrl.includes("://") ? rawUrl : `http://${rawUrl}`);
      host = parsed.hostname.toLowerCase();
      path = parsed.pathname.toLowerCase();
    } catch {
      // Keep host/path empty; name/url/model matchers still apply.
    }
  }

  return {
    name: String(options.providerName || "").toLowerCase(),
    url: rawUrl.toLowerCase(),
    host,
    path,
    model: String(options.modelId || "").toLowerCase(),
    protocol: String(options.providerProtocol || "").toLowerCase(),
  };
}

export function isOfficialGoogleHost(host: string): boolean {
  const normalized = String(host || "").toLowerCase();
  return normalized === "googleapis.com" || normalized.endsWith(".googleapis.com");
}

function mentionsKnownGeminiDeclarationProxy(surface: NormalizedProviderSurface): boolean {
  const haystack = `${surface.name} ${surface.path} ${surface.url}`;
  return (
    haystack.includes("antigravity") ||
    haystack.includes("gcli2api") ||
    /(^|[^a-z0-9])gcli([^a-z0-9]|$)/.test(haystack)
  );
}

/**
 * First match wins. Register new Gemini-family proxies here without touching apply().
 */
export const COMPATIBILITY_PROFILE_MATCHERS: ProfileMatcher[] = [
  {
    profile: "first_party_google_openai",
    match: (surface) => isOfficialGoogleHost(surface.host),
  },
  {
    profile: "gemini_schema_proxy",
    match: mentionsKnownGeminiDeclarationProxy,
  },
];

export function resolveCompatibilityProfile(options: CompatibilityOptions): CompatibilityProfile {
  const surface = normalizeProviderSurface(options);
  if (surface.protocol && surface.protocol !== "openai") return "none";

  for (const matcher of COMPATIBILITY_PROFILE_MATCHERS) {
    try {
      if (matcher.match(surface)) return matcher.profile;
    } catch {
      // A broken matcher must not block later ones.
    }
  }
  return "none";
}

/** Official Google OpenAI hosts only. Gemini proxies are not first-party. */
export function isGoogleOpenAICompatibleProvider(options: CompatibilityOptions): boolean {
  return resolveCompatibilityProfile(options) === "first_party_google_openai";
}
