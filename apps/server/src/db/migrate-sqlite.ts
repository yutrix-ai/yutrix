import path from "path";
import { migrate } from "drizzle-orm/libsql/migrator";
import type { LibSQLDatabase } from "drizzle-orm/libsql";

/**
 * Runs Drizzle SQLite migrations from apps/server/drizzle.
 */
export async function migrateSqlite(
  sqliteDb: LibSQLDatabase<any>,
  options?: { migrationsFolder?: string }
): Promise<void> {
  const migrationsFolder =
    options?.migrationsFolder ||
    path.resolve(
      process.cwd(),
      process.cwd().endsWith("server") ? "./drizzle" : "apps/server/drizzle"
    );

  await migrate(sqliteDb, { migrationsFolder });
}
