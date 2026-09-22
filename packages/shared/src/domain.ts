/**
 * Domain parsing, normalization, and validation utilities for multi-domain support.
 */

const DOMAIN_REGEX =
  /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$|^localhost$/i;

/**
 * Checks if a string is a syntactically valid domain name or localhost.
 */
export function isValidDomain(domain: string): boolean {
  if (!domain || typeof domain !== "string") return false;
  const trimmed = domain.trim().toLowerCase();
  if (trimmed.length > 253) return false;
  return DOMAIN_REGEX.test(trimmed);
}

/**
 * Cleans a single domain input string by stripping protocols, ports, and trailing slashes.
 */
export function normalizeDomain(input: unknown): string {
  if (!input) return "";
  let domain = String(input).trim().toLowerCase();

  // Strip protocol (http://, https://, etc.)
  domain = domain.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "");

  // Strip path or query params if accidentally included
  domain = domain.split("/")[0].split("?")[0].split("#")[0];

  // Strip port (e.g., example.com:3000)
  domain = domain.split(":")[0];

  // Strip leading/trailing dots
  domain = domain.replace(/^\.+|\.+$/g, "");

  return domain;
}

/**
 * Parses a mainDomain setting into a list of clean, unique domain names.
 * Accepts:
 * - Comma, semicolon, newline, or whitespace separated strings
 * - JSON array string: '["domain1.com", "domain2.com"]'
 * - Array of strings
 */
export function parseMainDomains(input: unknown): string[] {
  if (!input) return [];

  let rawList: unknown[] = [];

  if (Array.isArray(input)) {
    rawList = input;
  } else if (typeof input === "string") {
    const trimmed = input.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          rawList = parsed;
        } else {
          rawList = [trimmed];
        }
      } catch {
        rawList = trimmed.split(/[\r\n,;\s]+/);
      }
    } else {
      rawList = trimmed.split(/[\r\n,;\s]+/);
    }
  } else {
    rawList = [String(input)];
  }

  const results: string[] = [];
  const seen = new Set<string>();

  for (const item of rawList) {
    const cleaned = normalizeDomain(item);
    if (!cleaned) continue;
    if (isValidDomain(cleaned) && !seen.has(cleaned)) {
      seen.add(cleaned);
      results.push(cleaned);
    }
  }

  return results;
}

/**
 * Returns the primary (first) main domain, or empty string if none configured.
 */
export function getMainDomain(input: unknown): string {
  const domains = parseMainDomains(input);
  return domains[0] || "";
}

/**
 * Formats a list of domains into a standard comma-separated storage string.
 */
export function formatMainDomains(domains: string[]): string {
  return domains
    .map(normalizeDomain)
    .filter(isValidDomain)
    .filter((v, i, a) => a.indexOf(v) === i)
    .join(", ");
}

export interface DomainMatchResult {
  /** True if the requested host is exactly one of the main domains */
  isRoot: boolean;
  /** The subdomain prefix if requested host is a subdomain of a main domain (e.g. 'api' for 'api.example.com') */
  prefix: string | null;
  /** The specific main domain that matched */
  matchedDomain: string | null;
}

/**
 * Matches an incoming host against a list of configured main domains.
 *
 * Examples:
 * - host: 'example.com', mainDomains: ['example.com'] -> { isRoot: true, prefix: null, matchedDomain: 'example.com' }
 * - host: 'api.example.com', mainDomains: ['example.com'] -> { isRoot: false, prefix: 'api', matchedDomain: 'example.com' }
 * - host: 'deep.sub.example.com', mainDomains: ['example.com'] -> { isRoot: false, prefix: 'deep.sub', matchedDomain: 'example.com' }
 * - host: 'other.com', mainDomains: ['example.com'] -> { isRoot: false, prefix: null, matchedDomain: null }
 */
export function matchHostToDomain(
  reqHost: string,
  mainDomains: string[] | string,
): DomainMatchResult {
  const normalizedReqHost = normalizeDomain(reqHost);
  if (!normalizedReqHost) {
    return { isRoot: false, prefix: null, matchedDomain: null };
  }

  const domains = Array.isArray(mainDomains)
    ? mainDomains.map(normalizeDomain).filter(Boolean)
    : parseMainDomains(mainDomains);

  // Exact root match check
  for (const domain of domains) {
    if (normalizedReqHost === domain) {
      return { isRoot: true, prefix: null, matchedDomain: domain };
    }
  }

  // Subdomain prefix check (longest domain suffix match first)
  const sortedDomains = [...domains].sort((a, b) => b.length - a.length);
  for (const domain of sortedDomains) {
    const suffix = `.${domain}`;
    if (normalizedReqHost.endsWith(suffix) && normalizedReqHost.length > suffix.length) {
      const prefix = normalizedReqHost.slice(0, -suffix.length);
      if (prefix.length > 0 && !prefix.endsWith(".")) {
        return { isRoot: false, prefix, matchedDomain: domain };
      }
    }
  }

  return { isRoot: false, prefix: null, matchedDomain: null };
}

export interface DomainBrandingConfig {
  systemName?: string;
  systemSlogan?: string;
  systemLogoUrl?: string;
  sidebarLogoAnimation?: string;
  appendSloganToTitle?: string;
  hideSystemNameInTitle?: string;
  showGithubIcon?: string;
}

export type DomainBrandingMap = Record<string, DomainBrandingConfig>;

export function parseDomainBranding(raw: unknown): DomainBrandingMap {
  if (!raw) return {};
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    return raw as DomainBrandingMap;
  }
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as DomainBrandingMap;
      }
    } catch {
      return {};
    }
  }
  return {};
}

/**
 * Resolves effective branding by merging domain-specific overrides with global defaults.
 * Empty strings or undefined fields in the domain override fall back to the global default.
 */
export function resolveEffectiveBranding(
  domain: string | null | undefined,
  globalDefaults: Record<string, string>,
  domainBrandingMap: DomainBrandingMap,
): Record<string, string> {
  const result: Record<string, string> = { ...globalDefaults };
  if (!domain) return result;

  const normalizedDomain = normalizeDomain(domain);
  const overrides = domainBrandingMap[normalizedDomain];
  if (!overrides) return result;

  const keys: (keyof DomainBrandingConfig)[] = [
    "systemName",
    "systemSlogan",
    "systemLogoUrl",
    "sidebarLogoAnimation",
    "appendSloganToTitle",
    "hideSystemNameInTitle",
    "showGithubIcon",
  ];

  for (const key of keys) {
    const val = overrides[key];
    if (val !== undefined && val !== null && String(val).trim() !== "") {
      result[key] = String(val);
    }
  }

  return result;
}

/**
 * Represents a single domain-to-subdomain binding for a route.
 */
export interface RouteDomainBinding {
  /** Client-side unique key */
  id: string;
  /** Primary / main domain (e.g. 'brtel.link') or '__custom__' */
  mainDomain: string;
  /** Subdomain prefix (e.g. 'code') or full custom host if isCustom */
  subdomain: string;
  /** Resulting normalized full hostname (e.g. 'code.brtel.link') */
  fullHost: string;
  /** Whether this is a custom standalone host outside configured main domains */
  isCustom?: boolean;
}

/**
 * Parses raw hosts input into an array of normalized host strings.
 * Supports:
 * - JSON array string: '["code.brtel.link", "code.yutrix.ai"]'
 * - Comma / semicolon / whitespace separated strings: "code.brtel.link, code.yutrix.ai"
 * - Array of strings
 * - Fallback to legacy hostname if empty or undefined
 */
export function parseRouteHosts(
  hostsRaw: unknown,
  fallbackHostname?: string | null,
): string[] {
  let list: string[] = [];

  if (Array.isArray(hostsRaw)) {
    list = hostsRaw.map((h) => String(h).trim()).filter(Boolean);
  } else if (typeof hostsRaw === "string" && hostsRaw.trim()) {
    const trimmed = hostsRaw.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          list = parsed.map((h) => String(h).trim()).filter(Boolean);
        } else {
          list = trimmed.split(/[\r\n,;\s]+/).map((h) => h.trim()).filter(Boolean);
        }
      } catch {
        list = trimmed.split(/[\r\n,;\s]+/).map((h) => h.trim()).filter(Boolean);
      }
    } else {
      list = trimmed.split(/[\r\n,;\s]+/).map((h) => h.trim()).filter(Boolean);
    }
  }

  if (list.length === 0 && fallbackHostname && String(fallbackHostname).trim()) {
    list = [String(fallbackHostname).trim()];
  }

  // Deduplicate and normalize
  const seen = new Set<string>();
  const result: string[] = [];

  for (const item of list) {
    const trimmed = item.trim().toLowerCase();
    if (!trimmed) continue;
    if (trimmed === "*" || trimmed === "all") {
      if (!seen.has("*")) {
        seen.add("*");
        result.push("*");
      }
      continue;
    }
    const normalized = normalizeDomain(trimmed);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }

  return result.length > 0 ? result : ["*"];
}

/**
 * Formats an array of host strings into a standard JSON string for storage in `endpoint_routes.hosts`.
 */
export function formatRouteHosts(hosts: string[]): string {
  const parsed = parseRouteHosts(hosts);
  return JSON.stringify(parsed);
}

/**
 * Parses a list of host strings into RouteDomainBinding items by matching against configured main domains.
 */
export function parseRouteDomainBindings(
  hosts: string[] | string,
  mainDomains: string[] | string,
): RouteDomainBinding[] {
  const parsedHosts = parseRouteHosts(hosts);
  const normalizedMainDomains = parseMainDomains(mainDomains);

  if (parsedHosts.length === 1 && parsedHosts[0] === "*") {
    return [];
  }

  return parsedHosts.map((host, index) => {
    const id = `binding-${index}-${host}`;
    const match = matchHostToDomain(host, normalizedMainDomains);

    if (match.matchedDomain && match.prefix) {
      return {
        id,
        mainDomain: match.matchedDomain,
        subdomain: match.prefix,
        fullHost: host,
        isCustom: false,
      };
    }

    if (match.isRoot && match.matchedDomain) {
      return {
        id,
        mainDomain: match.matchedDomain,
        subdomain: "@",
        fullHost: host,
        isCustom: false,
      };
    }

    if (!host.includes(".")) {
      const primaryDomain = getMainDomain(normalizedMainDomains) || "localhost";
      return {
        id,
        mainDomain: primaryDomain,
        subdomain: host,
        fullHost: `${host}.${primaryDomain}`,
        isCustom: false,
      };
    }

    return {
      id,
      mainDomain: "__custom__",
      subdomain: host,
      fullHost: host,
      isCustom: true,
    };
  });
}

/**
 * Validates a list of RouteDomainBinding items.
 *
 * Rules:
 * 1. Within the same route, each main domain can appear AT MOST ONCE ("同一个路由中只允许一个一级域名出现一次").
 * 2. Subdomain prefix must be a valid DNS label (letters, digits, hyphens) or '@' for root.
 * 3. Custom host must be a valid domain.
 * 4. At least one binding or wildcard must be specified.
 */
export function validateRouteDomainBindings(
  bindings: RouteDomainBinding[],
): { ok: boolean; error?: string } {
  if (!bindings || bindings.length === 0) {
    return { ok: false, error: "请配置至少一个二级域名或选择全部域名 (*)" };
  }

  const seenMainDomains = new Set<string>();
  const seenFullHosts = new Set<string>();

  for (const b of bindings) {
    if (!b.isCustom && b.mainDomain && b.mainDomain !== "__custom__") {
      const normalizedMain = normalizeDomain(b.mainDomain);
      if (seenMainDomains.has(normalizedMain)) {
        return {
          ok: false,
          error: `同一个路由中只允许一个一级域名出现一次（${normalizedMain} 已存在）`,
        };
      }
      seenMainDomains.add(normalizedMain);

      const sub = b.subdomain.trim().toLowerCase();
      if (!sub) {
        return { ok: false, error: `域名 ${normalizedMain} 未填写二级域名前缀` };
      }
      if (sub !== "@" && !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(sub)) {
        return {
          ok: false,
          error: `二级域名「${sub}」格式无效，只允许英文字母、数字和连字符`,
        };
      }
    } else {
      // Custom host
      const host = normalizeDomain(b.fullHost || b.subdomain);
      if (!host || !isValidDomain(host)) {
        return { ok: false, error: `自定义域名「${b.fullHost || b.subdomain}」格式无效` };
      }
    }

    const full = b.fullHost.trim().toLowerCase();
    if (seenFullHosts.has(full)) {
      return { ok: false, error: `存在重复的域名配置：${full}` };
    }
    seenFullHosts.add(full);
  }

  return { ok: true };
}

