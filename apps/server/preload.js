/**
 * Polyfill: ensure worker_threads.markAsUncloneable exists.
 *
 * undici 8.x unconditionally calls require('node:worker_threads').markAsUncloneable
 * during module initialization. Some Node.js builds (e.g. certain custom-compiled
 * Node 24 distributions) may not export this function, causing a crash at startup.
 *
 * This preload script patches the worker_threads module BEFORE any application code
 * runs, so undici (and any other library) sees a valid function.
 *
 * Usage: node -r ./preload.js dist/index.js
 */
"use strict";

try {
  const wt = require("node:worker_threads");
  if (typeof wt.markAsUncloneable !== "function") {
    wt.markAsUncloneable = function markAsUncloneable() {
      /* no-op polyfill */
    };
    console.log("[preload] Patched worker_threads.markAsUncloneable (no-op polyfill)");
  }
} catch {
  // worker_threads module not available at all — nothing to patch
}
