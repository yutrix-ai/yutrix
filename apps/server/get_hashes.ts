import { migrate } from "drizzle-orm/libsql/migrator";
import { drizzle } from "drizzle-orm/libsql";
import { createClient } from "@libsql/client";
import { sql } from "drizzle-orm";

const client = createClient({ url: "file:./test_db.sqlite" });
const db = drizzle(client);

async function run() {
  await migrate(db, { migrationsFolder: "./drizzle" });
  const result = await db.run(sql`SELECT * FROM __drizzle_migrations`);
  console.log(JSON.stringify(result.rows, null, 2));
}
run().catch(console.error);
