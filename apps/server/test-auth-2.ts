import { db } from "./src/db";
import { apiKeys } from "./src/db/schema";
import crypto from "crypto";

async function run() {
  const keys = await db.select().from(apiKeys);
  const providedKey = "pg_5310bc40f11dbf2c37cfa3ff585775df633d5a6034ef734b";
  const targetHash = crypto.createHash("sha256").update(providedKey).digest("hex");
  
  const match = keys.find(k => k.keyHash === targetHash);
  console.log("Found via JS array find?", !!match);
  if (match) {
    console.log("Matched ID:", match.id);
  } else {
    console.log("Target hash:", targetHash);
    console.log("Some hashes in DB:", keys.map(k => k.keyHash).slice(0, 3));
  }
  process.exit(0);
}
run();
