import { db } from "./src/db";
import { providerApiKeys } from "./src/db/schema";
import { eq } from "drizzle-orm";

async function run() {
  const keys = await db.select().from(providerApiKeys).limit(1);
  const keyId = keys[0].id;
  console.log("Found key:", keyId);
  console.log("Old lastUsedAt:", keys[0].lastUsedAt);

  // NO AWAIT HERE
  db.update(providerApiKeys)
    .set({ lastUsedAt: new Date(Date.now() + 1000000) })
    .where(eq(providerApiKeys.id, keyId))
    .execute()
    .catch(e => console.error(e));

  console.log("Triggered update without await.");
  
  // Wait a bit to let the promise resolve
  await new Promise(r => setTimeout(r, 2000));
  
  const keysAfter = await db.select().from(providerApiKeys).where(eq(providerApiKeys.id, keyId));
  console.log("New lastUsedAt:", keysAfter[0].lastUsedAt);
  process.exit(0);
}
run();
