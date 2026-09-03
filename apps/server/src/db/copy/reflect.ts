import { getTableColumns, getTableName, isTable } from "drizzle-orm";
import * as sqliteSchema from "../schema.sqlite";
import * as pgSchema from "../schema.pg";
import { CATALOG, LogicalType } from "../catalog";

export interface ReflectedColumn {
  name: string; // Database column name
  propName: string; // Schema property name
  logicalType: LogicalType;
}

export interface ReflectedTable {
  name: string; // DB table name (e.g. "users")
  exportName: string;
  sqliteTable: any;
  pgTable: any;
  columns: ReflectedColumn[];
  columnNames: string[];
  primaryKeyColumn: string;
}

const INTERNAL_TABLE_PREFIXES = ["sqlite_", "__drizzle_", "__new_"];

function isInternalTable(name: string): boolean {
  return INTERNAL_TABLE_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function tablesOf(mod: Record<string, any>): Map<string, { table: any; exportName: string }> {
  const map = new Map<string, { table: any; exportName: string }>();
  for (const [exportName, val] of Object.entries(mod)) {
    if (isTable(val)) {
      const tableName = getTableName(val);
      map.set(tableName, { table: val, exportName });
    }
  }
  return map;
}

/**
 * Reflects tables across schema.sqlite and schema.pg.
 * Intersects column names, maps logical types from CATALOG, and identifies primary keys.
 */
export function getReflectedTables(): ReflectedTable[] {
  const sqliteTables = tablesOf(sqliteSchema);
  const pgTables = tablesOf(pgSchema);

  const reflected: ReflectedTable[] = [];

  for (const [tableName, { table: sqliteTable, exportName }] of sqliteTables.entries()) {
    if (isInternalTable(tableName)) {
      continue;
    }

    const pgEntry = pgTables.get(tableName);
    if (!pgEntry) {
      console.warn(`[Copy/Reflect] Table "${tableName}" found in SQLite but missing in PostgreSQL schema. Skipping.`);
      continue;
    }

    const pgTable = pgEntry.table;
    const sqliteColumns = getTableColumns(sqliteTable);
    const pgColumns = getTableColumns(pgTable);

    // Build map: db column name -> property name & column object
    const sqliteColMap = new Map<string, { propName: string; col: any }>();
    for (const [prop, col] of Object.entries(sqliteColumns)) {
      sqliteColMap.set((col as any).name, { propName: prop, col });
    }

    const pgColMap = new Map<string, { propName: string; col: any }>();
    for (const [prop, col] of Object.entries(pgColumns)) {
      pgColMap.set((col as any).name, { propName: prop, col });
    }

    // Intersect column names
    const commonColumns: ReflectedColumn[] = [];
    const columnNames: string[] = [];
    const catalogTable = CATALOG[tableName];

    for (const [colName, { propName }] of sqliteColMap.entries()) {
      if (pgColMap.has(colName)) {
        columnNames.push(colName);
        const catalogCol = catalogTable?.columns[colName];
        const logicalType: LogicalType = catalogCol?.logicalType || "text";

        commonColumns.push({
          name: colName,
          propName,
          logicalType,
        });
      } else {
        console.warn(`[Copy/Reflect] Table "${tableName}": Column "${colName}" present in SQLite but not in Postgres. Skipping.`);
      }
    }

    // Determine primary key column
    let pkCol = "id";
    if (tableName === "system_settings") {
      pkCol = "key";
    } else {
      const declaredPk = commonColumns.find((c) => {
        const catalogCol = catalogTable?.columns[c.name];
        return catalogCol?.primaryKey === true;
      });
      if (declaredPk) {
        pkCol = declaredPk.name;
      }
    }

    reflected.push({
      name: tableName,
      exportName,
      sqliteTable,
      pgTable,
      columns: commonColumns,
      columnNames,
      primaryKeyColumn: pkCol,
    });
  }

  return reflected;
}
