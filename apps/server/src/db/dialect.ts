import { sql, SQL } from "drizzle-orm";
import { DbDriver } from "./config";

/**
 * dialect.ts — Driver-agnostic SQL expression builders.
 * Per PRD §7.2:
 * Raw strings like `datetime('now')`, `date(createdAt)`, `json_extract`,
 * and engine-specific functions must be centralized here.
 */

let defaultDriver: DbDriver = "sqlite";

export function setDefaultDialectDriver(driver: DbDriver) {
  defaultDriver = driver;
}

export function getDefaultDialectDriver(): DbDriver {
  return defaultDriver;
}

/**
 * Returns SQL expression for current unix timestamp in seconds.
 * SQLite: strftime('%s', 'now')
 * Postgres: (extract(epoch from now())::bigint)
 */
export function nowExpr(driver: DbDriver = defaultDriver): SQL {
  return driver === "postgres"
    ? sql`(extract(epoch from now())::bigint)`
    : sql`strftime('%s', 'now')`;
}

/**
 * Converts a unix epoch timestamp (in seconds) to a database timestamp / datetime.
 * SQLite: datetime(col, 'unixepoch')
 * Postgres: to_timestamp(col)
 */
export function fromUnix(columnOrExpr: any, driver: DbDriver = defaultDriver): SQL {
  return driver === "postgres"
    ? sql`to_timestamp(${columnOrExpr})`
    : sql`datetime(${columnOrExpr}, 'unixepoch')`;
}

/**
 * Formats a unix epoch timestamp (in seconds) as a daily bucket 'YYYY-MM-DD'.
 * Produces identical string shape on both SQLite and PostgreSQL.
 * SQLite: date(col, 'unixepoch')
 * Postgres: to_char(to_timestamp(col), 'YYYY-MM-DD')
 */
export function dateBucket(columnOrExpr: any, driver: DbDriver = defaultDriver): SQL {
  return driver === "postgres"
    ? sql`to_char(to_timestamp(${columnOrExpr}), 'YYYY-MM-DD')`
    : sql`date(${columnOrExpr}, 'unixepoch')`;
}

/**
 * Extracts a value from a JSON string column.
 * SQLite: json_extract(col, '$.path')
 * Postgres: (col::json->>'path')
 */
export function jsonExtract(
  columnOrExpr: any,
  jsonPath: string,
  driver: DbDriver = defaultDriver
): SQL {
  if (driver === "postgres") {
    const cleanPath = jsonPath.replace(/^\$\./, "");
    return sql`(${columnOrExpr}::json->>${cleanPath})`;
  }
  const formattedPath = jsonPath.startsWith("$.") ? jsonPath : `$.${jsonPath}`;
  return sql`json_extract(${columnOrExpr}, ${formattedPath})`;
}

/**
 * Safely quotes a SQL identifier (table or column name).
 * Both SQLite and PostgreSQL use standard double quotes.
 */
export function ident(identifier: string, _driver: DbDriver = defaultDriver): SQL {
  const escaped = identifier.replace(/"/g, '""');
  return sql.raw(`"${escaped}"`);
}
