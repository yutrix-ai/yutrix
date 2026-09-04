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

describe("useOpencodeProxy enable warning (static)", () => {
  it("ProviderModelsModal has dismiss key + warning dialog wiring for enable path", () => {
    const modal = readWeb("components/ProviderModelsModal.tsx");
    const zh = JSON.parse(readWeb("locales/zh.json"));
    const en = JSON.parse(readWeb("locales/en.json"));

    expect(modal).toMatch(/yutrix\.opencodeCompat\.warnDismissed/);
    expect(modal).toMatch(/localStorage\.getItem\(OPENCODE_COMPAT_WARN_DISMISSED_KEY\) === "1"/);
    expect(modal).toMatch(/localStorage\.setItem\(OPENCODE_COMPAT_WARN_DISMISSED_KEY, "1"\)/);

    expect(modal).not.toMatch(/onChange\("useOpencodeProxy"/);
    expect(modal).toMatch(/onOpencodeProxyChange/);
    expect(modal).toMatch(/handleOpencodeProxyChange/);
    expect(modal).toMatch(/handleCompatWarnConfirm/);
    expect(modal).toMatch(/providers\.modelList\.opencodeCompatWarn/);

    const enableStart = modal.indexOf("const handleOpencodeProxyChange");
    expect(enableStart).toBeGreaterThan(-1);
    const enableFn = modal.slice(enableStart, modal.indexOf("const closeCompatWarn", enableStart));
    expect(enableFn).toMatch(/if\s*\(\s*!checked\s*\)/);
    expect(enableFn).toMatch(/handleModelFieldChange\(modelKey,\s*"useOpencodeProxy",\s*false\)/);
    expect(enableFn).toMatch(/isOpencodeCompatWarnDismissed\(\)/);
    expect(enableFn).toMatch(/setCompatWarn\(\{\s*open:\s*true/);
    expect(enableFn).not.toMatch(/persistOpencodeCompatWarnDismissed/);

    const closeStart = modal.indexOf("const closeCompatWarn");
    const closeFn = modal.slice(closeStart, modal.indexOf("const handleCompatWarnConfirm", closeStart));
    expect(closeFn).not.toMatch(/persistOpencodeCompatWarnDismissed/);
    expect(closeFn).not.toMatch(/localStorage\.setItem/);

    const confirmStart = modal.indexOf("const handleCompatWarnConfirm");
    const confirmFn = modal.slice(confirmStart, modal.indexOf("const handleToggleAllModels", confirmStart));
    expect(confirmFn).toMatch(/dontShowCompatWarnAgain/);
    expect(confirmFn).toMatch(/persistOpencodeCompatWarnDismissed\(\)/);
    expect(confirmFn).toMatch(/"useOpencodeProxy",\s*true/);

    const warn = zh.providers.modelList.opencodeCompatWarn;
    const warnEn = en.providers.modelList.opencodeCompatWarn;
    expect(warn.dontShowAgain).toBe("不再显示此警告");
    expect(warnEn.dontShowAgain).toBe("Don't show this warning again");
    expect(warn.execPath).toMatch(/sidecar/);
    expect(warnEn.execPath).toMatch(/sidecar/);
    expect(warn.sandbox).toMatch(/隔离沙箱/);
    expect(warnEn.sandbox).toMatch(/tools denied/);
  });
});
