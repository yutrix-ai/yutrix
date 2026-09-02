import { describe, expect, it } from "vitest";
import {
  DEFAULT_ROUTING_MODE,
  ROUTING_MODES,
  coerceClassicTargetFromLegacy,
  coerceLegacyRouteForDisplay,
  isClassicRoutingMode,
  isLegacyOpcRoutingMode,
  isRoutingMode,
  normalizeRoutingModeInput,
  resolveRouteRoutingMode,
  resolveEffectiveLayerTarget,
  seedModelFromLegacyTarget,
  shouldBypassCapabilityRouting,
  strategyRoutingEnabledForLayer,
} from "../src/services/opcAgentRouting";

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
});
