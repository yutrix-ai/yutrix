/**
 * Per-route model profiles: extra funnel tables selected by the client's
 * request `model` id. The route's own `routingMode` / `targets` columns are the
 * default table; a request whose model id matches no profile uses it.
 *
 * Stored as JSON text in `endpoint_routes.modelProfiles`. NULL / empty means
 * the route only has the default table.
 */

export interface RouteModelProfile {
  /** Client-facing model id that selects this table. */
  name: string;
  routingMode: string;
  targets: any[];
}

export const MODEL_PROFILE_NAME_MAX_LENGTH = 128;

/** Names that cannot be used because they refer to the default table. */
export const RESERVED_MODEL_PROFILE_NAMES = ["default"] as const;

export function normalizeModelProfileName(name: unknown): string {
  return typeof name === "string" ? name.trim() : "";
}

/** Matching key: trimmed and case-insensitive. */
export function modelProfileKey(name: unknown): string {
  return normalizeModelProfileName(name).toLowerCase();
}

/**
 * Lenient parse for runtime / display. Drops malformed entries instead of
 * throwing so a corrupt column can never break the default table.
 */
export function parseRouteModelProfiles(raw: unknown): RouteModelProfile[] {
  let value: unknown = raw;
  if (typeof value === "string") {
    if (!value.trim()) return [];
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>();
  const result: RouteModelProfile[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const name = normalizeModelProfileName((item as any).name);
    const key = name.toLowerCase();
    if (!key || seen.has(key)) continue;
    const targets = Array.isArray((item as any).targets) ? (item as any).targets : [];
    if (targets.length === 0) continue;
    seen.add(key);
    result.push({
      name,
      routingMode: typeof (item as any).routingMode === "string" ? (item as any).routingMode : "classic",
      targets,
    });
  }
  return result;
}

export function findRouteModelProfile(
  profiles: RouteModelProfile[],
  clientModelId: unknown,
): RouteModelProfile | null {
  const key = modelProfileKey(clientModelId);
  if (!key || profiles.length === 0) return null;
  return profiles.find((p) => modelProfileKey(p.name) === key) || null;
}

export type ModelProfileNameIssue =
  | { ok: true }
  | { ok: false; code: "required" | "too_long" | "reserved" | "duplicate"; name: string };

/** Validates the names of a profile list as a whole (used by both UI and API). */
export function validateModelProfileNames(names: unknown[]): ModelProfileNameIssue {
  const seen = new Set<string>();
  for (const raw of names) {
    const name = normalizeModelProfileName(raw);
    if (!name) return { ok: false, code: "required", name };
    if (name.length > MODEL_PROFILE_NAME_MAX_LENGTH) return { ok: false, code: "too_long", name };
    const key = name.toLowerCase();
    if ((RESERVED_MODEL_PROFILE_NAMES as readonly string[]).includes(key)) {
      return { ok: false, code: "reserved", name };
    }
    if (seen.has(key)) return { ok: false, code: "duplicate", name };
    seen.add(key);
  }
  return { ok: true };
}

export function modelProfileNameIssueMessage(issue: ModelProfileNameIssue): string {
  if (issue.ok) return "";
  switch (issue.code) {
    case "required":
      return "路由表名称（模型 ID）不能为空";
    case "too_long":
      return `路由表名称过长：${issue.name}`;
    case "reserved":
      return `路由表名称不能使用保留字：${issue.name}`;
    case "duplicate":
      return `路由表名称重复：${issue.name}`;
  }
}
