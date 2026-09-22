export const ROUTE_IDENTITY_ERROR = {
  NAME_REQUIRED: "route_name_required",
  NAME_CONFLICT: "route_name_conflict",
  MATCHING_KEY_CONFLICT: "route_matching_key_conflict",
} as const;

export type RouteIdentityErrorCode =
  (typeof ROUTE_IDENTITY_ERROR)[keyof typeof ROUTE_IDENTITY_ERROR];

export const ROUTE_IDENTITY_ERROR_MESSAGE: Record<RouteIdentityErrorCode, string> = {
  [ROUTE_IDENTITY_ERROR.NAME_REQUIRED]: "规则名称不能为空",
  [ROUTE_IDENTITY_ERROR.NAME_CONFLICT]: "规则名称已存在",
  [ROUTE_IDENTITY_ERROR.MATCHING_KEY_CONFLICT]: "该 Host、Path 与 Protocol 组合已有路由",
};

export function trimRouteName(name: unknown): string {
  return String(name ?? "").trim();
}

export function isBlankRouteName(name: unknown): boolean {
  return trimRouteName(name).length === 0;
}

export function routeNamesEqual(a: unknown, b: unknown): boolean {
  const left = trimRouteName(a);
  const right = trimRouteName(b);
  if (!left || !right) return false;
  return left === right;
}

export function nextCopyRouteName(
  sourceName: string,
  existingNames: string[],
  copyLabel = "副本",
): string {
  const base = trimRouteName(sourceName);
  const label = trimRouteName(copyLabel) || "副本";
  const taken = new Set(existingNames.map((name) => trimRouteName(name)).filter(Boolean));
  const first = base ? `${base} ${label}` : label;
  if (!taken.has(first)) return first;
  let n = 2;
  while (n < 10_000) {
    const candidate = base ? `${base} ${label} ${n}` : `${label} ${n}`;
    if (!taken.has(candidate)) return candidate;
    n += 1;
  }
  return base ? `${base} ${label} ${Date.now()}` : `${label} ${Date.now()}`;
}

import { getMainDomain, parseRouteHosts } from "./domain";

export function normalizeRouteHostKey(
  hostInput: string,
  mainDomain: string | string[],
  options?: { fallbackLocalhost?: boolean },
): string {
  const trimmed = String(hostInput ?? "").trim();
  if (!trimmed || trimmed === "*" || trimmed.toLowerCase() === "all") return "*";
  if (trimmed.includes(".")) return trimmed.toLowerCase();
  const domain = getMainDomain(mainDomain);
  if (domain) return `${trimmed.toLowerCase()}.${domain}`;
  if (options?.fallbackLocalhost === false) return trimmed.toLowerCase();
  return `${trimmed.toLowerCase()}.localhost`;
}

export function normalizeRoutePath(path: unknown): string {
  return String(path ?? "").trim();
}

export function normalizeRouteProtocol(protocol: unknown): string {
  return String(protocol ?? "").trim().toLowerCase();
}

export interface RouteMatchingKey {
  host: string;
  hosts?: string[];
  path: string;
  protocol: string;
}

export function normalizeRouteMatchingKey(input: {
  hostInput: string;
  hosts?: string[];
  path: string;
  protocol: string;
  mainDomain: string | string[];
  fallbackLocalhost?: boolean;
}): RouteMatchingKey {
  const rawList =
    input.hosts && input.hosts.length > 0
      ? input.hosts
      : parseRouteHosts(input.hostInput);

  const normalizedHosts = rawList.map((h) =>
    normalizeRouteHostKey(h, input.mainDomain, {
      fallbackLocalhost: input.fallbackLocalhost,
    }),
  );

  return {
    host: normalizedHosts[0] || "*",
    hosts: normalizedHosts,
    path: normalizeRoutePath(input.path),
    protocol: normalizeRouteProtocol(input.protocol),
  };
}

export function matchingKeysEqual(a: RouteMatchingKey, b: RouteMatchingKey): boolean {
  if (a.path !== b.path || a.protocol !== b.protocol) return false;

  const aHosts = a.hosts && a.hosts.length > 0 ? a.hosts : [a.host];
  const bHosts = b.hosts && b.hosts.length > 0 ? b.hosts : [b.host];

  const aSet = new Set(aHosts);
  for (const bh of bHosts) {
    if (aSet.has(bh)) return true;
  }
  return false;
}

export interface RouteIdentityRecord {
  id: string;
  name: string;
  host: string;
  hosts?: string[];
  path: string;
  incomingProtocol: string;
}

export function findRouteNameCollision(
  name: unknown,
  records: RouteIdentityRecord[],
  excludeRouteId?: string | null,
): RouteIdentityRecord | null {
  const trimmed = trimRouteName(name);
  if (!trimmed) return null;
  return (
    records.find((record) => {
      if (excludeRouteId && record.id === excludeRouteId) return false;
      return routeNamesEqual(record.name, trimmed);
    }) ?? null
  );
}

export function findMatchingKeyCollision(
  key: RouteMatchingKey,
  records: RouteIdentityRecord[],
  options: {
    excludeRouteId?: string | null;
    mainDomain: string | string[];
    fallbackLocalhost?: boolean;
  },
): RouteIdentityRecord | null {
  return (
    records.find((record) => {
      if (options.excludeRouteId && record.id === options.excludeRouteId) return false;
      const existing = normalizeRouteMatchingKey({
        hostInput: record.host,
        hosts: record.hosts,
        path: record.path,
        protocol: record.incomingProtocol,
        mainDomain: options.mainDomain,
        fallbackLocalhost: options.fallbackLocalhost,
      });
      return matchingKeysEqual(key, existing);
    }) ?? null
  );
}

export interface RouteIdentityIssue {
  code: RouteIdentityErrorCode;
  error: string;
  conflictName?: string;
}

export function collectRouteIdentityIssues(input: {
  name: unknown;
  hostInput: string;
  hosts?: string[];
  path: string;
  protocol: string;
  records: RouteIdentityRecord[];
  mainDomain: string | string[];
  excludeRouteId?: string | null;
  requireName?: boolean;
  fallbackLocalhost?: boolean;
}): RouteIdentityIssue[] {
  const issues: RouteIdentityIssue[] = [];
  const requireName = input.requireName !== false;
  if (requireName && isBlankRouteName(input.name)) {
    issues.push({
      code: ROUTE_IDENTITY_ERROR.NAME_REQUIRED,
      error: ROUTE_IDENTITY_ERROR_MESSAGE[ROUTE_IDENTITY_ERROR.NAME_REQUIRED],
    });
  } else {
    const nameHit = findRouteNameCollision(input.name, input.records, input.excludeRouteId);
    if (nameHit) {
      issues.push({
        code: ROUTE_IDENTITY_ERROR.NAME_CONFLICT,
        error: ROUTE_IDENTITY_ERROR_MESSAGE[ROUTE_IDENTITY_ERROR.NAME_CONFLICT],
        conflictName: trimRouteName(nameHit.name),
      });
    }
  }

  const key = normalizeRouteMatchingKey({
    hostInput: input.hostInput,
    hosts: input.hosts,
    path: input.path,
    protocol: input.protocol,
    mainDomain: input.mainDomain,
    fallbackLocalhost: input.fallbackLocalhost,
  });
  const keyHit = findMatchingKeyCollision(key, input.records, {
    excludeRouteId: input.excludeRouteId,
    mainDomain: input.mainDomain,
    fallbackLocalhost: input.fallbackLocalhost,
  });
  if (keyHit) {
    issues.push({
      code: ROUTE_IDENTITY_ERROR.MATCHING_KEY_CONFLICT,
      error: ROUTE_IDENTITY_ERROR_MESSAGE[ROUTE_IDENTITY_ERROR.MATCHING_KEY_CONFLICT],
      conflictName: trimRouteName(keyHit.name) || keyHit.id,
    });
  }
  return issues;
}

export function matchingKeySubmitBlocked(issues: RouteIdentityIssue[]): boolean {
  return issues.some((issue) => issue.code === ROUTE_IDENTITY_ERROR.MATCHING_KEY_CONFLICT);
}

export interface RouteCopySource {
  name: string;
  host: string;
  hosts?: string[];
  path: string;
  incomingProtocol: string;
  targets?: unknown;
  timeoutMs?: number;
  retryCount?: number;
  queueTimeoutMs?: number;
  maxBodyMb?: number;
  enabled?: boolean;
  allowClientModel?: boolean;
  ipWhitelist?: string;
  authorizedUserIds?: string[];
  authorizedGroupIds?: string[];
  fallbackMatchTarget?: boolean;
  schedules?: unknown;
}

export interface RouteCopyDraft {
  name: string;
  hostInput: string;
  hosts: string[];
  path: string;
  incomingProtocol: string;
  targets: unknown[];
  timeoutMs: number;
  retryCount: number;
  queueTimeoutMs: number;
  maxBodyMb: number;
  enabled: boolean;
  allowClientModel: boolean;
  ipWhitelist: string;
  authorizedUserIds: string[];
  authorizedGroupIds: string[];
  fallbackMatchTarget: boolean;
  schedules: unknown;
}

function parseCopiedTargets(targets: unknown): unknown[] {
  if (!targets) return [];
  if (typeof targets === "string") {
    try {
      const parsed = JSON.parse(targets);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return Array.isArray(targets) ? [...targets] : [];
}

export function copySourceHostInput(host: string): string {
  const trimmed = String(host ?? "").trim();
  if (!trimmed || trimmed === "all" || trimmed === "*") return "*";
  return trimmed;
}

export function buildCopiedRouteDraft(
  source: RouteCopySource,
  existingNames: string[],
  copyLabel?: string,
): RouteCopyDraft {
  const parsedHosts =
    source.hosts && source.hosts.length > 0
      ? source.hosts
      : parseRouteHosts(source.host);

  return {
    name: nextCopyRouteName(source.name, existingNames, copyLabel),
    hostInput: copySourceHostInput(parsedHosts.join(", ")),
    hosts: parsedHosts,
    path: source.path || "",
    incomingProtocol: source.incomingProtocol || "openai",
    targets: parseCopiedTargets(source.targets),
    timeoutMs: source.timeoutMs ?? 0,
    retryCount: source.retryCount ?? 3,
    queueTimeoutMs: source.queueTimeoutMs ?? 0,
    maxBodyMb: source.maxBodyMb ?? 0,
    enabled: source.enabled !== false,
    allowClientModel: !!source.allowClientModel,
    ipWhitelist: source.ipWhitelist || "",
    authorizedUserIds: [...(source.authorizedUserIds || [])],
    authorizedGroupIds: [...(source.authorizedGroupIds || [])],
    fallbackMatchTarget: !!source.fallbackMatchTarget,
    schedules: source.schedules ?? null,
  };
}
