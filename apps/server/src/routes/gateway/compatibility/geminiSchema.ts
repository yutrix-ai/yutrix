import { GEMINI_STRING_FORMATS, MAX_GEMINI_SCHEMA_DEPTH } from "./spec";

const GEMINI_SCHEMA_KEYS = new Set([
  "type",
  "format",
  "description",
  "nullable",
  "enum",
  "maxItems",
  "minItems",
  "properties",
  "required",
  "propertyOrdering",
  "items",
]);

function normalizeSchemaType(value: any, out: Record<string, any>): void {
  if (Array.isArray(value)) {
    const nonNull = value.find((item) => item !== "null");
    if (nonNull) out.type = nonNull;
    if (value.includes("null")) out.nullable = true;
    return;
  }
  if (value !== undefined) out.type = value;
}

function jsonTypeOf(value: any): string | undefined {
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  if (typeof value === "string") return "string";
  if (Array.isArray(value)) return "array";
  if (value && typeof value === "object") return "object";
  return undefined;
}

function uniqueEnumValues(values: any[]): any[] {
  const seen = new Set<string>();
  const out: any[] = [];
  for (const value of values) {
    let key: string;
    try {
      key = `${typeof value}:${JSON.stringify(value)}`;
    } catch {
      key = `${typeof value}:${String(value)}`;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function appendConstraintHint(out: Record<string, any>, values: any[]): void {
  const rendered = values.map((value) => {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  });
  const hint = `Allowed values: ${rendered.join(", ")}`;
  if (typeof out.description === "string" && out.description.includes(hint)) return;
  out.description = out.description ? `${out.description} ${hint}` : hint;
}

function isBooleanPair(values: any[]): boolean {
  return values.length === 2 && values.includes(true) && values.includes(false);
}

function sanitizeGeminiEnum(out: Record<string, any>): void {
  if (!Object.prototype.hasOwnProperty.call(out, "enum")) return;
  const raw = out.enum;
  if (!Array.isArray(raw) || raw.length === 0) {
    delete out.enum;
    return;
  }

  const hasNull = raw.some((item) => item === null);
  const nonNull = uniqueEnumValues(raw.filter((item) => item !== null && item !== undefined));
  if (hasNull) out.nullable = true;

  if (nonNull.length === 0) {
    delete out.enum;
    return;
  }

  if (nonNull.every((item) => typeof item === "string")) {
    out.enum = nonNull;
    return;
  }

  const types = new Set(nonNull.map(jsonTypeOf).filter(Boolean) as string[]);
  if (!out.type && types.size === 1) {
    out.type = [...types][0];
  }

  delete out.enum;
  if (!isBooleanPair(nonNull)) {
    appendConstraintHint(out, nonNull);
  }
}

function sanitizeGeminiStringFormat(out: Record<string, any>): void {
  if (out.format === undefined) return;
  const format = String(out.format).toLowerCase();
  const type = typeof out.type === "string" ? out.type.toLowerCase() : "";
  if (type && type !== "string") {
    delete out.format;
    return;
  }
  if (!GEMINI_STRING_FORMATS.has(format)) {
    delete out.format;
    return;
  }
  out.format = format;
}

function sanitizeGeminiArray(out: Record<string, any>): void {
  if (!out.type && out.items !== undefined) {
    out.type = "array";
  }
  if (out.type !== "array") return;

  if (
    out.items === undefined ||
    out.items === null ||
    typeof out.items !== "object"
  ) {
    out.items = { type: "string" };
    return;
  }

  if (!Array.isArray(out.items) && !out.items.type) {
    out.items = {
      ...out.items,
      type: out.items.properties ? "object" : "string",
    };
  }
}

const POST_SANITIZERS: Array<(out: Record<string, any>) => void> = [
  sanitizeGeminiEnum,
  sanitizeGeminiStringFormat,
  sanitizeGeminiArray,
];

function liftSchemaCombinators(schema: Record<string, any>): Record<string, any> {
  const combinator = schema.anyOf ?? schema.oneOf ?? schema.allOf;
  if (!Array.isArray(combinator) || combinator.length === 0) {
    return schema;
  }

  const branches = combinator.filter(
    (item): item is Record<string, any> =>
      Boolean(item && typeof item === "object" && !Array.isArray(item)),
  );
  if (branches.length === 0) return schema;

  const hasNull = branches.some((branch) => branch.type === "null");
  const primary =
    branches.find(
      (branch) =>
        branch.type !== "null" &&
        (branch.type !== undefined ||
          branch.properties !== undefined ||
          branch.items !== undefined ||
          branch.enum !== undefined ||
          branch.const !== undefined),
    ) ??
    branches.find((branch) => branch.type !== "null") ??
    null;

  const merged: Record<string, any> = { ...schema };
  if (primary) {
    for (const [key, value] of Object.entries(primary)) {
      if (merged[key] === undefined) {
        merged[key] = value;
      }
    }
  }
  if (hasNull && merged.nullable === undefined) {
    merged.nullable = true;
  }
  return merged;
}

function liftConstToEnum(schema: Record<string, any>): Record<string, any> {
  const lifted = liftSchemaCombinators(schema);
  if (
    lifted.items === undefined &&
    Array.isArray(lifted.prefixItems) &&
    lifted.prefixItems.length > 0
  ) {
    return {
      ...lifted,
      items: lifted.prefixItems[0],
      ...(lifted.const !== undefined && lifted.enum === undefined ? { enum: [lifted.const] } : {}),
    };
  }
  if (lifted.const !== undefined && lifted.enum === undefined) {
    return { ...lifted, enum: [lifted.const] };
  }
  return lifted;
}

/**
 * Open for new Gemini proto field rules via POST_SANITIZERS / GEMINI_SCHEMA_KEYS.
 * Never stringifies non-string enum values.
 */
export function sanitizeGeminiSchema(
  schema: any,
  depth = 0,
  seen?: WeakSet<object>,
): any {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
  if (depth > MAX_GEMINI_SCHEMA_DEPTH) {
    return typeof schema.type === "string" ? { type: schema.type } : { type: "object" };
  }

  const tracker = seen ?? new WeakSet<object>();
  if (tracker.has(schema)) return { type: "object" };
  tracker.add(schema);

  const source = liftConstToEnum(schema);
  const out: Record<string, any> = {};

  for (const [key, value] of Object.entries(source)) {
    if (key === "type") {
      normalizeSchemaType(value, out);
      continue;
    }
    if (!GEMINI_SCHEMA_KEYS.has(key)) continue;

    if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
      const properties: Record<string, any> = {};
      for (const [propName, propSchema] of Object.entries(value)) {
        properties[propName] = sanitizeGeminiSchema(propSchema, depth + 1, tracker);
      }
      out.properties = properties;
      continue;
    }

    if (key === "items") {
      out.items = Array.isArray(value)
        ? value.map((item) => sanitizeGeminiSchema(item, depth + 1, tracker))
        : sanitizeGeminiSchema(value, depth + 1, tracker);
      continue;
    }

    out[key] = value;
  }

  for (const apply of POST_SANITIZERS) {
    try {
      apply(out);
    } catch {
      // A single field rule must not discard the rest of the schema.
    }
  }
  if (!out.type && out.properties) out.type = "object";
  return out;
}
