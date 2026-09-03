import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { nextCopyRouteName } from "@promptgate/shared";

const webLocales = path.resolve(__dirname, "../../web/src/locales");
const zhLocales = JSON.parse(fs.readFileSync(path.join(webLocales, "zh.json"), "utf8"));
const enLocales = JSON.parse(fs.readFileSync(path.join(webLocales, "en.json"), "utf8"));
const zhCopyLabel = zhLocales.providers.copyName.label as string;
const enCopyLabel = enLocales.providers.copyName.label as string;

describe("provider nextCopyRouteName", () => {
  it("uses the zh provider copyName label and numbers suffixes until free", () => {
    expect(zhCopyLabel).toBe("副本");
    expect(nextCopyRouteName("OpenAI 官方", [], zhCopyLabel)).toBe("OpenAI 官方 副本");
    expect(nextCopyRouteName("OpenAI 官方", ["OpenAI 官方"], zhCopyLabel)).toBe("OpenAI 官方 副本");
    expect(
      nextCopyRouteName(
        "OpenAI 官方",
        ["OpenAI 官方", "OpenAI 官方 副本"],
        zhCopyLabel,
      ),
    ).toBe("OpenAI 官方 副本 2");
    expect(
      nextCopyRouteName(
        "OpenAI 官方",
        ["OpenAI 官方", "OpenAI 官方 副本", "OpenAI 官方 副本 2"],
        zhCopyLabel,
      ),
    ).toBe("OpenAI 官方 副本 3");
  });

  it("uses the en provider copyName label and numbers suffixes until free", () => {
    expect(enCopyLabel).toBe("Copy");
    expect(nextCopyRouteName("Official OpenAI", [], enCopyLabel)).toBe("Official OpenAI Copy");
    expect(
      nextCopyRouteName(
        "Official OpenAI",
        ["Official OpenAI", "Official OpenAI Copy"],
        enCopyLabel,
      ),
    ).toBe("Official OpenAI Copy 2");
  });
});

describe("admin provider copy UI wiring (static)", () => {
  const webRoot = path.resolve(__dirname, "../../web/src");

  it("renders a per-row copy control in Providers.tsx and opens ProviderEditModal in copy mode", () => {
    const providersPage = fs.readFileSync(path.join(webRoot, "pages/Providers.tsx"), "utf8");
    const editModal = fs.readFileSync(path.join(webRoot, "components/ProviderEditModal.tsx"), "utf8");
    const zh = fs.readFileSync(path.join(webRoot, "locales/zh.json"), "utf8");
    const en = fs.readFileSync(path.join(webRoot, "locales/en.json"), "utf8");

    // Providers.tsx: Copy icon button and openCopy handler
    expect(providersPage).toMatch(/openCopy/);
    expect(providersPage).toMatch(/\bCopy\b/);
    expect(providersPage).toMatch(/providers\.actions\.copy/);
    expect(providersPage).toMatch(/copying:\s*true/);
    expect(providersPage).toMatch(/existingNames/);

    // ProviderEditModal: handles copying prop + nextCopyRouteName
    expect(editModal).toMatch(/copying\??:\s*boolean/);
    expect(editModal).toMatch(/existingNames\??:\s*string\[\]/);
    expect(editModal).toMatch(/nextCopyRouteName/);
    expect(editModal).toMatch(/providers\.copyName\.label/);
    expect(editModal).toMatch(/isEditing\s*=\s*Boolean\(provider\s*&&\s*!copying\)/);
    expect(editModal).toMatch(/providerId:\s*isEditing\s*\?\s*provider\?\.id\s*:\s*undefined/);
    expect(editModal).toMatch(/copyTitle/);
    expect(editModal).toMatch(/copyDesc/);
    expect(editModal).toMatch(/\/admin\/providers\/\$\{provider\.id\}\/models/);

    // Locales
    expect(zh).toMatch(/"copyTitle":\s*"复制供应商"/);
    expect(zh).toMatch(/"copyDesc"/);
    expect(en).toMatch(/"copyTitle":\s*"Copy Provider"/);
    expect(en).toMatch(/"copyDesc"/);
    expect(zhLocales.providers.actions.copy).toBe("复制");
    expect(enLocales.providers.actions.copy).toBe("Copy");
  });
});
