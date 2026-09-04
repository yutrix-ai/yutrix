import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const webRoot = path.resolve(__dirname, "../../web/src");

function readWeb(rel: string): string {
  return fs.readFileSync(path.join(webRoot, rel), "utf8");
}

describe("useOpencodeProxy UI persist wiring (static)", () => {
  it("PATCH save payload includes useOpencodeProxy next to enabled/alias", () => {
    const modal = readWeb("components/ProviderModelsModal.tsx");
    const saveStart = modal.indexOf("handleSaveAllModels");
    expect(saveStart).toBeGreaterThan(-1);
    const saveFn = modal.slice(saveStart, modal.indexOf("return (", saveStart));

    expect(saveFn).toMatch(/method:\s*"PATCH"/);
    expect(saveFn).toMatch(/\/admin\/providers\/\$\{provider\.id\}\/models/);
    expect(saveFn).toMatch(/JSON\.stringify\(/);
    expect(saveFn).toMatch(/useOpencodeProxy:\s*Boolean\(m\.useOpencodeProxy\)/);
    expect(saveFn).toMatch(/enabled:\s*m\.enabled/);
    expect(saveFn).toMatch(/alias:\s*m\.alias/);
  });

  it("no other web save path PATCHes provider models without useOpencodeProxy", () => {
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return walk(full);
        return entry.name.endsWith(".tsx") || entry.name.endsWith(".ts") ? [full] : [];
      });

    const modelPatch = /method:\s*"PATCH"[\s\S]{0,500}\/admin\/providers\/\$\{[^}]+\}\/models|\/admin\/providers\/\$\{[^}]+\}\/models[\s\S]{0,500}method:\s*"PATCH"/;
    const hits = walk(webRoot).filter((file) => modelPatch.test(fs.readFileSync(file, "utf8")));
    expect(hits.map((file) => path.relative(webRoot, file))).toEqual(["components/ProviderModelsModal.tsx"]);
    expect(fs.readFileSync(hits[0], "utf8")).toMatch(/useOpencodeProxy:\s*Boolean\(m\.useOpencodeProxy\)/);
  });
});
