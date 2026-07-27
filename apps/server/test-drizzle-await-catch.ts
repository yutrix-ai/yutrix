import { db } from "./src/db";
import { providerApiKeys } from "./src/db/schema";
import { eq } from "drizzle-orm";

async function run() {
  const keys = await db.select().from(providerApiKeys).limit(1);
  const keyId = keys[0].id;
  console.log("Old lastUsedAt:", keys[0].lastUsedAt);

  // AWAIT AND CATCH ONLY (Old production code)
  await db.update(providerApiKeys)
    .set({ lastUsedAt: new Date(Date.now() + 1000000) })
    .where(eq(providerApiKeys.id, keyId))
    .catch(e => console.error(e));

  const keysAfter = await db.select().from(providerApiKeys).where(eq(providerApiKeys.id, keyId));
  console.log("New lastUsedAt:", keysAfter[0].lastUsedAt);
  process.exit(0);
}
run();
