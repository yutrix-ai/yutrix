import { z } from "zod";

/**
 * Partial schema for PATCH bodies. Zod 4 applies `.default()` even when the
 * field is wrapped by `.partial()`, which would reset omitted fields; defaults
 * are stripped so omitted keys stay absent from the parsed output.
 */
export function patchSchema<T extends z.ZodObject>(schema: T): ReturnType<T["partial"]> {
  const shape: Record<string, z.ZodType> = {};
  for (const [key, field] of Object.entries(schema.shape as Record<string, z.ZodType>)) {
    shape[key] = field instanceof z.ZodDefault ? (field.unwrap() as z.ZodType) : field;
  }
  return schema.extend(shape).partial() as ReturnType<T["partial"]>;
}
