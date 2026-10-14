import { describe, expect, it } from "vitest";
import { z } from "zod";
import { distillationSettingsSchema } from "@promptgate/shared";
import { patchSchema } from "../src/utils/zodPatch";
import { updateProviderSchema } from "../src/services/providerService";

describe("patchSchema", () => {
  const schema = z.object({
    name: z.string().min(1),
    enabled: z.boolean().default(true),
    weight: z.number().default(1),
    note: z.string().optional(),
  });

  it("does not fill defaults for omitted keys", () => {
    expect(patchSchema(schema).parse({})).toStrictEqual({});
    expect(patchSchema(schema).parse({ note: "x" })).toStrictEqual({ note: "x" });
  });

  it("keeps explicitly provided values and validation", () => {
    expect(patchSchema(schema).parse({ enabled: false, weight: 3 })).toStrictEqual({ enabled: false, weight: 3 });
    expect(patchSchema(schema).safeParse({ name: "" }).success).toBe(false);
    expect(patchSchema(schema).safeParse({ enabled: "yes" }).success).toBe(false);
  });

  it("leaves the source schema defaults intact", () => {
    expect(schema.parse({ name: "a" })).toStrictEqual({ name: "a", enabled: true, weight: 1 });
  });

  it("provider PATCH schema does not reset omitted fields", () => {
    expect(updateProviderSchema.parse({ name: "renamed" })).toStrictEqual({ name: "renamed" });
  });

  it("distillation settings PATCH schema does not reset omitted fields", () => {
    expect(patchSchema(distillationSettingsSchema).parse({ concurrency: 3 })).toStrictEqual({ concurrency: 3 });
  });
});
