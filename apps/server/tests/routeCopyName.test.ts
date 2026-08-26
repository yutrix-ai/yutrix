import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  buildCopiedRouteDraft,
  collectRouteIdentityIssues,
  matchingKeySubmitBlocked,
  nextCopyRouteName,
  ROUTE_IDENTITY_ERROR,
} from "@promptgate/shared";

const webLocales = path.resolve(__dirname, "../../web/src/locales");
const zhLocales = JSON.parse(fs.readFileSync(path.join(webLocales, "zh.json"), "utf8"));
const enLocales = JSON.parse(fs.readFileSync(path.join(webLocales, "en.json"), "utf8"));
const zhCopyLabel = zhLocales.routes.copyName.label as string;
const enCopyLabel = enLocales.routes.copyName.label as string;

describe("nextCopyRouteName (shipped helper)", () => {
  it("uses the zh locale label then numbered suffixes until a name is free", () => {
    expect(zhCopyLabel).toBe("副本");
    expect(nextCopyRouteName("foo", [], zhCopyLabel)).toBe("foo 副本");
    expect(nextCopyRouteName("foo", ["foo"], zhCopyLabel)).toBe("foo 副本");
    expect(nextCopyRouteName("foo", ["foo", "foo 副本"], zhCopyLabel)).toBe("foo 副本 2");
    expect(nextCopyRouteName("foo", ["foo", "foo 副本", "foo 副本 2"], zhCopyLabel)).toBe("foo 副本 3");
  });

  it("uses the en locale label then numbered suffixes until a name is free", () => {
    expect(enCopyLabel).toBe("Copy");
    expect(nextCopyRouteName("foo", [], enCopyLabel)).toBe("foo Copy");
    expect(nextCopyRouteName("foo", ["foo", "foo Copy"], enCopyLabel)).toBe("foo Copy 2");
    expect(nextCopyRouteName("foo", ["foo", "foo Copy", "foo Copy 2"], enCopyLabel)).toBe("foo Copy 3");
  });

  it("treats an empty source as the locale label / label 2", () => {
    expect(nextCopyRouteName("", [], zhCopyLabel)).toBe("副本");
    expect(nextCopyRouteName("   ", ["副本"], zhCopyLabel)).toBe("副本 2");
    expect(nextCopyRouteName("", [], enCopyLabel)).toBe("Copy");
    expect(nextCopyRouteName("", ["Copy"], enCopyLabel)).toBe("Copy 2");
  });
});

describe("buildCopiedRouteDraft (shipped copy prefill)", () => {
  const source = {
    name: "foo",
    host: "api.example.com",
    path: "/v1/chat/completions",
    incomingProtocol: "openai",
    targets: [{ providerId: "p1", modelId: "m1", bestEffort: false }],
    timeoutMs: 9000,
    retryCount: 4,
    queueTimeoutMs: 1000,
    maxBodyMb: 8,
    enabled: true,
    allowClientModel: true,
    ipWhitelist: "10.0.0.0/8",
    authorizedUserIds: ["u1"],
    authorizedGroupIds: ["g1"],
    fallbackMatchTarget: true,
    schedules: [{ id: "s1" }],
  };

  it("prefills a free 副本 name and copies savable config without mutating identity uniqueness", () => {
    const draft = buildCopiedRouteDraft(source, ["foo"], zhCopyLabel);
    expect(draft.name).toBe("foo 副本");
    expect(draft.hostInput).toBe("api.example.com");
    expect(draft.path).toBe("/v1/chat/completions");
    expect(draft.incomingProtocol).toBe("openai");
    expect(draft.targets).toEqual(source.targets);
    expect(draft.timeoutMs).toBe(9000);
    expect(draft.retryCount).toBe(4);
    expect(draft.queueTimeoutMs).toBe(1000);
    expect(draft.maxBodyMb).toBe(8);
    expect(draft.enabled).toBe(true);
    expect(draft.allowClientModel).toBe(true);
    expect(draft.ipWhitelist).toBe("10.0.0.0/8");
    expect(draft.authorizedUserIds).toEqual(["u1"]);
    expect(draft.authorizedGroupIds).toEqual(["g1"]);
    expect(draft.fallbackMatchTarget).toBe(true);
    expect(draft.schedules).toEqual([{ id: "s1" }]);
    expect(draft.authorizedUserIds).not.toBe(source.authorizedUserIds);
  });

  it("blocks copy submit while the matching triple still collides", () => {
    const draft = buildCopiedRouteDraft(source, ["foo"], zhCopyLabel);
    const issues = collectRouteIdentityIssues({
      name: draft.name,
      hostInput: draft.hostInput,
      path: draft.path,
      protocol: draft.incomingProtocol,
      records: [
        {
          id: "src",
          name: "foo",
          host: "api.example.com",
          path: "/v1/chat/completions",
          incomingProtocol: "openai",
        },
      ],
      mainDomain: "example.com",
      excludeRouteId: null,
    });
    expect(matchingKeySubmitBlocked(issues)).toBe(true);
    expect(issues.some((issue) => issue.code === ROUTE_IDENTITY_ERROR.MATCHING_KEY_CONFLICT)).toBe(
      true,
    );

    const free = collectRouteIdentityIssues({
      name: draft.name,
      hostInput: "other.example.com",
      path: draft.path,
      protocol: draft.incomingProtocol,
      records: [
        {
          id: "src",
          name: "foo",
          host: "api.example.com",
          path: "/v1/chat/completions",
          incomingProtocol: "openai",
        },
      ],
      mainDomain: "example.com",
      excludeRouteId: null,
    });
    expect(matchingKeySubmitBlocked(free)).toBe(false);
  });
});

describe("admin route copy UI wiring (static)", () => {
  const webRoot = path.resolve(__dirname, "../../web/src");

  it("renders a per-row copy control and opens create-mode with the copy title", () => {
    const list = fs.readFileSync(path.join(webRoot, "components/Routes/RouteList.tsx"), "utf8");
    const dialog = fs.readFileSync(path.join(webRoot, "components/Routes/RouteDialog.tsx"), "utf8");
    const state = fs.readFileSync(path.join(webRoot, "components/Routes/useRoutesState.ts"), "utf8");
    const zh = fs.readFileSync(path.join(webRoot, "locales/zh.json"), "utf8");
    const en = fs.readFileSync(path.join(webRoot, "locales/en.json"), "utf8");

    expect(list).toMatch(/openCopy/);
    expect(list).toMatch(/Copy/);
    expect(state).toMatch(/openCopy/);
    expect(state).toMatch(/buildCopiedRouteDraft/);
    expect(state).toMatch(/setEditingId\(null\)/);
    expect(dialog).toMatch(/copyTitle/);
    expect(dialog).toMatch(/matchingKeySubmitBlocked/);
    expect(zh).toMatch(/"copy"/);
    expect(zh).toMatch(/"copyTitle"/);
    expect(zh).toMatch(/"copyName"/);
    expect(en).toMatch(/"copy"/);
    expect(en).toMatch(/"copyTitle"/);
    expect(en).toMatch(/"copyName"/);
    expect(state).toMatch(/routes\.copyName\.label/);
    expect(zh).toMatch(/matchingKeyConflict/);
    expect(en).toMatch(/matchingKeyConflict/);
    expect(zh).toMatch(/nameConflict/);
    expect(en).toMatch(/nameConflict/);
  });
});
