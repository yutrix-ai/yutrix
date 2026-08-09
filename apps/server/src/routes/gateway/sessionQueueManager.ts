import { AsyncQueue } from "../../utils/asyncQueue";

export class SessionQueueTimeoutError extends Error {
  constructor(message = "Session concurrency queue timeout") {
    super(message);
    this.name = "SessionQueueTimeoutError";
  }
}

export interface SessionLock {
  release: () => void;
}

export interface SessionQueueManagerOptions {
  defaultTimeoutMs?: number;
  maxQueueCapacity?: number;
  ttlMs?: number;
}

interface SessionEntry {
  queue: AsyncQueue;
  lastActive: number;
}

export class SessionQueueManager {
  private sessionQueues = new Map<string, SessionEntry>();
  private defaultTimeoutMs: number;
  private maxQueueCapacity: number;
  private ttlMs: number;

  constructor(options: SessionQueueManagerOptions = {}) {
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 60000;
    this.maxQueueCapacity = options.maxQueueCapacity ?? 20;
    this.ttlMs = options.ttlMs ?? 10 * 60 * 1000;
  }

  public hasSessionQueue(sessionId: string): boolean {
    return this.sessionQueues.has(sessionId);
  }

  public getSessionQueueCount(): number {
    return this.sessionQueues.size;
  }

  public async acquireLock(
    sessionId: string,
    options: { timeoutMs?: number } = {}
  ): Promise<SessionLock> {
    if (!sessionId) {
      return { release: () => {} };
    }

    let entry = this.sessionQueues.get(sessionId);
    if (!entry) {
      entry = {
        queue: new AsyncQueue({ concurrency: 1 }),
        lastActive: Date.now(),
      };
      this.sessionQueues.set(sessionId, entry);
    }

    entry.lastActive = Date.now();
    const queue = entry.queue;

    if (queue.pending >= this.maxQueueCapacity) {
      throw new Error("Session queue capacity exceeded");
    }

    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;

    return new Promise<SessionLock>((resolve, reject) => {
      let timedOut = false;
      const timer = timeoutMs > 0 ? setTimeout(() => {
        timedOut = true;
        reject(new SessionQueueTimeoutError(`Session queue timeout after ${timeoutMs}ms`));
      }, timeoutMs) : null;

      queue.add(async (hold) => {
        if (timer) clearTimeout(timer);
        if (timedOut) return;

        let released = false;
        const manualRelease = hold();

        const sessionLock: SessionLock = {
          release: () => {
            if (!released) {
              released = true;
              if (entry) {
                entry.lastActive = Date.now();
              }
              manualRelease();
            }
          }
        };

        resolve(sessionLock);
      }).catch(err => {
        if (!timedOut) {
          if (timer) clearTimeout(timer);
          reject(err);
        }
      });
    });
  }

  public async runInSession<T>(
    sessionId: string,
    task: () => Promise<T>,
    options: { timeoutMs?: number } = {}
  ): Promise<T> {
    const lock = await this.acquireLock(sessionId, options);
    try {
      return await task();
    } finally {
      lock.release();
    }
  }

  public cleanupIdleQueues(): void {
    const now = Date.now();
    for (const [sessionId, entry] of this.sessionQueues.entries()) {
      if (entry.queue.active === 0 && entry.queue.pending === 0) {
        if (now - entry.lastActive >= this.ttlMs) {
          this.sessionQueues.delete(sessionId);
        }
      }
    }
  }

  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Start a periodic cleanup timer that prunes idle session queues.
   * Called automatically for the global singleton instance.
   */
  public startPeriodicCleanup(intervalMs = 5 * 60 * 1000): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => this.cleanupIdleQueues(), intervalMs);
    // Allow the Node.js process to exit even if this timer is active
    if (this.cleanupTimer && typeof this.cleanupTimer === "object" && "unref" in this.cleanupTimer) {
      this.cleanupTimer.unref();
    }
  }

  public stopPeriodicCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}

export const globalSessionQueueManager = new SessionQueueManager();
globalSessionQueueManager.startPeriodicCleanup();
