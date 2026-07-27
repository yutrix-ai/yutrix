import { db } from "./src/db";
import { providerApiKeys, providers } from "./src/db/schema";
import { decryptText } from "./src/utils/crypto";

async function run() {
  const allProviders = await db.select().from(providers);
  const provMap = new Map();
  for (const p of allProviders) provMap.set(p.id, p.name);

  const keys = await db.select().from(providerApiKeys);
  for (const k of keys) {
    let dec = "ERROR";
    try { dec = decryptText(k.keyEncrypted); } catch(e) {}
    console.log(`Key ID: ${k.id}, Provider: ${provMap.get(k.providerId)}, Status: ${k.status}, LastUsed: ${k.lastUsedAt}`);
    console.log(`Decrypted: ${dec.substring(0, 10)}...${dec.substring(dec.length-4)}`);
  }
}
run();
