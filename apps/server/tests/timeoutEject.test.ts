import { describe, expect, it } from "vitest";
import {
  FIRST_TOKEN_TIMEOUT_MESSAGE,
  STREAM_CHUNK_TIMEOUT_MESSAGE,
} from "../src/routes/gateway/clientClosed";
import {
  TimeoutEjectStore,
  globalTimeoutEjectStore,
  isFunnelL0Attempt,
  isNoAnswerTimeoutFailure,
  launchDiscardedUpstreamProbe,
  maybeNoteTimeoutEject,
  parseRouteL0Identity,
  runDiscardedUpstreamProbe,
  shouldSkipCurrentAttempt,
  timeoutEjectAdminFields,
  timeoutEjectKey,
} from "../src/routes/gateway/timeoutEject";

describe("timeout eject store", () => {
  it("does not skip L0 when the switch is off even if a record exists", () => {
    const store = new TimeoutEjectStore();
    const key = { routeId: "r1", providerId: "p1", modelId: "m1" };
    store.markEjected(key);
    expect(store.shouldSkipL0(false, key)).toBe(false);
    expect(store.shouldSkipL0(true, key)).toBe(true);
  });

  it("isolates ejection to route + L0 provider/model", () => {
    const store = new TimeoutEjectStore();
    store.markEjected({ routeId: "r1", providerId: "p1", modelId: "m1" });
    expect(store.shouldSkipL0(true, { routeId: "r1", providerId: "p1", modelId: "m1" })).toBe(true);
    expect(store.shouldSkipL0(true, { routeId: "r2", providerId: "p1", modelId: "m1" })).toBe(false);
    expect(store.shouldSkipL0(true, { routeId: "r1", providerId: "p1", modelId: "m2" })).toBe(false);
  });

  it("starts at most one probe per ejected key and clears on probe success", () => {
    const store = new TimeoutEjectStore();
    const key = { routeId: "r1", providerId: "p1", modelId: "m1" };
    const spec = { url: "https://l0.test/v1/chat/completions", headers: {}, body: "{}", timeoutMs: 100 };
    expect(store.markEjected(key).startProbe).toBe(false);
    expect(store.isEjected(key)).toBe(true);
    expect(store.markEjected(key, spec).startProbe).toBe(true);
    expect(store.markEjected(key, spec).startProbe).toBe(false);
    store.finishProbe(key, false);
    expect(store.isEjected(key)).toBe(true);
    expect(store.markEjected(key).startProbe).toBe(true);
    store.finishProbe(key, true);
    expect(store.isEjected(key)).toBe(false);
    expect(store.shouldSkipL0(true, key)).toBe(false);
  });

  it("skips only funnel L0 of the ejected route and notes no-answer timeouts", () => {
    const store = new TimeoutEjectStore();
    const route = { id: "r1", timeoutEjectEnabled: true, providerId: "p1", modelId: "m1" };
    const l0 = { providerId: "p1", modelId: "m1", targetIndex: 0 };
    expect(isFunnelL0Attempt({ targetIndex: 1 })).toBe(false);
    expect(shouldSkipCurrentAttempt(true, route, l0, store)).toBe(false);
    maybeNoteTimeoutEject({
      enabled: true,
      route,
      attempt: l0,
      status: 504,
      message: FIRST_TOKEN_TIMEOUT_MESSAGE,
      store,
    });
    expect(shouldSkipCurrentAttempt(true, route, l0, store)).toBe(true);
    expect(shouldSkipCurrentAttempt(true, route, { ...l0, targetIndex: 1 }, store)).toBe(false);
    maybeNoteTimeoutEject({
      enabled: true,
      route,
      attempt: { providerId: "p1", modelId: "m1", targetIndex: 1 },
      status: 504,
      message: FIRST_TOKEN_TIMEOUT_MESSAGE,
      store,
    });
    expect(store.observingForRoute("r1")).toBe(true);
    expect(store.observingForRoute("r2")).toBe(false);
  });

  it("only treats first-answer timeouts as eject triggers, not stream idle", () => {
    expect(isNoAnswerTimeoutFailure({ status: 504, message: FIRST_TOKEN_TIMEOUT_MESSAGE })).toBe(true);
    expect(isNoAnswerTimeoutFailure({ status: 504, message: "This operation was aborted" })).toBe(true);
    expect(isNoAnswerTimeoutFailure({ status: 504, message: STREAM_CHUNK_TIMEOUT_MESSAGE })).toBe(false);
    expect(isNoAnswerTimeoutFailure({ status: 502, message: FIRST_TOKEN_TIMEOUT_MESSAGE })).toBe(true);
    expect(isNoAnswerTimeoutFailure({ status: 429, message: "rate limit" })).toBe(false);
  });

  it("parses funnel L0 from targets JSON", () => {
    expect(
      parseRouteL0Identity({
        providerId: "legacy",
        modelId: "legacy-m",
        targets: JSON.stringify([{ providerId: "p0", modelId: "m0" }, { providerId: "p1", modelId: "m1" }]),
      }),
    ).toEqual({ providerId: "p0", modelId: "m0" });
    expect(timeoutEjectKey({ routeId: "r", providerId: "p", modelId: "m" })).toBe("r::p::m");
  });

  it("admin observing follows the live store only when the switch is on", () => {
    globalTimeoutEjectStore.reset();
    const route = { id: "r-admin", timeoutEjectEnabled: true, providerId: "p1", modelId: "m1" };
    expect(timeoutEjectAdminFields(route)).toEqual({ timeoutEjectEnabled: true, timeoutEjectObserving: false });
    globalTimeoutEjectStore.markEjected({ routeId: "r-admin", providerId: "p1", modelId: "m1" });
    expect(timeoutEjectAdminFields(route).timeoutEjectObserving).toBe(true);
    expect(timeoutEjectAdminFields({ ...route, timeoutEjectEnabled: false }).timeoutEjectObserving).toBe(false);
    globalTimeoutEjectStore.reset();
  });
});

describe("discarded upstream probe", () => {
  it("returns true on first byte and does not expose the body to the caller as a user payload", async () => {
    const chunks: string[] = [];
    const ok = await runDiscardedUpstreamProbe({
      url: "https://l0.test/v1/chat/completions",
      headers: { "content-type": "application/json" },
      body: "{\"model\":\"m\"}",
      timeoutMs: 200,
      fetchImpl: async () =>
        new Response("secret-user-text", { status: 200, headers: { "content-type": "text/plain" } }),
    });
    expect(ok).toBe(true);
    expect(chunks).toEqual([]);
  });

  it("returns false when the probe is aborted by timeout", async () => {
    const ok = await runDiscardedUpstreamProbe({
      url: "https://l0.test/v1/chat/completions",
      headers: {},
      body: "{}",
      timeoutMs: 20,
      fetchImpl: async (_url, init) => {
        await new Promise((_, reject) => {
          const signal = (init as any)?.signal as AbortSignal;
          signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        });
        return new Response("late", { status: 200 });
      },
    });
    expect(ok).toBe(false);
  });

  it("clears ejection when a launched probe succeeds", async () => {
    const store = new TimeoutEjectStore();
    const key = { routeId: "r1", providerId: "p1", modelId: "m1" };
    expect(store.markEjected(key).startProbe).toBe(false);
    launchDiscardedUpstreamProbe({
      store,
      key,
      url: "https://l0.test/v1/chat/completions",
      headers: {},
      body: "{}",
      timeoutMs: 200,
      fetchImpl: async () => new Response("ok", { status: 200 }),
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(store.isEjected(key)).toBe(false);
  });
});
