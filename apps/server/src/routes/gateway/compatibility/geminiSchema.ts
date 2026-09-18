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

const POST_SANITIZERS: Array<(out: Record<string, any>) => void> = [
  sanitizeGeminiEnum,
  sanitizeGeminiStringFormat,
];

function liftConstToEnum(schema: Record<string, any>): Record<string, any> {
  if (schema.const !== undefined && schema.enum === undefined) {
    return { ...schema, enum: [schema.const] };
  }
  return schema;
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
