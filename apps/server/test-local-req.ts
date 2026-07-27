import { db } from "./src/db";
import { apiKeys, routes } from "./src/db/schema";
async function run() {
  const k = await db.select().from(apiKeys).limit(1);
  const r = await db.select().from(routes).limit(1);
  console.log("Key:", k[0].key);
  console.log("Route host:", r[0].host, "path:", r[0].path);
}
run();
