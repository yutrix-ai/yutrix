import { describe, it, expect } from "vitest";
import { isTable, getTableName, getTableColumns } from "drizzle-orm";
import * as sqliteSchema from "../src/db/schema.sqlite";
import * as pgSchema from "../src/db/schema.pg";
import * as legacySchema from "../src/db/schema";
import { CATALOG, getAllCatalogTables, getCatalogTable, LogicalType } from "../src/db/catalog";

const VALID_LOGICAL_TYPES: Set<LogicalType> = new Set([
  "text",
  "int",
  "real",
  "bool",
  "unix_seconds",
  "json_text",
]);

describe("Slice P0-2: Schema Symmetry & Catalog Verification", () => {
  const sqliteTables = Object.values(sqliteSchema).filter(isTable);
  const pgTables = Object.values(pgSchema).filter(isTable);

  it("1. equal table name sets between SQLite, PG, and Catalog", () => {
    const sqliteTableNames = new Set(sqliteTables.map((t) => getTableName(t)));
    const pgTableNames = new Set(pgTables.map((t) => getTableName(t)));
    const catalogTableNames = new Set(Object.keys(CATALOG));

    expect(sqliteTableNames.size).toBeGreaterThanOrEqual(28);
    expect(pgTableNames).toEqual(sqliteTableNames);
    expect(catalogTableNames).toEqual(sqliteTableNames);
  });

  it("2. equal column name sets and property keys per table", () => {
    for (const sTable of sqliteTables) {
      const tableName = getTableName(sTable);
      const pTable = pgTables.find((t) => getTableName(t) === tableName);
      expect(pTable, `Missing PG table for ${tableName}`).toBeDefined();

      const sCols = getTableColumns(sTable);
      const pCols = getTableColumns(pTable!);

      const sColNames = Object.values(sCols).map((c) => c.name).sort();
      const pColNames = Object.values(pCols).map((c) => c.name).sort();
      expect(pColNames, `DB column names mismatch in table ${tableName}`).toEqual(sColNames);

      const sPropKeys = Object.keys(sCols).sort();
      const pPropKeys = Object.keys(pCols).sort();
      expect(pPropKeys, `JS property keys mismatch in table ${tableName}`).toEqual(sPropKeys);
    }
  });

  it("3. every column has a valid logicalType in catalog.ts", () => {
    const allTables = getAllCatalogTables();
    expect(allTables.length).toBe(sqliteTables.length);

    for (const table of allTables) {
      const catTable = getCatalogTable(table.tableName);
      expect(catTable).toBeDefined();

      const pTable = pgTables.find((t) => getTableName(t) === table.tableName)!;
      const pCols = getTableColumns(pTable);

      for (const [propName, colObj] of Object.entries(pCols)) {
        const colMeta = catTable!.columns[colObj.name];
        expect(colMeta, `Column ${colObj.name} in table ${table.tableName} must exist in catalog`).toBeDefined();
        expect(
          VALID_LOGICAL_TYPES.has(colMeta.logicalType),
          `Column ${colObj.name} in table ${table.tableName} has invalid logicalType: ${colMeta.logicalType}`
        ).toBe(true);
        expect(colMeta.propName).toBe(propName);
      }
    }
  });

  it("4. PG column types strictly match PRD section 8 rules", () => {
    for (const pTable of pgTables) {
      const tableName = getTableName(pTable);
      const catTable = CATALOG[tableName]!;
      const pCols = getTableColumns(pTable);

      for (const colObj of Object.values(pCols)) {
        const colMeta = catTable.columns[colObj.name];
        const pgColType = (colObj as any).columnType;

        switch (colMeta.logicalType) {
          case "text":
          case "json_text":
            expect(pgColType, `${tableName}.${colObj.name} must be PgText`).toBe("PgText");
            break;
          case "int":
            expect(pgColType, `${tableName}.${colObj.name} must be PgInteger`).toBe("PgInteger");
            break;
          case "real":
            expect(pgColType, `${tableName}.${colObj.name} must be PgDoublePrecision`).toBe("PgDoublePrecision");
            break;
          case "bool":
            expect(pgColType, `${tableName}.${colObj.name} must be PgBoolean`).toBe("PgBoolean");
            break;
          case "unix_seconds":
            expect(pgColType, `${tableName}.${colObj.name} must be PgBigInt53 (bigint with mode number)`).toBe(
              "PgBigInt53"
            );
            break;
        }
      }
    }
  });

  it("5. prohibits timestamptz, jsonb, and serial types across all PG tables", () => {
    for (const pTable of pgTables) {
      const tableName = getTableName(pTable);
      const pCols = getTableColumns(pTable);

      for (const colObj of Object.values(pCols)) {
        const typeStr = String((colObj as any).columnType || "").toLowerCase();

        expect(typeStr).not.toContain("timestamptz");
        expect(typeStr).not.toContain("timestamp");
        expect(typeStr).not.toContain("jsonb");
        expect(typeStr).not.toContain("serial");

        // Primary key must remain text UUID per PRD §8
        if ((colObj as any).primary) {
          expect((colObj as any).columnType, `Primary key of ${tableName} must be PgText`).toBe("PgText");
        }
      }
    }
  });

  it("6. schema.ts backwards-compatibility export includes all SQLite tables", () => {
    const legacyTables = Object.values(legacySchema).filter(isTable);
    const legacyNames = new Set(legacyTables.map((t) => getTableName(t)));
    const sqliteNames = new Set(sqliteTables.map((t) => getTableName(t)));

    expect(legacyNames).toEqual(sqliteNames);
  });
});
