import { describe, it, expect, beforeEach } from "vitest";
import { SessionQueueManager, SessionQueueTimeoutError } from "../src/routes/gateway/sessionQueueManager";
import {
  runWithSessionAdmission,
  sessionLockModeFor,
} from "../src/routes/gateway/sessionAdmission";
import { classifyGatewayRequestClass } from "../src/services/requestRoutingClass";

const SIDECAR_STAGE1 =
  "Stage 1 does NOT apply user intent or ALLOW exceptions — stage 2 will handle those.\n" +
  "Respond with <severity>N</severity> ONLY. Grade HARM ONLY — do NOT reduce for user intent. No other text.";

function sidecarBody() {
  return {
    model: "gemini-3.6-flash-tiered",
    messages: [{
      role: "user",
      content: `<transcript>\nhello\n</transcript>\n${SIDECAR_STAGE1}`,
    }],
  };
}

function userIntentBody() {
  return {
    messages: [{ role: "user", content: "implement the login form" }],
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for condition");
}

describe("session admission policy (request class table)", () => {
  it("maps sidecar to no lock and other known classes to a short lock", () => {
    expect(sessionLockModeFor("client_sidecar")).toBe("none");
    expect(sessionLockModeFor("user_intent")).toBe("short");
    expect(sessionLockModeFor("tool_continuation")).toBe("short");
  });

  it("fail-closes unknown request classes to a short lock", () => {
    expect(sessionLockModeFor("not_a_real_class")).toBe("short");
  });
});

describe("runWithSessionAdmission", () => {
  let manager: SessionQueueManager;

  beforeEach(() => {
    manager = new SessionQueueManager({
      defaultTimeoutMs: 1000,
      maxQueueCapacity: 8,
      ttlMs: 500,
    });
  });

  it("lets a second same-session request overlap after the short critical section instead of waiting for the first stream", async () => {
    const sessionId = "session-overlap";
    const events: string[] = [];
    let releaseStream1: () => void = () => {};
    const stream1 = new Promise<void>((resolve) => {
      releaseStream1 = resolve;
    });

    const first = runWithSessionAdmission({
      sessionId,
      requestClass: "user_intent",
      manager,
      criticalSection: async () => {
        events.push("cs1");
      },
      onAdmitted: async () => {
        events.push("stream1-start");
        await stream1;
        events.push("stream1-end");
        return "one";
      },
    });

    await waitFor(() => events.includes("stream1-start"));

    const second = runWithSessionAdmission({
      sessionId,
      requestClass: "user_intent",
      manager,
      criticalSection: async () => {
        events.push("cs2");
      },
      onAdmitted: async () => {
        events.push("stream2-start");
        return "two";
      },
    });

    await waitFor(() => events.includes("stream2-start"));
    expect(events).toContain("cs1");
    expect(events).toContain("cs2");
    expect(events).toContain("stream1-start");
    expect(events).not.toContain("stream1-end");

    releaseStream1();
    await expect(Promise.all([first, second])).resolves.toEqual(["one", "two"]);
    expect(events).toContain("stream1-end");
  });

  it("does not wait on a held same-session lock for a sidecar-classified body", async () => {
    const sessionId = "session-sidecar";
    const body = sidecarBody();
    expect(classifyGatewayRequestClass(body).requestClass).toBe("client_sidecar");

    const held = await manager.acquireLock(sessionId);
    const events: string[] = [];

    const sidecar = runWithSessionAdmission({
      sessionId,
      requestClass: classifyGatewayRequestClass(body).requestClass,
      manager,
      criticalSection: async () => {
        events.push("sidecar-cs");
      },
      onAdmitted: async () => {
        events.push("sidecar-admitted");
        return "sidecar";
      },
    });

    await waitFor(() => events.includes("sidecar-admitted"));
    expect(events).toEqual(["sidecar-admitted"]);
    expect(await sidecar).toBe("sidecar");

    held.release();
  });

  it("still serializes short critical sections for the same session", async () => {
    const sessionId = "session-cs-serial";
    const events: string[] = [];

    const first = runWithSessionAdmission({
      sessionId,
      requestClass: "tool_continuation",
      manager,
      criticalSection: async () => {
        events.push("cs1-start");
        await new Promise((resolve) => setTimeout(resolve, 40));
        events.push("cs1-end");
      },
      onAdmitted: async () => "one",
    });

    const second = runWithSessionAdmission({
      sessionId,
      requestClass: "user_intent",
      manager,
      criticalSection: async () => {
        events.push("cs2-start");
        events.push("cs2-end");
      },
      onAdmitted: async () => "two",
    });

    await Promise.all([first, second]);
    expect(events).toEqual(["cs1-start", "cs1-end", "cs2-start", "cs2-end"]);
  });

  it("releases the short lock if the critical section throws so the next request is not stuck", async () => {
    const sessionId = "session-cs-error";

    await expect(
      runWithSessionAdmission({
        sessionId,
        requestClass: "user_intent",
        manager,
        criticalSection: async () => {
          throw new Error("cs-fail");
        },
        onAdmitted: async () => "should-not-run",
      }),
    ).rejects.toThrow("cs-fail");

    const recovered = await runWithSessionAdmission({
      sessionId,
      requestClass: "user_intent",
      manager,
      onAdmitted: async () => "ok",
    });
    expect(recovered).toBe("ok");
  });

  it("treats an empty session id as a no-op even for classes that would otherwise lock", async () => {
    const events: string[] = [];
    const held = await manager.acquireLock("other-session");

    const result = await runWithSessionAdmission({
      sessionId: "",
      requestClass: "user_intent",
      manager,
      onAdmitted: async () => {
        events.push("admitted");
        return "free";
      },
    });

    expect(result).toBe("free");
    expect(events).toEqual(["admitted"]);
    held.release();
  });

  it("still fail-closes with session queue timeout while waiting for a short lock", async () => {
    const sessionId = "session-timeout";
    const held = await manager.acquireLock(sessionId);

    await expect(
      runWithSessionAdmission({
        sessionId,
        requestClass: "user_intent",
        manager,
        timeoutMs: 40,
        onAdmitted: async () => "nope",
      }),
    ).rejects.toThrow(SessionQueueTimeoutError);

    held.release();
  });

  it("classifies a normal user message as user_intent so admission takes the short lock path", () => {
    expect(classifyGatewayRequestClass(userIntentBody()).requestClass).toBe("user_intent");
    expect(sessionLockModeFor(classifyGatewayRequestClass(userIntentBody()).requestClass)).toBe("short");
  });
});
