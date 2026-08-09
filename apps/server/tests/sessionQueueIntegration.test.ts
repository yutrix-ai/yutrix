import { describe, it, expect, beforeEach, vi } from "vitest";
import { SessionQueueManager, SessionQueueTimeoutError } from "../src/routes/gateway/sessionQueueManager";

describe("SessionQueueManager (TDD Unit & Integration Tests)", () => {
  let manager: SessionQueueManager;

  beforeEach(() => {
    manager = new SessionQueueManager({
      defaultTimeoutMs: 1000,
      maxQueueCapacity: 5,
      ttlMs: 500,
    });
  });

  it("should process requests sequentially for the same clientSessionId", async () => {
    const executionOrder: string[] = [];
    const sessionId = "session-123";

    const task1 = manager.runInSession(sessionId, async () => {
      executionOrder.push("task1-start");
      await new Promise((resolve) => setTimeout(resolve, 50));
      executionOrder.push("task1-end");
      return "res1";
    });

    const task2 = manager.runInSession(sessionId, async () => {
      executionOrder.push("task2-start");
      await new Promise((resolve) => setTimeout(resolve, 10));
      executionOrder.push("task2-end");
      return "res2";
    });

    const [res1, res2] = await Promise.all([task1, task2]);

    expect(res1).toBe("res1");
    expect(res2).toBe("res2");
    expect(executionOrder).toEqual([
      "task1-start",
      "task1-end",
      "task2-start",
      "task2-end",
    ]);
  });

  it("should process requests in parallel for different clientSessionIds", async () => {
    const executionOrder: string[] = [];

    const task1 = manager.runInSession("session-A", async () => {
      executionOrder.push("sessionA-start");
      await new Promise((resolve) => setTimeout(resolve, 50));
      executionOrder.push("sessionA-end");
    });

    const task2 = manager.runInSession("session-B", async () => {
      executionOrder.push("sessionB-start");
      await new Promise((resolve) => setTimeout(resolve, 10));
      executionOrder.push("sessionB-end");
    });

    await Promise.all([task1, task2]);

    // sessionB should start and finish while sessionA is still sleeping
    expect(executionOrder.indexOf("sessionB-start")).toBeLessThan(
      executionOrder.indexOf("sessionA-end")
    );
    expect(executionOrder.indexOf("sessionB-end")).toBeLessThan(
      executionOrder.indexOf("sessionA-end")
    );
  });

  it("should support manual lock acquire and release for streaming response lifecycles", async () => {
    const sessionId = "session-stream";
    const events: string[] = [];

    const lock1 = await manager.acquireLock(sessionId);
    events.push("lock1-acquired");

    const task2Promise = manager.runInSession(sessionId, async () => {
      events.push("task2-executed");
    });

    // Verify task2 is waiting because lock1 is held
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(events).toEqual(["lock1-acquired"]);

    // Release lock1
    lock1.release();

    await task2Promise;
    expect(events).toEqual(["lock1-acquired", "task2-executed"]);
  });

  it("should throw SessionQueueTimeoutError if queued for longer than timeoutMs", async () => {
    const sessionId = "session-timeout";

    // Hold lock for 300ms
    const lock1 = await manager.acquireLock(sessionId);

    // Request with 100ms timeout
    const timeoutPromise = manager.acquireLock(sessionId, { timeoutMs: 100 });

    await expect(timeoutPromise).rejects.toThrow(SessionQueueTimeoutError);

    lock1.release();
  });

  it("should enforce max queue capacity limit", async () => {
    const sessionId = "session-capacity";
    const smallManager = new SessionQueueManager({
      defaultTimeoutMs: 5000,
      maxQueueCapacity: 2,
    });

    const lock1 = await smallManager.acquireLock(sessionId);

    // Queue 2 requests (capacity limit = 2)
    const p1 = smallManager.acquireLock(sessionId);
    const p2 = smallManager.acquireLock(sessionId);

    // 3rd queued request should be rejected immediately due to capacity limit
    await expect(smallManager.acquireLock(sessionId)).rejects.toThrow(
      "Session queue capacity exceeded"
    );

    lock1.release();
    const l1 = await p1;
    l1.release();
    const l2 = await p2;
    l2.release();
  });

  it("should prune idle session queues after TTL to prevent memory leaks", async () => {
    const sessionId = "session-ttl";
    await manager.runInSession(sessionId, async () => "ok");

    expect(manager.hasSessionQueue(sessionId)).toBe(true);

    // Fast forward TTL
    await new Promise((resolve) => setTimeout(resolve, 600));
    manager.cleanupIdleQueues();

    expect(manager.hasSessionQueue(sessionId)).toBe(false);
  });
});
