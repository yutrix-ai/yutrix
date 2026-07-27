import dotenv from "dotenv";
dotenv.config({ path: "../../.env" });

import { db } from "../src/db";
import { providers, providerModels, endpoints, endpointRoutes, subdomains, apiKeys } from "../src/db/schema";
import { eq } from "drizzle-orm";
import crypto from "crypto";
import { encryptText } from "../src/utils/crypto";

async function main() {
  await db.delete(providers).where(eq(providers.id, "test"));
  await db.delete(providers).where(eq(providers.id, "羊毛"));

  await db.insert(providers).values([
    { id: "test", name: "test", concurrencyLimit: 2, timeoutMs: 60000, maxOutputTokens: 0, enabled: true, createdAt: new Date(), updatedAt: new Date(), openaiBaseUrl: "http://httpbin.org/delay/2", openaiApiKeyEncrypted: encryptText("sk-dummy") },
    { id: "羊毛", name: "羊毛", concurrencyLimit: 10, timeoutMs: 60000, maxOutputTokens: 0, enabled: true, createdAt: new Date(), updatedAt: new Date(), openaiBaseUrl: "http://httpbin.org/delay/0", openaiApiKeyEncrypted: encryptText("sk-dummy") }
  ]);

  await db.delete(providerModels).where(eq(providerModels.providerId, "test"));
  await db.delete(providerModels).where(eq(providerModels.providerId, "羊毛"));
  await db.insert(providerModels).values([
    { id: "pm1", providerId: "test", protocol: "openai", modelId: "qwen3.7-max", displayName: "Qwen 3.7 Max", enabled: true, createdAt: new Date() },
    { id: "pm2", providerId: "羊毛", protocol: "openai", modelId: "glm-5", displayName: "GLM-5", enabled: true, createdAt: new Date() }
  ]);

  await db.delete(endpoints).where(eq(endpoints.name, "code-backend"));
  await db.insert(endpoints).values({
    id: "ep1", userId: "d255c7b0-a0b5-402f-b4ce-9845ea34facd", name: "code-backend", path: "/v1/chat/completions",
    incomingProtocol: "openai", enabled: true, createdAt: new Date(), updatedAt: new Date()
  });

  await db.delete(endpointRoutes).where(eq(endpointRoutes.endpointId, "ep1"));
  await db.insert(endpointRoutes).values({
    id: "er1", endpointId: "ep1", providerId: "test", providerProtocol: "openai", modelId: "qwen3.7-max",
    fallbackEnabled: true, fallbackProviderId: "羊毛", fallbackProviderProtocol: "openai", fallbackModelId: "glm-5",
    subdomainId: "sd1", enabled: true, createdAt: new Date(), updatedAt: new Date()
  });

  await db.delete(subdomains).where(eq(subdomains.name, "code-backend"));
  await db.insert(subdomains).values({
    id: "sd1", userId: "d255c7b0-a0b5-402f-b4ce-9845ea34facd", name: "code-backend", hostname: "code-backend.localhost",
    enabled: true, createdAt: new Date(), updatedAt: new Date()
  });

  const rawKey = "pg_testkey123";
  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
  await db.delete(apiKeys).where(eq(apiKeys.name, "test-key"));
  await db.insert(apiKeys).values({
    id: "ak1", userId: "d255c7b0-a0b5-402f-b4ce-9845ea34facd", name: "test-key", keyHash, keyPrefix: "pg_test",
    status: "active", concurrencyLimit: 10, createdAt: new Date()
  });

  console.log("Setup complete. API Key:", rawKey);
  process.exit(0);
}
main().catch(console.error);
