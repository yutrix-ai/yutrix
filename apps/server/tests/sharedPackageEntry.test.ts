import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";

const serverPkgDir = path.resolve(__dirname, "..");
const sharedPkgPath = path.resolve(serverPkgDir, "../../packages/shared/package.json");
const requireFromServer = createRequire(path.join(serverPkgDir, "package.json"));

describe("@promptgate/shared production entry", () => {
  it("points Node require at compiled dist, not TypeScript source", () => {
    const pkg = JSON.parse(readFileSync(sharedPkgPath, "utf8"));
    expect(pkg.main).toBe("dist/index.js");
    expect(pkg.exports["."].require).toBe("./dist/index.js");
    expect(pkg.exports["."].default).toBe("./dist/index.js");
    expect(pkg.main).not.toMatch(/src\/index\.ts$/);
  });

  it("CJS require from the server package loads usage-stat helpers", () => {
    const resolved = requireFromServer.resolve("@promptgate/shared");
    expect(resolved.replaceAll("\\", "/")).toMatch(/packages\/shared\/dist\/index\.js$/);

    const shared = requireFromServer("@promptgate/shared") as {
      LOCAL_RESPONSE_CACHE_HIT_STATUS: string;
      isUsageStatEligible: (status: string) => boolean;
    };
    expect(shared.LOCAL_RESPONSE_CACHE_HIT_STATUS).toBe("cached");
    expect(shared.isUsageStatEligible("cached")).toBe(false);
    expect(shared.isUsageStatEligible("success")).toBe(true);
  });
});
