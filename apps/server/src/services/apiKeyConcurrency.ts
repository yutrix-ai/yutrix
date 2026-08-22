/** New user API keys: high enough for agent sidecar + subagents, still a cap. */
export const FACTORY_DEFAULT_API_KEY_CONCURRENCY = 10;

/** Previous factory value. Treat as unset so existing installs pick up the new default. */
export const LEGACY_FACTORY_DEFAULT_API_KEY_CONCURRENCY = 2;

export function parseDefaultApiKeyConcurrency(raw: unknown): number {
  const parsed = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return FACTORY_DEFAULT_API_KEY_CONCURRENCY;
  }
  if (parsed === LEGACY_FACTORY_DEFAULT_API_KEY_CONCURRENCY) {
    return FACTORY_DEFAULT_API_KEY_CONCURRENCY;
  }
  return parsed;
}

/** Ordinary users cannot set concurrency; ignore whatever they pass. */
export function concurrencyLimitForNewUserKey(
  requested: unknown,
  storedDefault: unknown,
): number {
  void requested;
  return parseDefaultApiKeyConcurrency(storedDefault);
}
