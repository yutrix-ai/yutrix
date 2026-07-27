import { ProviderAdapter, ProviderAdapterContext, ProviderAdapterResolution } from "./types";
import { transparentAdapter } from "./transparentAdapter";
import { googleAdapter } from "./googleAdapter";
import { openRouterAdapter } from "./openRouterAdapter";

export const adaptersRegistry: ProviderAdapter[] = [
  openRouterAdapter,
  googleAdapter,
];

/**
 * Two-phase adapter resolution:
 *   Phase 1: URL-first adapters (priority === "url") — exact hostname/URL match.
 *   Phase 2: Legacy adapters (priority === "legacy") — model name / protocol fallback.
 *   Default: transparentAdapter (no-op pass-through).
 *
 * Priority is explicitly declared on each adapter, not implicit from array order.
 */
export function resolveProviderAdapterDetailed(context: ProviderAdapterContext): ProviderAdapterResolution {
  const disabledEnv = process.env.PROMPTGATE_DISABLED_PROVIDER_ADAPTERS || "";
  let disabledList: string[] = [];
  try {
    disabledList = disabledEnv
      .split(",")
      .map(s => s.trim().toLowerCase())
      .filter(Boolean);
  } catch (err) {
    // Graceful fallback for environment format errors
  }

  const isDisabled = (adapter: ProviderAdapter): boolean =>
    disabledList.includes(adapter.id.toLowerCase());

  const tryMatch = (adapter: ProviderAdapter): boolean => {
    try {
      return adapter.match(context);
    } catch (err) {
      return false; // Graceful error isolation
    }
  };

  for (const adapter of adaptersRegistry) {
    if (tryMatch(adapter)) {
      if (isDisabled(adapter)) {
        return { adapter: transparentAdapter, ownerId: adapter.id, disabled: true };
      }
      return { adapter, ownerId: adapter.id, disabled: false };
    }
  }

  return { adapter: transparentAdapter, ownerId: null, disabled: false };
}

export function resolveProviderAdapter(context: ProviderAdapterContext): ProviderAdapter {
  return resolveProviderAdapterDetailed(context).adapter;
}
