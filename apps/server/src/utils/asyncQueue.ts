export class AsyncQueue {
  private _concurrency: number;
  private activeCount: number = 0;
  private queue: Array<() => void> = [];

  constructor({ concurrency }: { concurrency: number }) {
    this._concurrency = concurrency;
  }

  get concurrency(): number {
    return this._concurrency;
  }

  set concurrency(value: number) {
    this._concurrency = value;
    this.processQueue();
  }

  get pending(): number {
    return this.queue.length;
  }

  get size(): number {
    return this.queue.length;
  }

  get active(): number {
    return this.activeCount;
  }

  add<T>(task: (hold: () => () => void) => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = async () => {
        this.activeCount++;

        let manualRelease: (() => void) | null = null;

        /**
         * Calling hold() prevents the slot from being automatically released when the current task promise resolves.
         * This is critical for streaming requests: because the fetch promise resolves when the header is received (TTFB),
         * if we don't hold(), the slot would be released immediately, causing the streaming concurrency limit to fail.
         * After calling hold(), the returned manual release function must be executed to free the slot.
         */
        const hold = () => {
          let released = false;
          manualRelease = () => {
            if (!released) {
              released = true;
              this.activeCount--;
              this.processQueue();
            }
          };
          return manualRelease;
        };

        try {
          const result = await task(hold);
          resolve(result);
        } catch (error) {
          reject(error);
        } finally {
          if (!manualRelease) {
            this.activeCount--;
            this.processQueue();
          }
        }
      };

      if (this.activeCount < this._concurrency) {
        run();
      } else {
        this.queue.push(run);
      }
    });
  }

  private processQueue() {
    while (this.activeCount < this._concurrency && this.queue.length > 0) {
      const task = this.queue.shift();
      if (task) {
        task();
      }
    }
  }
}
