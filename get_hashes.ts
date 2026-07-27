import { db } from "./apps/server/src/db";
import { migrate } from "drizzle-orm/libsql/migrator";
import { sql } from "drizzle-orm";

async function run() {
  await migrate(db, { migrationsFolder: "./apps/server/drizzle" });
  const result = await db.run(sql`SELECT * FROM __drizzle_migrations`);
  console.log(JSON.stringify(result.rows, null, 2));
}
run().catch(console.error);
