import { describe, expect, it } from "vitest";
import path from "path";

describe("ecosystem.config.cjs static assertions", () => {
  it("contains preload.js in node_args", async () => {
    // Dynamically load the ecosystem config
    const configPath = path.resolve(__dirname, "../../../ecosystem.config.cjs");
    // Clear require cache to get fresh copy
    delete require.cache[require.resolve(configPath)];

    // The config throws if PROMPTGATE_SECRET is missing in production,
    // so set NODE_ENV to development for this test
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    try {
      const config = require(configPath);
      const serverApp = config.apps.find((a: any) => a.name === "promptgate-server");
      expect(serverApp).toBeDefined();
      expect(serverApp.node_args).toContain("preload.js");
      expect(serverApp.script).toBe("apps/server/dist/index.js");
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });
});
