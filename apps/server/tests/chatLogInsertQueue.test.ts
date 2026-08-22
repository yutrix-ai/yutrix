import { describe, it, expect } from "vitest";
import {
  enqueueAuditInsert,
  resolveAuditInsertQueueKey,
} from "../src/services/chatLogInsertQueue";

describe("resolveAuditInsertQueueKey", () => {
  it("keys same-user inserts with the same clientSessionId onto one queue", () => {
    const a = resolveAuditInsertQueueKey({
      userId: "user-1",
      clientSessionId: "conv-a",
      requestId: "r1",
    });
    const b = resolveAuditInsertQueueKey({
      userId: "user-1",
      clientSessionId: "conv-a",
      requestId: "r2",
    });
    expect(a).toBe(b);
  });

  it("does not share a queue across different client sessions of the same user", () => {
    const a = resolveAuditInsertQueueKey({
      userId: "user-1",
      clientSessionId: "conv-a",
      requestId: "r1",
    });
    const b = resolveAuditInsertQueueKey({
      userId: "user-1",
      clientSessionId: "conv-b",
      requestId: "r2",
    });
    expect(a).not.toBe(b);
  });
});

describe("enqueueAuditInsert", () => {
  it("serializes tasks that share a clientSessionId", async () => {
    const events: string[] = [];
    const payloadA = { userId: "user-q", clientSessionId: "same", requestId: "a" };
    const payloadB = { userId: "user-q", clientSessionId: "same", requestId: "b" };

    const first = enqueueAuditInsert(payloadA, async () => {
      events.push("a-start");
      await new Promise((resolve) => setTimeout(resolve, 40));
      events.push("a-end");
    });
    const second = enqueueAuditInsert(payloadB, async () => {
      events.push("b-start");
      events.push("b-end");
    });

    await Promise.all([first, second]);
    expect(events).toEqual(["a-start", "a-end", "b-start", "b-end"]);
  });

  it("does not force different sessions of the same user to complete one-after-the-other", async () => {
    const events: string[] = [];
    const payloadA = { userId: "user-parallel", clientSessionId: "sess-a", requestId: "a" };
    const payloadB = { userId: "user-parallel", clientSessionId: "sess-b", requestId: "b" };

    const first = enqueueAuditInsert(payloadA, async () => {
      events.push("a-start");
      await new Promise((resolve) => setTimeout(resolve, 50));
      events.push("a-end");
    });
    const second = enqueueAuditInsert(payloadB, async () => {
      events.push("b-start");
      await new Promise((resolve) => setTimeout(resolve, 10));
      events.push("b-end");
    });

    await Promise.all([first, second]);
    expect(events.indexOf("b-start")).toBeLessThan(events.indexOf("a-end"));
    expect(events.indexOf("b-end")).toBeLessThan(events.indexOf("a-end"));
  });

  it("keeps the queue alive after a failed task so later inserts for that session still run", async () => {
    const payload = { userId: "user-err", clientSessionId: "sess-err", requestId: "x" };
    await expect(
      enqueueAuditInsert(payload, async () => {
        throw new Error("insert-fail");
      }),
    ).rejects.toThrow("insert-fail");

    const recovered = await enqueueAuditInsert(
      { ...payload, requestId: "y" },
      async () => "ok",
    );
    expect(recovered).toBe("ok");
  });
});
