import {
  findRouteModelProfile,
  modelProfileNameIssueMessage,
  normalizeModelProfileName,
  parseRouteModelProfiles,
  validateModelProfileNames,
  type RouteModelProfile,
} from "@promptgate/shared";
import { validateRouteConfig } from "../utils/routeValidator";
import { coerceLegacyRouteForDisplay, normalizeRoutingModeInput } from "./opcAgentRouting";

export type ModelProfilesValidation =
  | { ok: true; stored: string | null }
  | { ok: false; error: string };

/**
 * Validate admin input for `modelProfiles` and produce the stored JSON text.
 * Empty list stores NULL so the route is byte-identical to one that never had profiles.
 */
export async function validateModelProfilesInput(
  input: unknown,
  incomingProtocol: string,
): Promise<ModelProfilesValidation> {
  if (input === null || input === undefined) return { ok: true, stored: null };
  if (!Array.isArray(input)) return { ok: false, error: "路由表配置格式无效" };
  if (input.length === 0) return { ok: true, stored: null };

  const nameIssue = validateModelProfileNames(input.map((p: any) => p?.name));
  if (!nameIssue.ok) return { ok: false, error: modelProfileNameIssueMessage(nameIssue) };

  const stored: RouteModelProfile[] = [];
  for (const raw of input as any[]) {
    const name = normalizeModelProfileName(raw?.name);
    const targets = Array.isArray(raw?.targets) ? raw.targets : [];
    const result = await validateRouteConfig({
      incomingProtocol,
      enabled: true,
      retryCount: undefined as unknown as number,
      targets,
    });
    if (!result.ok) {
      return { ok: false, error: `路由表「${name}」：${result.error}` };
    }
    stored.push({
      name,
      routingMode: normalizeRoutingModeInput(raw?.routingMode),
      targets: result.resolvedTargets!,
    });
  }
  return { ok: true, stored: JSON.stringify(stored) };
}

/** Admin API read shape; legacy opc layers collapse like the default table does. */
export function modelProfilesForDisplay(raw: unknown): RouteModelProfile[] {
  return parseRouteModelProfiles(raw).map((profile) => {
    const coerced = coerceLegacyRouteForDisplay({
      routingMode: profile.routingMode,
      targets: profile.targets,
    });
    return {
      name: profile.name,
      routingMode: normalizeRoutingModeInput(coerced.routingMode),
      targets: Array.isArray(coerced.targets) ? coerced.targets : profile.targets,
    };
  });
}

/**
 * Select the funnel table for this request. A miss returns the route object
 * untouched, so every route without a matching profile keeps the exact
 * pre-existing behavior.
 *
 * A hit swaps only the routing table (mode + layers) and the L0 mirror columns
 * derived from it. Route-level settings (best effort, timeouts, retries, auth)
 * stay shared. Schedules and client-model override are bypassed because the
 * request's model id has already been consumed to pick this table.
 */
export function applyRouteModelProfile<T extends Record<string, any>>(
  route: T,
  clientModelId: unknown,
): { route: T; profileName: string | null } {
  if (!route?.modelProfiles) return { route, profileName: null };
  const profile = findRouteModelProfile(parseRouteModelProfiles(route.modelProfiles), clientModelId);
  if (!profile) return { route, profileName: null };

  const first = profile.targets[0] || {};
  return {
    route: {
      ...route,
      routingMode: normalizeRoutingModeInput(profile.routingMode),
      targets: JSON.stringify(profile.targets),
      providerId: first.providerId || "",
      providerProtocol: first.providerProtocol || "openai",
      modelId: first.modelId || "",
      promptPolicyId: first.promptPolicyId || null,
      strategyRoutingEnabled: false,
      strategyRoutingRules: null,
      fallbackStrategyRoutingRules: null,
      allowClientModel: false,
      schedules: null,
    },
    profileName: profile.name,
  };
}
