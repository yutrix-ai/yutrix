#!/usr/bin/env node
/**
 * Classic routing E2E smoke — validates mode helpers and target normalization contract.
 * Run: node docs/classic-routing-e2e.js
 */
const { execSync } = require("child_process");
const path = require("path");

const serverRoot = path.join(__dirname, "../apps/server");

function run(cmd) {
  return execSync(cmd, { cwd: serverRoot, encoding: "utf8" });
}

console.log("=== Classic Routing E2E ===\n");

const testOut = run(
  "pnpm exec vitest run tests/classicRouting.test.ts 2>&1",
);

const passed = /Tests\s+\d+\s+passed/.test(testOut) && !/Tests\s+0\s+passed/.test(testOut);
console.log(testOut);

if (!passed) {
  console.error("\nE2E FAILED: vitest did not pass");
  process.exit(1);
}

console.log("\n✅ Classic routing E2E smoke passed");
