import { describe, it, expect } from "vitest";
import { mergeRoutingAdjustments } from "../src/services/distillation/routingMerger";
import { consolidateSkillFragments } from "../src/services/distillation/skillConsolidator";
import { buildSkillZipBuffer } from "../src/services/distillation/skillZipExporter";

describe("distillation routingMerger", () => {
  it("merges weight deltas across proposals", () => {
    const merged = mergeRoutingAdjustments([
      {
        action: "signal_adjust",
        adjustments: [
          {
            type: "weight_delta",
            taskType: "debug",
            token: "error",
            delta: 2,
            reason: "r1",
          },
        ],
      },
      {
        action: "signal_adjust",
        adjustments: [
          {
            type: "weight_delta",
            taskType: "debug",
            token: "error",
            delta: 1,
            reason: "r2",
          },
        ],
      },
    ]);
    expect(merged.weightOverrides.debug?.error).toBe(3);
  });
});

describe("distillation skillConsolidator", () => {
  it("deduplicates fragments into skill files", () => {
    const pkg = consolidateSkillFragments({
      userId: "u1",
      username: "alice",
      version: 1,
      fragments: [
        {
          capability: ["prefers tests"],
          heuristic: [],
          workflow: ["bug: reproduce first"],
          persona: ["concise replies"],
        },
        {
          capability: ["prefers tests"],
          heuristic: ["asks clarifying questions"],
          workflow: [],
          persona: [],
        },
      ],
    });
    expect(pkg.files["SKILL.md"]).toContain("alice");
    expect(pkg.files["capability.md"]).toContain("prefers tests");
    expect(pkg.files["persona.md"]).toContain("concise replies");
  });
});

describe("distillation skillZipExporter", () => {
  it("produces a valid zip buffer", () => {
    const buf = buildSkillZipBuffer({
      "SKILL.md": "# skill",
      "meta.json": "{}",
    });
    expect(buf[0]).toBe(0x50);
    expect(buf[1]).toBe(0x4b);
  });
});
