import { describe, it, expect } from "vitest";
import {
  parseRouteHosts,
  formatRouteHosts,
  parseRouteDomainBindings,
  validateRouteDomainBindings,
  collectRouteIdentityIssues,
  findMatchingKeyCollision,
  ROUTE_IDENTITY_ERROR,
} from "../src";

describe("Multi-Domain Route Bindings & Identity Spec (SDD Unit Tests)", () => {
  it("parseRouteHosts parses JSON array strings, comma strings, and arrays", () => {
    expect(parseRouteHosts('["code.brtel.link", "code.yutrix.ai"]')).toEqual([
      "code.brtel.link",
      "code.yutrix.ai",
    ]);
    expect(parseRouteHosts("code.brtel.link, dev.yutrix.ai")).toEqual([
      "code.brtel.link",
      "dev.yutrix.ai",
    ]);
    expect(parseRouteHosts(["api.brtel.link", "api.yutrix.ai"])).toEqual([
      "api.brtel.link",
      "api.yutrix.ai",
    ]);
    expect(parseRouteHosts(null, "legacy.brtel.link")).toEqual([
      "legacy.brtel.link",
    ]);
    expect(parseRouteHosts("*")).toEqual(["*"]);
    expect(parseRouteHosts("")).toEqual(["*"]);
  });

  it("parseRouteDomainBindings breaks hosts into mainDomain and subdomain", () => {
    const mainDomains = ["brtel.link", "yutrix.ai"];
    const bindings = parseRouteDomainBindings(
      ["code.brtel.link", "chat.yutrix.ai", "custom.api.org"],
      mainDomains,
    );

    expect(bindings).toHaveLength(3);
    expect(bindings[0]).toMatchObject({
      mainDomain: "brtel.link",
      subdomain: "code",
      fullHost: "code.brtel.link",
      isCustom: false,
    });
    expect(bindings[1]).toMatchObject({
      mainDomain: "yutrix.ai",
      subdomain: "chat",
      fullHost: "chat.yutrix.ai",
      isCustom: false,
    });
    expect(bindings[2]).toMatchObject({
      mainDomain: "__custom__",
      subdomain: "custom.api.org",
      fullHost: "custom.api.org",
      isCustom: true,
    });
  });

  it("validateRouteDomainBindings enforces: 同一个路由中只允许一个一级域名出现一次", () => {
    const mainDomains = ["brtel.link", "yutrix.ai"];

    // 1. Valid: two distinct main domains
    const validBindings = [
      {
        id: "1",
        mainDomain: "brtel.link",
        subdomain: "code",
        fullHost: "code.brtel.link",
      },
      {
        id: "2",
        mainDomain: "yutrix.ai",
        subdomain: "code",
        fullHost: "code.yutrix.ai",
      },
    ];
    expect(validateRouteDomainBindings(validBindings).ok).toBe(true);

    // 2. Invalid: same main domain appears twice in the same route rule
    const duplicateMainDomain = [
      {
        id: "1",
        mainDomain: "brtel.link",
        subdomain: "code",
        fullHost: "code.brtel.link",
      },
      {
        id: "2",
        mainDomain: "brtel.link",
        subdomain: "api",
        fullHost: "api.brtel.link",
      },
    ];
    const res = validateRouteDomainBindings(duplicateMainDomain);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("同一个路由中只允许一个一级域名出现一次");

    // 3. Invalid: missing subdomain prefix
    const missingSub = [
      {
        id: "1",
        mainDomain: "brtel.link",
        subdomain: "",
        fullHost: "brtel.link",
      },
    ];
    expect(validateRouteDomainBindings(missingSub).ok).toBe(false);
  });

  it("findMatchingKeyCollision detects overlapping hosts between multi-host routes on same path and protocol", () => {
    const existingRecords = [
      {
        id: "route-1",
        name: "Route 1",
        host: "code.brtel.link, code.yutrix.ai",
        hosts: ["code.brtel.link", "code.yutrix.ai"],
        path: "/v1/chat/completions",
        incomingProtocol: "openai",
      },
      {
        id: "route-2",
        name: "Route 2",
        host: "chat.brtel.link",
        hosts: ["chat.brtel.link"],
        path: "/v1/chat/completions",
        incomingProtocol: "openai",
      },
    ];

    // Conflict: trying to create Route 3 that also includes code.brtel.link on /v1/chat/completions
    const conflict = findMatchingKeyCollision(
      {
        host: "code.brtel.link",
        hosts: ["code.brtel.link", "new.yutrix.ai"],
        path: "/v1/chat/completions",
        protocol: "openai",
      },
      existingRecords,
      { mainDomain: ["brtel.link", "yutrix.ai"] },
    );
    expect(conflict).not.toBeNull();
    expect(conflict?.id).toBe("route-1");

    // No conflict: dev.brtel.link does not overlap with code or chat
    const noConflict = findMatchingKeyCollision(
      {
        host: "dev.brtel.link",
        hosts: ["dev.brtel.link", "dev.yutrix.ai"],
        path: "/v1/chat/completions",
        protocol: "openai",
      },
      existingRecords,
      { mainDomain: ["brtel.link", "yutrix.ai"] },
    );
    expect(noConflict).toBeNull();
  });
});
