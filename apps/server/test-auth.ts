import { db } from "./src/db";
import { apiKeys } from "./src/db/schema";
import { eq } from "drizzle-orm";
import crypto from "crypto";

async function run() {
  const providedKey = "pg_5310bc40f11dbf2c37cfa3ff585775df633d5a6034ef734b";
  const keyHash = crypto.createHash("sha256").update(providedKey).digest("hex");
  console.log("Hash:", keyHash);

  const keys = await db.select().from(apiKeys).where(eq(apiKeys.keyHash, keyHash));
  console.log("Keys found:", keys.length);
  if (keys.length > 0) {
    console.log("Status:", keys[0].status);
  }
  process.exit(0);
}
run();
