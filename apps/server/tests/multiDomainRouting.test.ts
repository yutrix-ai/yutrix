import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify from "fastify";
import crypto from "crypto";
import { eq } from "drizzle-orm";
import { initTestDatabase, closeAndCleanup } from "./helpers/testDatabase";
import {
  parseMainDomains,
  getMainDomain,
  formatMainDomains,
  isValidDomain,
  matchHostToDomain,
  normalizeDomain,
  parseDomainBranding,
  resolveEffectiveBranding,
} from "@promptgate/shared";

const dbFile = "data/promptgate_test_multi_domain_routing.sqlite";

describe("Multi-Domain Spec & Utilities (SDD Unit Tests)", () => {
  it("isValidDomain validates domains and localhost properly", () => {
    expect(isValidDomain("brtel.link")).toBe(true);
    expect(isValidDomain("yutrix.ai")).toBe(true);
    expect(isValidDomain("sub.deep.example.com")).toBe(true);
    expect(isValidDomain("localhost")).toBe(true);
    expect(isValidDomain("invalid domain")).toBe(false);
    expect(isValidDomain("")).toBe(false);
    expect(isValidDomain("-bad.com")).toBe(false);
  });

  it("normalizeDomain strips protocols, ports, slashes, and paths", () => {
    expect(normalizeDomain("https://brtel.link/")).toBe("brtel.link");
    expect(normalizeDomain("http://yutrix.ai:3000/api")).toBe("yutrix.ai");
    expect(normalizeDomain("  api.test.com:8080 ")).toBe("api.test.com");
  });

  it("parseMainDomains handles single string, comma-separated, newlines, JSON arrays, and duplicates", () => {
    // Single string
    expect(parseMainDomains("brtel.link")).toEqual(["brtel.link"]);

    // Comma-separated with spaces
    expect(parseMainDomains("brtel.link, yutrix.ai, myapi.org")).toEqual([
      "brtel.link",
      "yutrix.ai",
      "myapi.org",
    ]);

    // Newlines and semicolons
    expect(parseMainDomains("brtel.link\nyutrix.ai; other.net")).toEqual([
      "brtel.link",
      "yutrix.ai",
      "other.net",
    ]);

    // JSON array
    expect(parseMainDomains('["brtel.link", "yutrix.ai"]')).toEqual([
      "brtel.link",
      "yutrix.ai",
    ]);

    // Array input
    expect(parseMainDomains(["brtel.link", "https://yutrix.ai/"])).toEqual([
      "brtel.link",
      "yutrix.ai",
    ]);

    // Deduplication and normalization
    expect(parseMainDomains("brtel.link, BRTEL.LINK, https://brtel.link")).toEqual([
      "brtel.link",
    ]);

    // Empty / null
    expect(parseMainDomains("")).toEqual([]);
    expect(parseMainDomains(null)).toEqual([]);
    expect(parseMainDomains(undefined)).toEqual([]);
  });

  it("getMainDomain returns the primary domain", () => {
    expect(getMainDomain("brtel.link, yutrix.ai")).toBe("brtel.link");
    expect(getMainDomain(["yutrix.ai", "brtel.link"])).toBe("yutrix.ai");
    expect(getMainDomain("")).toBe("");
  });

  it("formatMainDomains serializes domain list into standard comma string", () => {
    expect(formatMainDomains(["brtel.link", "yutrix.ai"])).toBe("brtel.link, yutrix.ai");
  });

  it("matchHostToDomain accurately classifies root vs prefix vs external hosts", () => {
    const mainDomains = ["brtel.link", "yutrix.ai"];

    // Root matches
    expect(matchHostToDomain("brtel.link", mainDomains)).toEqual({
      isRoot: true,
      prefix: null,
      matchedDomain: "brtel.link",
    });
    expect(matchHostToDomain("yutrix.ai", mainDomains)).toEqual({
      isRoot: true,
      prefix: null,
      matchedDomain: "yutrix.ai",
    });

    // Subdomain prefix matches
    expect(matchHostToDomain("api.brtel.link", mainDomains)).toEqual({
      isRoot: false,
      prefix: "api",
      matchedDomain: "brtel.link",
    });
    expect(matchHostToDomain("api.yutrix.ai", mainDomains)).toEqual({
      isRoot: false,
      prefix: "api",
      matchedDomain: "yutrix.ai",
    });
    expect(matchHostToDomain("v2.api.yutrix.ai", mainDomains)).toEqual({
      isRoot: false,
      prefix: "v2.api",
      matchedDomain: "yutrix.ai",
    });

    // Unrelated external hosts
    expect(matchHostToDomain("evil.com", mainDomains)).toEqual({
      isRoot: false,
      prefix: null,
      matchedDomain: null,
    });
    expect(matchHostToDomain("notbrtel.link.attacker.com", mainDomains)).toEqual({
      isRoot: false,
      prefix: null,
      matchedDomain: null,
    });
  });

  it("parseDomainBranding parses JSON and handles malformed strings gracefully", () => {
    const raw = JSON.stringify({
      "brtel.link": { systemName: "邦润智能" },
    });
    expect(parseDomainBranding(raw)).toEqual({
      "brtel.link": { systemName: "邦润智能" },
    });
    expect(parseDomainBranding("not json")).toEqual({});
    expect(parseDomainBranding(null)).toEqual({});
    expect(parseDomainBranding(undefined)).toEqual({});
  });

  it("resolveEffectiveBranding correctly merges domain overrides and falls back to global defaults", () => {
    const globalDefaults = {
      systemName: "PromptGate",
      systemSlogan: "Default Slogan",
      systemLogoUrl: "/favicon.svg",
      sidebarLogoAnimation: "none",
    };
    const brandingMap = {
      "brtel.link": {
        systemName: "邦润智能",
        systemSlogan: "", // empty string should fall back
        sidebarLogoAnimation: "cyber-glitch",
      },
    };

    const effective = resolveEffectiveBranding("brtel.link", globalDefaults, brandingMap);
    expect(effective.systemName).toBe("邦润智能");
    expect(effective.systemSlogan).toBe("Default Slogan"); // fallback
    expect(effective.systemLogoUrl).toBe("/favicon.svg"); // fallback
    expect(effective.sidebarLogoAnimation).toBe("cyber-glitch");

    // Unconfigured domain uses global defaults
    const unconfigured = resolveEffectiveBranding("other.com", globalDefaults, brandingMap);
    expect(unconfigured).toEqual(globalDefaults);
  });
});

describe("Multi-Domain Gateway Routing (Integration Tests)", () => {
  const fastify = Fastify({ logger: false, trustProxy: true });
  let db: any;
  let client: any;
  let systemSettings: any;
  let subdomains: any;
  let endpoints: any;
  let endpointRoutes: any;
  let providers: any;
  let providerModels: any;
  let apiKeys: any;

  let providerId = "";
  let apiKeyRaw = "";

  beforeAll(async () => {
    ({ db, client } = await initTestDatabase({ dbFilePath: dbFile }));
    ({
      systemSettings,
      subdomains,
      endpoints,
      endpointRoutes,
      providers,
      providerModels,
      apiKeys,
    } = await import("../src/db/schema"));

    // 1. Configure multiple main domains: brtel.link, yutrix.ai
    await db
      .update(systemSettings)
      .set({ value: "brtel.link, yutrix.ai", updatedAt: new Date() })
      .where(eq(systemSettings.key, "mainDomain"));

    await db
      .update(systemSettings)
      .set({ value: "false", updatedAt: new Date() })
      .where(eq(systemSettings.key, "allowUnknownHostFallback"));

    // 2. Insert mock provider and model
    providerId = crypto.randomUUID();
    await db.insert(providers).values({
      id: providerId,
      name: "Mock Provider",
      openaiBaseUrl: "https://api.openai.com/v1",
      enabled: true,
      concurrencyLimit: 10,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(providerModels).values({
      id: crypto.randomUUID(),
      providerId,
      modelId: "gpt-4o",
      displayName: "GPT-4o",
      enabled: true,
      active: true,
      createdAt: new Date(),
    });

    // 3. Insert mock api key
    apiKeyRaw = "sk-multi-test-key-1234567890123456";
    const keyHash = crypto.createHash("sha256").update(apiKeyRaw).digest("hex");
    await db.insert(apiKeys).values({
      id: crypto.randomUUID(),
      userId: "test-user-id",
      name: "Test API Key",
      keyHash,
      keyPrefix: "sk-multi-t",
      status: "active",
      concurrencyLimit: 10,
      createdAt: new Date(),
    });

    // 4. Register gateway, settings, and admin route endpoints
    await fastify.register(require("@fastify/jwt"), { secret: "test-jwt-secret-xyz" });
    fastify.addHook("onRequest", async (request) => {
      request.jwtVerify = async () => {
        (request as any).user = { role: "admin", id: "test-admin-id", username: "admin" };
      };
    });
    const gatewayRoutes = (await import("../src/routes/gateway")).default;
    const settingsRoutes = (await import("../src/routes/settings")).default;
    const routeRoutes = (await import("../src/routes/routes")).default;
    await fastify.register(gatewayRoutes);
    await fastify.register(settingsRoutes);
    await fastify.register(routeRoutes);
    await fastify.ready();
  });

  afterAll(async () => {
    await fastify.close();
    await closeAndCleanup(client, dbFile);
  });

  it("treats both configured main domains as valid root hosts without requiring fallback", async () => {
    // Create an endpoint on /v1/chat/completions
    const endpointId = crypto.randomUUID();
    await db.insert(endpoints).values({
      id: endpointId,
      userId: "test-user-id",
      name: "Root Wildcard Chat",
      path: "/v1/chat/completions",
      incomingProtocol: "openai",
      enabled: true,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Create wildcard route (subdomainId is null)
    const wildcardRouteId = crypto.randomUUID();
    await db.insert(endpointRoutes).values({
      id: wildcardRouteId,
      endpointId,
      subdomainId: null, // wildcard
      providerId,
      providerProtocol: "openai",
      modelId: "gpt-4o",
      enabled: true,
      status: "active",
      weight: 1,
      priority: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // 1. Host: brtel.link (Root of Main Domain 1)
    const res1 = await fastify.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        authorization: `Bearer ${apiKeyRaw}`,
        host: "brtel.link",
      },
      payload: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "hi" }],
      },
    });
    // Should NOT be 404 route_not_configured!
    expect(res1.statusCode).not.toBe(404);

    // 2. Host: yutrix.ai (Root of Main Domain 2)
    const res2 = await fastify.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        authorization: `Bearer ${apiKeyRaw}`,
        host: "yutrix.ai",
      },
      payload: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "hi" }],
      },
    });
    // Should NOT be 404 route_not_configured!
    expect(res2.statusCode).not.toBe(404);

    // 3. Unknown Host: unconfigured.com with allowUnknownHostFallback = false -> 404
    const res3 = await fastify.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        authorization: `Bearer ${apiKeyRaw}`,
        host: "unconfigured.com",
      },
      payload: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "hi" }],
      },
    });
    expect(res3.statusCode).toBe(404);
  });

  it("subdomain prefix route operates across all configured main domains", async () => {
    // Create subdomain with prefix 'api' (hostname: api.brtel.link)
    const subId = crypto.randomUUID();
    await db.insert(subdomains).values({
      id: subId,
      userId: "test-user-id",
      name: "api",
      hostname: "api.brtel.link",
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Create route specifically attached to this subdomain
    const endpointId = crypto.randomUUID();
    await db.insert(endpoints).values({
      id: endpointId,
      userId: "test-user-id",
      name: "Subdomain Endpoint",
      path: "/v1/messages",
      incomingProtocol: "anthropic",
      enabled: true,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const routeId = crypto.randomUUID();
    await db.insert(endpointRoutes).values({
      id: routeId,
      endpointId,
      subdomainId: subId,
      providerId,
      providerProtocol: "anthropic",
      modelId: "gpt-4o",
      enabled: true,
      status: "active",
      weight: 1,
      priority: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // 1. Request via api.brtel.link (Exact match)
    const resExact = await fastify.inject({
      method: "POST",
      url: "/v1/messages",
      headers: {
        authorization: `Bearer ${apiKeyRaw}`,
        host: "api.brtel.link",
      },
      payload: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 100,
      },
    });
    expect(resExact.statusCode).not.toBe(404);

    // 2. Request via api.yutrix.ai (Cross-domain prefix match via Caddy)
    const resCross = await fastify.inject({
      method: "POST",
      url: "/v1/messages",
      headers: {
        authorization: `Bearer ${apiKeyRaw}`,
        host: "api.yutrix.ai",
      },
      payload: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 100,
      },
    });
    // Should match the same subdomain and route, NOT 404!
    expect(resCross.statusCode).not.toBe(404);
  });

  it("subdomain disabled blocks requests across all configured main domains with 403", async () => {
    const disabledSubId = crypto.randomUUID();
    await db.insert(subdomains).values({
      id: disabledSubId,
      userId: "test-user-id",
      name: "blocked",
      hostname: "blocked.brtel.link",
      enabled: false, // Disabled!
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // 1. blocked.brtel.link
    const res1 = await fastify.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        authorization: `Bearer ${apiKeyRaw}`,
        host: "blocked.brtel.link",
      },
      payload: {},
    });
    expect(res1.statusCode).toBe(403);

    // 2. blocked.yutrix.ai
    const res2 = await fastify.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        authorization: `Bearer ${apiKeyRaw}`,
        host: "blocked.yutrix.ai",
      },
      payload: {},
    });
    expect(res2.statusCode).toBe(403);
  });

  it("/v1/models dynamically returns models across multiple main domains", async () => {
    // 1. Models via brtel.link (Main domain 1 root)
    const res1 = await fastify.inject({
      method: "GET",
      url: "/v1/models",
      headers: {
        authorization: `Bearer ${apiKeyRaw}`,
        host: "brtel.link",
      },
    });
    expect(res1.statusCode).toBe(200);
    const data1 = JSON.parse(res1.body);
    expect(Array.isArray(data1.data)).toBe(true);

    // 2. Models via yutrix.ai (Main domain 2 root)
    const res2 = await fastify.inject({
      method: "GET",
      url: "/v1/models",
      headers: {
        authorization: `Bearer ${apiKeyRaw}`,
        host: "yutrix.ai",
      },
    });
    expect(res2.statusCode).toBe(200);
    const data2 = JSON.parse(res2.body);
    expect(Array.isArray(data2.data)).toBe(true);

    // 3. Models via api.yutrix.ai (Subdomain prefix on main domain 2)
    const res3 = await fastify.inject({
      method: "GET",
      url: "/v1/models",
      headers: {
        authorization: `Bearer ${apiKeyRaw}`,
        host: "api.yutrix.ai",
      },
    });
    expect(res3.statusCode).toBe(200);
    const data3 = JSON.parse(res3.body);
    expect(Array.isArray(data3.data)).toBe(true);
  });

  it("delivers tailored public branding per domain via /api/settings/public", async () => {
    // 1. Insert domainBranding in systemSettings
    const domainBrandingConfig = {
      "brtel.link": {
        systemName: "邦润智能",
        systemSlogan: "万法皆空，唯'亿'能破",
        systemLogoUrl: "data:image/png;base64,brtelLogoMock",
        sidebarLogoAnimation: "cyber-glitch",
        appendSloganToTitle: "true",
        hideSystemNameInTitle: "false",
        showGithubIcon: "false",
      },
      "yutrix.ai": {
        systemName: "Yutrix AI",
        sidebarLogoAnimation: "neon-breath",
      },
    };

    await db.delete(systemSettings).where(eq(systemSettings.key, "domainBranding"));
    await db.insert(systemSettings).values({
      key: "domainBranding",
      value: JSON.stringify(domainBrandingConfig),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Request via brtel.link (Full custom branding)
    const resBrtel = await fastify.inject({
      method: "GET",
      url: "/api/settings/public",
      headers: { host: "brtel.link" },
    });
    expect(resBrtel.statusCode).toBe(200);
    const brtelData = JSON.parse(resBrtel.body);
    expect(brtelData.systemName).toBe("邦润智能");
    expect(brtelData.systemSlogan).toBe("万法皆空，唯'亿'能破");
    expect(brtelData.systemLogoUrl).toBe("data:image/png;base64,brtelLogoMock");
    expect(brtelData.sidebarLogoAnimation).toBe("cyber-glitch");
    expect(brtelData.showGithubIcon).toBe("false");
    expect(brtelData.domainBranding).toBeUndefined(); // verify internal key not leaked

    // Request via admin.brtel.link (Subdomain inherits brtel.link's branding)
    const resSub = await fastify.inject({
      method: "GET",
      url: "/api/settings/public",
      headers: { host: "admin.brtel.link" },
    });
    expect(resSub.statusCode).toBe(200);
    const subData = JSON.parse(resSub.body);
    expect(subData.systemName).toBe("邦润智能");

    // Request via yutrix.ai (Partial override + global fallbacks)
    const resYutrix = await fastify.inject({
      method: "GET",
      url: "/api/settings/public",
      headers: { host: "yutrix.ai" },
    });
    expect(resYutrix.statusCode).toBe(200);
    const yutrixData = JSON.parse(resYutrix.body);
    expect(yutrixData.systemName).toBe("Yutrix AI");
    expect(yutrixData.sidebarLogoAnimation).toBe("neon-breath");
    // Fallbacks to global default
    expect(yutrixData.systemLogoUrl).toBe("/favicon.svg");

    // Request via localhost or unconfigured host (Global default)
    const resDefault = await fastify.inject({
      method: "GET",
      url: "/api/settings/public",
      headers: { host: "localhost" },
    });
    expect(resDefault.statusCode).toBe(200);
    const defaultData = JSON.parse(resDefault.body);
    expect(defaultData.systemName).toBe("PromptGate");
  });

  it("multi-secondary-domain routing: enforces single-use main domain per route and routes across all configured subdomains", async () => {
    // 1. Validation test: Reject if same main domain appears twice in same route rule
    const duplicateRes = await fastify.inject({
      method: "POST",
      url: "/api/admin/routes",
      headers: { authorization: "Bearer mock-admin-token" },
      payload: {
        name: "Duplicate Main Domain Test",
        hosts: ["code.brtel.link", "api.brtel.link"],
        path: "/v1/chat/completions",
        incomingProtocol: "openai",
        targets: [
          {
            providerId,
            modelId: "gpt-4o",
            providerProtocol: "openai",
          },
        ],
      },
    });
    expect(duplicateRes.statusCode).toBe(400);
    expect(duplicateRes.body).toContain("同一个路由中只允许一个一级域名出现一次");

    // 2. Successful creation: one subdomain under brtel.link, one subdomain under yutrix.ai
    const createRes = await fastify.inject({
      method: "POST",
      url: "/api/admin/routes",
      headers: { authorization: "Bearer mock-admin-token" },
      payload: {
        name: "Multi-Subdomain Universal Route",
        hosts: ["code.brtel.link", "code.yutrix.ai"],
        path: "/v1/chat/completions",
        incomingProtocol: "openai",
        targets: [
          {
            providerId,
            modelId: "gpt-4o",
            providerProtocol: "openai",
          },
        ],
      },
    });
    expect(createRes.statusCode).toBe(201);
    const createdRoute = JSON.parse(createRes.body);
    expect(createdRoute.id).toBeDefined();

    // 3. Query admin routes: verify both hosts and combined host are returned
    const listRes = await fastify.inject({
      method: "GET",
      url: "/api/admin/routes",
      headers: { authorization: "Bearer mock-admin-token" },
    });
    expect(listRes.statusCode).toBe(200);
    const routesList = JSON.parse(listRes.body);
    const targetRoute = routesList.find((r: any) => r.id === createdRoute.id);
    expect(targetRoute).toBeDefined();
    expect(targetRoute.hosts).toContain("code.brtel.link");
    expect(targetRoute.hosts).toContain("code.yutrix.ai");
    expect(targetRoute.subdomainId).not.toBeNull(); // verify backward compatibility

    // 4. Gateway execution via code.brtel.link
    const resBrtel = await fastify.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        host: "code.brtel.link",
        authorization: `Bearer ${apiKeyRaw}`,
        "content-type": "application/json",
      },
      payload: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hi" }],
      },
    });
    // Should successfully match the route and not be 404
    expect(resBrtel.statusCode).not.toBe(404);

    // 5. Gateway execution via code.yutrix.ai (SAME route, different domain!)
    const resYutrix = await fastify.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        host: "code.yutrix.ai",
        authorization: `Bearer ${apiKeyRaw}`,
        "content-type": "application/json",
      },
      payload: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hi" }],
      },
    });
    expect(resYutrix.statusCode).not.toBe(404);

    // 6. Request to unconfigured subdomain on yutrix.ai does NOT match this specific route
    const resUnmatched = await fastify.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        host: "unmatched-sub.yutrix.ai",
        authorization: `Bearer ${apiKeyRaw}`,
        "content-type": "application/json",
      },
      payload: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hi" }],
      },
    });
    expect([404, 403]).toContain(resUnmatched.statusCode);

    // 7. Backward compatibility test: route with hosts = NULL in DB (simulating production legacy row)
    const existingEp = (await db.select().from(endpoints))[0];
    const legacyRouteId = crypto.randomUUID();
    const legacySubId = crypto.randomUUID();
    await db.insert(subdomains).values({
      id: legacySubId,
      userId: "test-admin-id",
      name: "legacy",
      hostname: "legacy.brtel.link",
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(endpointRoutes).values({
      id: legacyRouteId,
      name: "Legacy Route With Null Hosts",
      endpointId: existingEp.id,
      subdomainId: legacySubId,
      hosts: null, // explicitly NULL to simulate production legacy record!
      providerId,
      providerProtocol: "openai",
      modelId: "gpt-4o",
      enabled: true,
      routingMode: "classic",
      targets: JSON.stringify([{ providerId, modelId: "gpt-4o" }]),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const resLegacy = await fastify.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        host: "legacy.brtel.link",
        authorization: `Bearer ${apiKeyRaw}`,
        "content-type": "application/json",
      },
      payload: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hi" }],
      },
    });
    expect(resLegacy.statusCode).not.toBe(404);
  });

  it("does not cross-bind a prefix when two subdomains already share that name", async () => {
    const endpointId = crypto.randomUUID();
    await db.insert(endpoints).values({
      id: endpointId,
      userId: "test-user-id",
      name: "Ambiguous Prefix Endpoint",
      path: "/v0/chat/completions",
      incomingProtocol: "openai",
      enabled: true,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const brtelSubId = crypto.randomUUID();
    const yutrixSubId = crypto.randomUUID();
    const soloSubId = crypto.randomUUID();
    await db.insert(subdomains).values({
      id: brtelSubId,
      userId: "test-user-id",
      name: "twin",
      hostname: "twin.brtel.link",
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(subdomains).values({
      id: yutrixSubId,
      userId: "test-user-id",
      name: "twin",
      hostname: "twin.yutrix.ai",
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(subdomains).values({
      id: soloSubId,
      userId: "test-user-id",
      name: "solo",
      hostname: "solo.brtel.link",
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const routeBase = {
      endpointId,
      hosts: null,
      providerId,
      providerProtocol: "openai",
      modelId: "gpt-4o",
      enabled: true,
      status: "active",
      weight: 1,
      priority: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await db.insert(endpointRoutes).values({
      ...routeBase,
      id: crypto.randomUUID(),
      name: "Twin Brtel",
      subdomainId: brtelSubId,
    });
    await db.insert(endpointRoutes).values({
      ...routeBase,
      id: crypto.randomUUID(),
      name: "Twin Yutrix",
      subdomainId: yutrixSubId,
      priority: 1,
    });
    await db.insert(endpointRoutes).values({
      ...routeBase,
      id: crypto.randomUUID(),
      name: "Solo Brtel",
      subdomainId: soloSubId,
    });

    await db
      .update(systemSettings)
      .set({ value: "brtel.link, yutrix.ai, other.net", updatedAt: new Date() })
      .where(eq(systemSettings.key, "mainDomain"));

    const payload = { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] };

    const resExact = await fastify.inject({
      method: "POST",
      url: "/v0/chat/completions",
      headers: { host: "twin.brtel.link", authorization: `Bearer ${apiKeyRaw}` },
      payload,
    });
    expect(resExact.statusCode).not.toBe(404);

    const resAmbiguous = await fastify.inject({
      method: "POST",
      url: "/v0/chat/completions",
      headers: { host: "twin.other.net", authorization: `Bearer ${apiKeyRaw}` },
      payload,
    });
    expect(resAmbiguous.statusCode).toBe(404);

    const resSolo = await fastify.inject({
      method: "POST",
      url: "/v0/chat/completions",
      headers: { host: "solo.other.net", authorization: `Bearer ${apiKeyRaw}` },
      payload,
    });
    expect(resSolo.statusCode).not.toBe(404);

    await db
      .update(systemSettings)
      .set({ value: "brtel.link, yutrix.ai", updatedAt: new Date() })
      .where(eq(systemSettings.key, "mainDomain"));
  });
});

