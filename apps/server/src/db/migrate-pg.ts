import path from "path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

/**
 * Runs Drizzle PostgreSQL migrations from apps/server/drizzle/pg.
 */
export async function migratePg(
  pgDb: NodePgDatabase<any>,
  options?: { migrationsFolder?: string }
): Promise<void> {
  const migrationsFolder =
    options?.migrationsFolder ||
    path.resolve(
      process.cwd(),
      process.cwd().endsWith("server") ? "./drizzle/pg" : "apps/server/drizzle/pg"
    );

  await migrate(pgDb, { migrationsFolder });
}
