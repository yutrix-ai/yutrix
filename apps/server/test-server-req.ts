import { db } from "./src/db";
import { providerApiKeys } from "./src/db/schema";
import { eq } from "drizzle-orm";

async function run() {
  const keys = await db.select().from(providerApiKeys).limit(1);
  const keyId = keys[0].id;
  console.log("Old lastUsedAt:", keys[0].lastUsedAt);

  // Send request to trigger the exact code in gatewayExecutor.ts
  const res = await fetch("http://127.0.0.1:3001/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer TEST" },
    body: JSON.stringify({ model: "qwen3.7-plus", messages: [{role:"user", content:"test"}] })
  });
  console.log("Status:", res.status);

  // Wait a bit
  await new Promise(r => setTimeout(r, 2000));
  
  const keysAfter = await db.select().from(providerApiKeys).where(eq(providerApiKeys.id, keyId));
  console.log("New lastUsedAt:", keysAfter[0].lastUsedAt);
  process.exit(0);
}
run();
