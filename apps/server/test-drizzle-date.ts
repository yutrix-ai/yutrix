import { db } from "./src/db";
import { providerApiKeys } from "./src/db/schema";
import { eq } from "drizzle-orm";

async function run() {
  try {
    const keys = await db.select().from(providerApiKeys).limit(1);
    if (keys.length === 0) {
      console.log("No keys found.");
      process.exit(1);
    }
    const keyId = keys[0].id;
    console.log("Found key:", keyId);
    console.log("Old lastUsedAt:", keys[0].lastUsedAt);

    await db.update(providerApiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(providerApiKeys.id, keyId))
      .execute();
      
    console.log("Updated lastUsedAt to new Date()");
    
    const keysAfter = await db.select().from(providerApiKeys).where(eq(providerApiKeys.id, keyId));
    console.log("New lastUsedAt:", keysAfter[0].lastUsedAt);
  } catch (e) {
    console.error("Error:", e);
  }
}
run();
