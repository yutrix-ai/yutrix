import {
  FIRST_TOKEN_TIMEOUT_MESSAGE,
  STREAM_CHUNK_TIMEOUT_MESSAGE,
} from "./clientClosed";

export type TimeoutEjectKey = {
  routeId: string;
  providerId: string;
  modelId: string;
};

export function timeoutEjectKey(key: TimeoutEjectKey): string {
  return `${key.routeId}::${key.providerId}::${key.modelId}`;
}

export type TimeoutEjectProbeSpec = {
  url: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
};

type TimeoutEjectRecord = {
  ejectedAt: number;
  probeInFlight: boolean;
  probeSpec?: TimeoutEjectProbeSpec;
};

export function isNoAnswerTimeoutFailure(input: {
  status?: number;
  message?: string;
}): boolean {
  const message = String(input.message || "");
  if (message === STREAM_CHUNK_TIMEOUT_MESSAGE) return false;
  if (message === FIRST_TOKEN_TIMEOUT_MESSAGE) return true;
  if (input.status !== 504) return false;
  return /aborted|timeout|超时/i.test(message);
}

export function parseRouteL0Identity(route: {
  providerId?: string;
  modelId?: string;
  targets?: unknown;
} | null | undefined): { providerId: string; modelId: string } | null {
  if (!route) return null;
  try {
    const raw = typeof route.targets === "string" ? JSON.parse(route.targets) : route.targets;
    if (Array.isArray(raw) && raw[0]?.providerId && raw[0]?.modelId) {
      return { providerId: String(raw[0].providerId), modelId: String(raw[0].modelId) };
    }
  } catch {
    /* fall through to top-level fields */
  }
  if (route.providerId && route.modelId) {
    return { providerId: String(route.providerId), modelId: String(route.modelId) };
  }
  return null;
}

export class TimeoutEjectStore {
  private records = new Map<string, TimeoutEjectRecord>();

  reset(): void {
    this.records.clear();
  }

  isEjected(key: TimeoutEjectKey): boolean {
    return this.records.has(timeoutEjectKey(key));
  }

  shouldSkipL0(enabled: boolean, key: TimeoutEjectKey): boolean {
    return !!enabled && this.isEjected(key);
  }

  /** Eject L0. Returns whether a new background probe should start. */
  markEjected(key: TimeoutEjectKey, probeSpec?: TimeoutEjectProbeSpec): { startProbe: boolean } {
    const id = timeoutEjectKey(key);
    const existing = this.records.get(id);
    if (existing) {
      if (probeSpec) existing.probeSpec = probeSpec;
      if (existing.probeInFlight) return { startProbe: false };
      if (!existing.probeSpec) return { startProbe: false };
      existing.probeInFlight = true;
      return { startProbe: true };
    }
    this.records.set(id, { ejectedAt: Date.now(), probeInFlight: !!probeSpec, probeSpec });
    return { startProbe: !!probeSpec };
  }

  probeSpec(key: TimeoutEjectKey): TimeoutEjectProbeSpec | undefined {
    return this.records.get(timeoutEjectKey(key))?.probeSpec;
  }

  finishProbe(key: TimeoutEjectKey, success: boolean): void {
    const id = timeoutEjectKey(key);
    const existing = this.records.get(id);
    if (!existing) return;
    if (success) {
      this.records.delete(id);
      return;
    }
    existing.probeInFlight = false;
  }

  observingForRoute(routeId: string): boolean {
    if (!routeId) return false;
    const prefix = `${routeId}::`;
    for (const id of this.records.keys()) {
      if (id.startsWith(prefix)) return true;
    }
    return false;
  }
}

export const globalTimeoutEjectStore = new TimeoutEjectStore();

export function timeoutEjectAdminFields(route: {
  id?: string;
  timeoutEjectEnabled?: boolean | number | null;
  providerId?: string;
  modelId?: string;
  targets?: unknown;
}): { timeoutEjectEnabled: boolean; timeoutEjectObserving: boolean } {
  const timeoutEjectEnabled = !!route?.timeoutEjectEnabled;
  return {
    timeoutEjectEnabled,
    timeoutEjectObserving: timeoutEjectEnabled && globalTimeoutEjectStore.observingForRoute(String(route?.id || "")),
  };
}

export function isFunnelL0Attempt(attempt: { targetIndex?: number } | null | undefined): boolean {
  return !!attempt && (Number(attempt.targetIndex) || 0) === 0;
}

export function timeoutEjectKeyFromAttempt(
  route: { id?: string } | null | undefined,
  attempt: { providerId?: string; modelId?: string } | null | undefined,
): TimeoutEjectKey | null {
  if (!route?.id || !attempt?.providerId || !attempt?.modelId) return null;
  return { routeId: String(route.id), providerId: String(attempt.providerId), modelId: String(attempt.modelId) };
}

export function shouldSkipCurrentAttempt(
  enabled: boolean,
  route: { id?: string } | null | undefined,
  attempt: { providerId?: string; modelId?: string; targetIndex?: number } | null | undefined,
  store: TimeoutEjectStore = globalTimeoutEjectStore,
): boolean {
  if (!enabled || !isFunnelL0Attempt(attempt)) return false;
  const key = timeoutEjectKeyFromAttempt(route, attempt);
  if (!key) return false;
  return store.shouldSkipL0(true, key);
}

export function noAnswerTimeoutMessageFrom(responseData: any, fallback?: string): string {
  return String(
    responseData?.terminalError?.message
    || responseData?.data?.error?.message
    || fallback
    || "",
  );
}

export function buildTimeoutEjectProbeSpec(input: {
  baseUrl: string;
  upstreamPath: string;
  headers: Record<string, string>;
  body: unknown;
  timeoutMs: number;
}): TimeoutEjectProbeSpec {
  let url = `${input.baseUrl}${input.upstreamPath}`;
  if (input.baseUrl.endsWith(input.upstreamPath)) url = input.baseUrl;
  return {
    url,
    headers: { ...input.headers },
    body: typeof input.body === "string" ? input.body : JSON.stringify(input.body ?? {}),
    timeoutMs: Math.max(1, Math.floor(input.timeoutMs || 0) || 1),
  };
}

export function maybeNoteTimeoutEject(input: {
  enabled: boolean;
  route?: { id?: string } | null;
  attempt?: { providerId?: string; modelId?: string; targetIndex?: number } | null;
  status?: number;
  message?: string;
  probeSpec?: TimeoutEjectProbeSpec;
  store?: TimeoutEjectStore;
}): void {
  if (!input.enabled || !isFunnelL0Attempt(input.attempt)) return;
  if (!isNoAnswerTimeoutFailure({ status: input.status, message: input.message })) return;
  const key = timeoutEjectKeyFromAttempt(input.route, input.attempt);
  if (!key) return;
  noteNoAnswerTimeoutEject({
    store: input.store,
    enabled: true,
    key,
    probeSpec: input.probeSpec,
  });
}

export async function runDiscardedUpstreamProbe(input: {
  url: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}): Promise<boolean> {
  const timeoutMs = Math.max(1, Math.floor(input.timeoutMs || 0) || 1);
  const fetchImpl = input.fetchImpl || fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(input.url, {
      method: "POST",
      headers: input.headers,
      body: input.body,
      signal: controller.signal,
    } as any);
    if (!response || (response as any).ok === false) return false;
    const body = (response as any).body;
    if (body && typeof body.getReader === "function") {
      const reader = body.getReader();
      try {
        await reader.read();
        return true;
      } finally {
        await reader.cancel().catch(() => {});
      }
    }
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function timeoutEjectEnabled(route: { timeoutEjectEnabled?: boolean | number | null } | null | undefined): boolean {
  return !!route?.timeoutEjectEnabled;
}

export function noteNoAnswerTimeoutEject(input: {
  store?: TimeoutEjectStore;
  enabled: boolean;
  key: TimeoutEjectKey | null;
  probeSpec?: TimeoutEjectProbeSpec;
}): void {
  if (!input.enabled || !input.key) return;
  const store = input.store || globalTimeoutEjectStore;
  const { startProbe } = store.markEjected(input.key, input.probeSpec);
  const spec = input.probeSpec || store.probeSpec(input.key);
  if (startProbe && spec) {
    launchDiscardedUpstreamProbe({ store, key: input.key, ...spec });
  }
}

export function launchDiscardedUpstreamProbe(input: {
  store: TimeoutEjectStore;
  key: TimeoutEjectKey;
  url: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}): void {
  void runDiscardedUpstreamProbe(input)
    .then((ok) => {
      input.store.finishProbe(input.key, ok);
    })
    .catch(() => {
      input.store.finishProbe(input.key, false);
    });
}
