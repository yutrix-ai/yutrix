/**
 * Polyfills for undici 8.x on older/custom Node environments.
 */

if (typeof (Promise as any).withResolvers !== "function") {
  (Promise as any).withResolvers = function <T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: any) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
  console.log("[polyfill] Polyfilled Promise.withResolvers");
}

/**
 * Polyfill: ensure worker_threads.markAsUncloneable exists.
 *
 * undici 8.x unconditionally calls require('node:worker_threads').markAsUncloneable
 * during module initialization. Some Node.js builds (e.g. certain custom-compiled
 * distributions) may not export this function, causing a crash at startup.
 */
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const wt1 = require("node:worker_threads");
  if (typeof wt1.markAsUncloneable !== "function") {
    wt1.markAsUncloneable = function markAsUncloneable() { /* no-op polyfill */ };
  }
} catch { /* ignore */ }

try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const wt2 = require("worker_threads");
  if (typeof wt2.markAsUncloneable !== "function") {
    wt2.markAsUncloneable = function markAsUncloneable() { /* no-op polyfill */ };
  }
} catch { /* ignore */ }
