import { LogicalType } from "../catalog";
import { ReflectedColumn } from "./reflect";

/**
 * Decodes a raw SQLite column value into its canonical logical JS representation.
 */
export function decodeValue(val: any, logicalType: LogicalType): any {
  if (val === null || val === undefined) {
    return null;
  }

  switch (logicalType) {
    case "bool": {
      if (typeof val === "boolean") return val;
      if (val === 1 || val === "1" || val === "true") return true;
      if (val === 0 || val === "0" || val === "false") return false;
      return Boolean(val);
    }

    case "unix_seconds": {
      if (val instanceof Date) {
        return Math.floor(val.getTime() / 1000);
      }
      const num = Number(val);
      if (Number.isNaN(num)) return null;
      // Handle timestamp stored in milliseconds vs seconds
      if (num > 10_000_000_000) {
        return Math.floor(num / 1000);
      }
      return Math.floor(num);
    }

    case "json_text": {
      // Must not parse JSON; preserve exact string representation
      if (typeof val === "string") return val;
      if (typeof val === "object") return JSON.stringify(val);
      return String(val);
    }

    case "int": {
      const num = Number(val);
      return Number.isNaN(num) ? null : Math.floor(num);
    }

    case "real": {
      const num = Number(val);
      return Number.isNaN(num) ? null : num;
    }

    case "text":
    default: {
      return typeof val === "string" ? val : String(val);
    }
  }
}

/**
 * Encodes a canonical logical JS representation into PostgreSQL target values.
 */
export function encodeValue(val: any, logicalType: LogicalType): any {
  if (val === null || val === undefined) {
    return null;
  }

  switch (logicalType) {
    case "bool":
      return Boolean(val);

    case "unix_seconds": {
      // Node-pg handles number for bigint mode: number
      const num = Number(val);
      return Number.isNaN(num) ? null : Math.floor(num);
    }

    case "json_text":
      // Raw string for text column in Postgres
      return typeof val === "string" ? val : JSON.stringify(val);

    case "int": {
      const num = Number(val);
      return Number.isNaN(num) ? null : Math.floor(num);
    }

    case "real": {
      const num = Number(val);
      return Number.isNaN(num) ? null : num;
    }

    case "text":
    default:
      return typeof val === "string" ? val : String(val);
  }
}

/**
 * Transforms a raw row from SQLite into a typed row for PostgreSQL.
 */
export function transformRow(
  rawRow: Record<string, any>,
  columns: ReflectedColumn[]
): Record<string, any> {
  const transformed: Record<string, any> = {};

  for (const col of columns) {
    // rawRow might have keys by column name (snake_case) or property name (camelCase)
    const rawVal = rawRow[col.name] !== undefined ? rawRow[col.name] : rawRow[col.propName];
    const decoded = decodeValue(rawVal, col.logicalType);
    transformed[col.name] = encodeValue(decoded, col.logicalType);
  }

  return transformed;
}
