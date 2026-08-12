import { describe, expect, it } from "vitest";
import {
  applyClientModelOverrideToAttempt,
  extractL0Config,
  normalizeUserRouteOverridePayload,
  resolveClientModelAgainstL0,
} from "../src/services/clientModelOverride";

const L0_RULES = [
  {
    taskType: "code",
    providerId: "prov-code",
    providerProtocol: "openai",
    modelId: "code-model",
    enabled: true,
  },
  {
    taskType: "vision",
    providerId: "prov-vision",
    providerProtocol: "openai",
    modelId: "vision-model",
    enabled: true,
  },
  {
    taskType: "general",
    providerId: "prov-general",
    providerProtocol: "anthropic",
    modelId: "general-model",
    enabled: true,
  },
];

function routeWithL0(overrides: Record<string, any> = {}) {
  return {
    providerId: "prov-base",
    providerProtocol: "openai",
    modelId: "base-model",
    promptPolicyId: "policy-1",
    strategyRoutingEnabled: true,
    strategyRoutingRules: JSON.stringify(L0_RULES),
    ...overrides,
  };
}

describe("normalizeUserRouteOverridePayload (mutual exclusion)", () => {
  it("client mode clears fixed modelId and strategy rules", () => {
    const n = normalizeUserRouteOverridePayload({
      useClientModel: true,
      modelId: "should-be-cleared",
      strategyRoutingRules: JSON.stringify(L0_RULES),
    });
    expect(n.mode).toBe("client");
    expect(n.useClientModel).toBe(true);
    expect(n.modelId).toBeNull();
    expect(n.strategyRoutingRules).toBeNull();
  });

  it("fixed mode cannot set useClientModel", () => {
    const n = normalizeUserRouteOverridePayload({
      useClientModel: false,
      modelId: "fixed-model",
      strategyRoutingRules: null,
    });
    expect(n.mode).toBe("fixed");
    expect(n.useClientModel).toBe(false);
    expect(n.modelId).toBe("fixed-model");
    expect(n.strategyRoutingRules).toBeNull();
  });

  it("strategy mode clears modelId and useClientModel", () => {
    const n = normalizeUserRouteOverridePayload({
      useClientModel: false,
      modelId: "ignored-when-strategy",
      strategyRoutingRules: JSON.stringify(L0_RULES),
    });
    expect(n.mode).toBe("strategy");
    expect(n.useClientModel).toBe(false);
    expect(n.modelId).toBeNull();
    expect(n.strategyRoutingRules).toContain("general-model");
  });

  it("default clears all override signals", () => {
    const n = normalizeUserRouteOverridePayload({
      useClientModel: false,
      modelId: null,
      strategyRoutingRules: null,
    });
    expect(n.mode).toBe("default");
    expect(n.useClientModel).toBe(false);
    expect(n.modelId).toBeNull();
    expect(n.strategyRoutingRules).toBeNull();
  });
});

describe("resolveClientModelAgainstL0", () => {
  it("matches client model name to an L0 strategy rule model", () => {
    const r = resolveClientModelAgainstL0({
      clientModelId: "code-model",
      route: routeWithL0(),
    });
    expect(r.matched).toBe(true);
    expect(r.source).toBe("client_match");
    expect(r.modelId).toBe("code-model");
    expect(r.providerId).toBe("prov-code");
  });

  it("matches client model name to L0 base model when not in rules", () => {
    const r = resolveClientModelAgainstL0({
      clientModelId: "base-model",
      route: routeWithL0(),
    });
    expect(r.matched).toBe(true);
    expect(r.source).toBe("client_match");
    expect(r.modelId).toBe("base-model");
    expect(r.providerId).toBe("prov-base");
  });

  it("falls through to General when client model matches nothing on L0", () => {
    const r = resolveClientModelAgainstL0({
      clientModelId: "unknown-from-client",
      route: routeWithL0(),
    });
    expect(r.matched).toBe(false);
    expect(r.source).toBe("general");
    expect(r.modelId).toBe("general-model");
    expect(r.providerId).toBe("prov-general");
    expect(r.providerProtocol).toBe("anthropic");
  });

  it("falls through to General when client model is empty", () => {
    const r = resolveClientModelAgainstL0({
      clientModelId: "",
      route: routeWithL0(),
    });
    expect(r.matched).toBe(false);
    expect(r.source).toBe("general");
    expect(r.modelId).toBe("general-model");
  });

  it("uses targets[0] as L0 when funnel targets are present", () => {
    const route = routeWithL0({
      providerId: "ignored-top",
      modelId: "ignored-top-model",
      strategyRoutingRules: null,
      targets: JSON.stringify([
        {
          providerId: "l0-prov",
          providerProtocol: "openai",
          modelId: "l0-base",
          strategyRoutingEnabled: true,
          strategyRoutingRules: L0_RULES,
        },
        {
          providerId: "l1-prov",
          modelId: "l1-model",
          strategyRoutingRules: [
            {
              taskType: "general",
              providerId: "l1-prov",
              providerProtocol: "openai",
              modelId: "l1-general",
              enabled: true,
            },
          ],
        },
      ]),
    });

    const hit = resolveClientModelAgainstL0({
      clientModelId: "vision-model",
      route,
    });
    expect(hit.matched).toBe(true);
    expect(hit.modelId).toBe("vision-model");
    expect(hit.providerId).toBe("prov-vision");

    const miss = resolveClientModelAgainstL0({
      clientModelId: "l1-general",
      route,
    });
    // L1 models must not count as L0 hits
    expect(miss.matched).toBe(false);
    expect(miss.source).toBe("general");
    expect(miss.modelId).toBe("general-model");
  });

  it("falls back to L0 base when no General rule exists", () => {
    const r = resolveClientModelAgainstL0({
      clientModelId: "nope",
      route: {
        providerId: "p",
        providerProtocol: "openai",
        modelId: "only-base",
        strategyRoutingEnabled: true,
        strategyRoutingRules: JSON.stringify([
          {
            taskType: "code",
            providerId: "p",
            providerProtocol: "openai",
            modelId: "code-only",
            enabled: true,
          },
        ]),
      },
    });
    expect(r.matched).toBe(false);
    expect(r.source).toBe("l0_base");
    expect(r.modelId).toBe("only-base");
  });
});

describe("applyClientModelOverrideToAttempt", () => {
  it("mutates attempt to matched L0 model and disables content strategy", () => {
    const route = routeWithL0({
      targets: JSON.stringify([
        {
          providerId: "prov-base",
          providerProtocol: "openai",
          modelId: "base-model",
          strategyRoutingEnabled: true,
          strategyRoutingRules: L0_RULES,
        },
      ]),
    });
    const attempt = {
      providerId: "prov-base",
      providerProtocol: "openai",
      modelId: "base-model",
      promptPolicyId: null as string | null,
    };

    const resolved = applyClientModelOverrideToAttempt({
      route,
      clientModelId: "code-model",
      currentAttempt: attempt,
    });

    expect(resolved.matched).toBe(true);
    expect(attempt.modelId).toBe("code-model");
    expect(attempt.providerId).toBe("prov-code");
    expect(route.strategyRoutingEnabled).toBe(false);

    const targets =
      typeof route.targets === "string"
        ? JSON.parse(route.targets)
        : route.targets;
    expect(targets[0].strategyRoutingEnabled).toBe(false);
  });

  it("on miss sets General and leaves strategy disabled", () => {
    const route = routeWithL0();
    const attempt = {
      providerId: "prov-base",
      providerProtocol: "openai",
      modelId: "base-model",
      promptPolicyId: null as string | null,
    };

    applyClientModelOverrideToAttempt({
      route,
      clientModelId: "totally-unknown",
      currentAttempt: attempt,
    });

    expect(attempt.modelId).toBe("general-model");
    expect(attempt.providerId).toBe("prov-general");
    expect(route.strategyRoutingEnabled).toBe(false);
  });
});

describe("extractL0Config + fixed/default regression anchors", () => {
  it("extracts route-level L0 when no targets", () => {
    const { base, rules, strategyEnabled } = extractL0Config(routeWithL0());
    expect(strategyEnabled).toBe(true);
    expect(base.modelId).toBe("base-model");
    expect(rules.map((r) => r.taskType)).toContain("general");
  });

  it("documents that fixed override path is separate from client match", () => {
    // Fixed mode payload must not look like client mode after normalize
    const fixed = normalizeUserRouteOverridePayload({
      useClientModel: false,
      modelId: "page-fixed",
    });
    expect(fixed.mode).toBe("fixed");
    expect(fixed.useClientModel).toBe(false);

    // Client match resolution still only uses request model, not page model
    const r = resolveClientModelAgainstL0({
      clientModelId: "page-fixed",
      route: routeWithL0(),
    });
    // page-fixed is not on L0 → General (proves page model is not auto-matched
    // unless it also exists as an L0 model name)
    expect(r.source).toBe("general");
  });
});
