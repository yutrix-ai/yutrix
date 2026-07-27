import Database from "better-sqlite3";
import crypto from "crypto";

const db = new Database("data/promptgate.sqlite");

// 1. Setup Providers
db.prepare("DELETE FROM providers WHERE id IN ('test', '羊毛')").run();
db.prepare("INSERT INTO providers (id, name, concurrencyLimit, timeoutMs, maxOutputTokens, enabled, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
  "test", "test", 2, 60000, 0, 1, Date.now(), Date.now()
);
db.prepare("INSERT INTO providers (id, name, concurrencyLimit, timeoutMs, maxOutputTokens, enabled, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
  "羊毛", "羊毛", 10, 60000, 0, 1, Date.now(), Date.now()
);

// 2. Setup Provider Models
db.prepare("DELETE FROM provider_models WHERE providerId IN ('test', '羊毛')").run();
db.prepare("INSERT INTO provider_models (id, providerId, protocol, modelId, displayName, enabled, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
  "pm1", "test", "openai", "qwen3.7-max", "Qwen 3.7 Max", 1, Date.now()
);
db.prepare("INSERT INTO provider_models (id, providerId, protocol, modelId, displayName, enabled, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
  "pm2", "羊毛", "openai", "glm-5", "GLM-5", 1, Date.now()
);

// 3. Setup Endpoint (Route)
db.prepare("DELETE FROM endpoints WHERE name = 'code-backend'").run();
db.prepare(`
  INSERT INTO endpoints (
    id, userId, name, path, incomingProtocol, providerId, providerProtocol, modelId,
    fallbackEnabled, fallbackProviderId, fallbackProviderProtocol, fallbackModelId,
    timeoutMs, queueTimeoutMs, maxBodyMb, enabled, createdAt, updatedAt
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(
  "ep1", "d255c7b0-a0b5-402f-b4ce-9845ea34facd", "code-backend", "/v1/chat/completions", "openai", "test", "openai", "qwen3.7-max",
  1, "羊毛", "openai", "glm-5",
  0, 0, 0, 1, Date.now(), Date.now()
);

// 4. Setup Subdomain (Host)
db.prepare("DELETE FROM subdomains WHERE name = 'code-backend'").run();
db.prepare("INSERT INTO subdomains (id, userId, name, hostname, enabled, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
  "sd1", "d255c7b0-a0b5-402f-b4ce-9845ea34facd", "code-backend", "code-backend.localhost", 1, Date.now(), Date.now()
);

// 5. Setup API Key
const rawKey = "pg_testkey123";
const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
db.prepare("DELETE FROM api_keys WHERE name = 'test-key'").run();
db.prepare("INSERT INTO api_keys (id, userId, name, keyHash, keyPrefix, status, concurrencyLimit, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
  "ak1", "d255c7b0-a0b5-402f-b4ce-9845ea34facd", "test-key", keyHash, "pg_test", "active", 10, Date.now()
);

console.log("Setup complete. API Key:", rawKey);
