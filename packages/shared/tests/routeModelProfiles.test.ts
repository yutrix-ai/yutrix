import { describe, expect, it } from "vitest";
import {
  findRouteModelProfile,
  modelProfileKey,
  parseRouteModelProfiles,
  validateModelProfileNames,
} from "../src/routeModelProfiles";

const layer = { providerId: "p1", modelId: "m1", providerProtocol: "openai" };

describe("route model profiles", () => {
  it("treats NULL, empty and corrupt values as no profiles", () => {
    expect(parseRouteModelProfiles(null)).toEqual([]);
    expect(parseRouteModelProfiles(undefined)).toEqual([]);
    expect(parseRouteModelProfiles("")).toEqual([]);
    expect(parseRouteModelProfiles("{not json")).toEqual([]);
    expect(parseRouteModelProfiles("{}")).toEqual([]);
    expect(parseRouteModelProfiles([])).toEqual([]);
  });

  it("drops entries without a name or layers and keeps the first duplicate", () => {
    const parsed = parseRouteModelProfiles(
      JSON.stringify([
        { name: " fast ", routingMode: "classic", targets: [layer] },
        { name: "", targets: [layer] },
        { name: "empty", targets: [] },
        { name: "FAST", targets: [{ ...layer, modelId: "other" }] },
        null,
        "junk",
      ]),
    );
    expect(parsed).toEqual([{ name: "fast", routingMode: "classic", targets: [layer] }]);
  });

  it("matches the request model trimmed and case-insensitively", () => {
    const profiles = parseRouteModelProfiles([{ name: "Yutrix-Cheap", routingMode: "classic", targets: [layer] }]);
    expect(findRouteModelProfile(profiles, " yutrix-cheap ")?.name).toBe("Yutrix-Cheap");
    expect(findRouteModelProfile(profiles, "yutrix-cheap-2")).toBeNull();
    expect(findRouteModelProfile(profiles, "")).toBeNull();
    expect(findRouteModelProfile(profiles, null)).toBeNull();
    expect(findRouteModelProfile(profiles, 42)).toBeNull();
    expect(modelProfileKey("  AbC ")).toBe("abc");
  });

  it("validates names: required, reserved, duplicate", () => {
    expect(validateModelProfileNames(["a", "b"])).toEqual({ ok: true });
    expect(validateModelProfileNames(["a", " "])).toMatchObject({ ok: false, code: "required" });
    expect(validateModelProfileNames(["Default"])).toMatchObject({ ok: false, code: "reserved" });
    expect(validateModelProfileNames(["a", " A "])).toMatchObject({ ok: false, code: "duplicate" });
    expect(validateModelProfileNames(["x".repeat(129)])).toMatchObject({ ok: false, code: "too_long" });
  });
});
