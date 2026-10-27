import { describe, expect, it } from "vitest";
import {
  CLASSIC_TARGET_WEIGHT_OPTIONS,
  DEFAULT_ROUTING_MODE,
  ROUTING_MODES,
  coerceClassicTargetFromLegacy,
  coerceLegacyRouteForDisplay,
  defaultClassicTargetWeight,
  isClassicRoutingMode,
  isLegacyOpcRoutingMode,
  isRoutingMode,
  normalizeClassicTargetWeight,
  normalizeRoutingModeInput,
  resolveRouteRoutingMode,
  resolveEffectiveLayerTarget,
  seedModelFromLegacyTarget,
  selectClassicInitialTargetIndex,
  shouldBypassCapabilityRouting,
  strategyRoutingEnabledForLayer,
} from "../src/services/opcAgentRouting";
import { createInitialAttemptState } from "../src/routes/gateway/authorization";

describe("classic routing mode", () => {
  it("registers classic as a first-class routing mode", () => {
    expect(ROUTING_MODES).toEqual(["classic", "strategy"]);
    expect(DEFAULT_ROUTING_MODE).toBe("classic");
    expect(isRoutingMode("classic")).toBe(true);
    expect(isRoutingMode("opc_agent")).toBe(false);
  });

  it("resolves classic mode from route payload", () => {
    expect(resolveRouteRoutingMode({ routingMode: "classic" })).toBe("classic");
    expect(isClassicRoutingMode({ routingMode: "classic" })).toBe(true);
    expect(isClassicRoutingMode({ routingMode: "strategy" })).toBe(false);
  });

  it("maps legacy opc_agent to classic for read and write paths", () => {
    expect(resolveRouteRoutingMode({ routingMode: "opc_agent" })).toBe("classic");
    expect(normalizeRoutingModeInput("opc_agent")).toBe("classic");
    expect(isLegacyOpcRoutingMode("opc_agent")).toBe(true);
  });

  it("normalizes API input with classic as create default", () => {
    expect(normalizeRoutingModeInput(undefined)).toBe("classic");
    expect(normalizeRoutingModeInput(null)).toBe("classic");
    expect(normalizeRoutingModeInput("bogus")).toBe("classic");
    expect(normalizeRoutingModeInput("strategy", "strategy")).toBe("strategy");
  });

  it("disables strategy routing for every layer when mode is classic", () => {
    const classicRoute = {
      routingMode: "classic",
      strategyRoutingEnabled: true,
      targets: JSON.stringify([
        { strategyRoutingEnabled: true, providerId: "p1", modelId: "m1" },
        { strategyRoutingEnabled: true, providerId: "p2", modelId: "m2" },
      ]),
    };
    expect(strategyRoutingEnabledForLayer(classicRoute, 0)).toBe(false);
    expect(strategyRoutingEnabledForLayer(classicRoute, 1)).toBe(false);
  });

  it("treats legacy opc routes as classic at the gateway layer", () => {
    const legacyOpcRoute = {
      routingMode: "opc_agent",
      strategyRoutingEnabled: true,
      targets: JSON.stringify([{ strategyRoutingEnabled: true, providerId: "p1", modelId: "m1" }]),
    };
    expect(strategyRoutingEnabledForLayer(legacyOpcRoute, 0)).toBe(false);
    expect(shouldBypassCapabilityRouting(legacyOpcRoute)).toBe(true);
  });

  it("preserves strategy enablement for non-classic funnel routes", () => {
    const strategyRoute = {
      routingMode: "strategy",
      strategyRoutingEnabled: false,
      targets: JSON.stringify([
        { strategyRoutingEnabled: true },
        { strategyRoutingEnabled: false },
      ]),
    };
    expect(strategyRoutingEnabledForLayer(strategyRoute, 0)).toBe(true);
    expect(strategyRoutingEnabledForLayer(strategyRoute, 1)).toBe(false);
  });

  it("legacy routes without routingMode still default to strategy", () => {
    expect(resolveRouteRoutingMode({})).toBe("strategy");
    expect(resolveRouteRoutingMode({ routingMode: "invalid" })).toBe("strategy");
  });
});

describe("legacy opc route display coercion", () => {
  it("collapses matrix targets to a single model using general fallback", () => {
    const target = coerceClassicTargetFromLegacy({
      providerId: "",
      modelId: "",
      strategyRoutingEnabled: true,
      strategyRoutingRules: [
        { taskType: "thinking", providerId: "p-think", modelId: "think-model", enabled: true },
        { taskType: "general", providerId: "p-gen", modelId: "gen-model", enabled: true },
      ],
    });
    expect(seedModelFromLegacyTarget(target)).toEqual({
      providerId: "p-gen",
      providerProtocol: "openai",
      modelId: "gen-model",
    });
    expect(target.strategyRoutingEnabled).toBe(false);
    expect(target.strategyRoutingRules).toEqual([]);
    expect(target.providerId).toBe("p-gen");
    expect(target.modelId).toBe("gen-model");
  });

  it("coerces legacy opc route payload for admin API display", () => {
    const coerced = coerceLegacyRouteForDisplay({
      routingMode: "opc_agent",
      targets: JSON.stringify([
        {
          strategyRoutingEnabled: true,
          strategyRoutingRules: [
            { taskType: "action", providerId: "p1", modelId: "action-model" },
            { taskType: "general", providerId: "p1", modelId: "general-model" },
          ],
        },
      ]),
    });
    expect(coerced.routingMode).toBe("classic");
    expect(coerced.targets[0].providerId).toBe("p1");
    expect(coerced.targets[0].modelId).toBe("general-model");
    expect(coerced.targets[0].strategyRoutingEnabled).toBe(false);
  });

  it("resolves effective layer target for classic routes", () => {
    const route = { routingMode: "opc_agent" };
    const effective = resolveEffectiveLayerTarget(route, {
      providerId: "",
      modelId: "",
      strategyRoutingRules: [
        { taskType: "general", providerId: "p1", modelId: "m1", providerProtocol: "openai" },
      ],
    });
    expect(effective.providerId).toBe("p1");
    expect(effective.modelId).toBe("m1");
    expect(effective.strategyRoutingEnabled).toBe(false);
  });
});

describe("classic route target shape", () => {
  it("expects single model per layer (strategyRoutingEnabled false)", () => {
    const classicTarget = {
      providerId: "prov-1",
      modelId: "gpt-4",
      providerProtocol: "openai",
      strategyRoutingEnabled: false,
      strategyRoutingRules: [],
    };
    expect(classicTarget.strategyRoutingEnabled).toBe(false);
    expect(classicTarget.strategyRoutingRules).toEqual([]);
    expect(classicTarget.providerId).toBeTruthy();
    expect(classicTarget.modelId).toBeTruthy();
  });

  it("normalizes classic per-layer weights in 10% increments with L1=100% and subsequent=0% defaults", () => {
    expect(CLASSIC_TARGET_WEIGHT_OPTIONS).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
    expect(defaultClassicTargetWeight(0)).toBe(100);
    expect(defaultClassicTargetWeight(1)).toBe(0);
    expect(defaultClassicTargetWeight(2)).toBe(0);

    expect(normalizeClassicTargetWeight(undefined, 0)).toBe(100);
    expect(normalizeClassicTargetWeight(undefined, 1)).toBe(0);
    expect(normalizeClassicTargetWeight(70, 0)).toBe(70);
    expect(normalizeClassicTargetWeight("30", 1)).toBe(30);
    expect(normalizeClassicTargetWeight(0, 0)).toBe(0);
    expect(normalizeClassicTargetWeight(15, 0)).toBe(100);
    expect(normalizeClassicTargetWeight(15, 1)).toBe(0);
  });

  it("routes 100% of requests to L1 when L1 is 100% regardless of subsequent layer weights", () => {
    const targets = [
      { providerId: "p1", modelId: "m1", providerProtocol: "openai", weight: 100 },
      { providerId: "p2", modelId: "m2", providerProtocol: "openai", weight: 50 },
    ];
    expect(selectClassicInitialTargetIndex(targets, () => 0)).toBe(0);
    expect(selectClassicInitialTargetIndex(targets, () => 0.99)).toBe(0);

    const attempt = createInitialAttemptState(
      { routingMode: "classic", targets: JSON.stringify(targets) },
      () => 0.99,
    );
    expect(attempt.targetIndex).toBe(0);
    expect(attempt.providerId).toBe("p1");
    expect(attempt.modelId).toBe("m1");
  });

  it("splits initial traffic by cumulative ratio and never routes initial traffic to 0% fallback layers", () => {
    // Exact production case: L1=90%, L2=10%, L3=0% (GROK fallback only)
    const threeLayerTargets = [
      { providerId: "antigravity", modelId: "gemini-3.8-flash-high", providerProtocol: "openai", weight: 90 },
      { providerId: "ali", modelId: "qwen3.7-plus", providerProtocol: "openai", weight: 10 },
      { providerId: "grok", modelId: "grok-4.5", providerProtocol: "openai", weight: 0 },
    ];
    expect(selectClassicInitialTargetIndex(threeLayerTargets, () => 0)).toBe(0);
    expect(selectClassicInitialTargetIndex(threeLayerTargets, () => 0.89)).toBe(0);
    expect(selectClassicInitialTargetIndex(threeLayerTargets, () => 0.9)).toBe(1);
    expect(selectClassicInitialTargetIndex(threeLayerTargets, () => 0.99)).toBe(1);

    const attemptL2 = createInitialAttemptState(
      { routingMode: "classic", targets: JSON.stringify(threeLayerTargets) },
      () => 0.95,
    );
    expect(attemptL2.targetIndex).toBe(1);
    expect(attemptL2.providerId).toBe("ali");
    expect(attemptL2.modelId).toBe("qwen3.7-plus");

    // 3-way split with 4th layer at 0% fallback
    const fourLayerTargets = [
      { providerId: "p1", modelId: "m1", providerProtocol: "openai", weight: 50 },
      { providerId: "p2", modelId: "m2", providerProtocol: "openai", weight: 30 },
      { providerId: "p3", modelId: "m3", providerProtocol: "openai", weight: 20 },
      { providerId: "p4", modelId: "m4", providerProtocol: "openai", weight: 0 },
    ];
    expect(selectClassicInitialTargetIndex(fourLayerTargets, () => 0.49)).toBe(0);
    expect(selectClassicInitialTargetIndex(fourLayerTargets, () => 0.5)).toBe(1);
    expect(selectClassicInitialTargetIndex(fourLayerTargets, () => 0.79)).toBe(1);
    expect(selectClassicInitialTargetIndex(fourLayerTargets, () => 0.8)).toBe(2);
    expect(selectClassicInitialTargetIndex(fourLayerTargets, () => 0.99)).toBe(2);
  });
});
