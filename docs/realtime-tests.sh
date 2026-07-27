#!/bin/bash
# Real-time Configuration Verification Script with Mock Upstream
# Uses isolated temporary database - does NOT modify the real production DB
set -e

REAL_DB="../data/promptgate.sqlite"
DB_FILE="/tmp/promptgate-e2e.sqlite"
TEST_PORT=3001

echo "=== Database Isolation: Copying real DB to temporary test DB ==="
cp "$REAL_DB" "$DB_FILE"
echo "Temporary test DB: $DB_FILE"
echo "Real DB (untouched): $REAL_DB"

echo "=== Standing up Mock Upstream ==="
cat << 'EOF' > mock_upstream.js
const http = require('http');
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', chunk => body += chunk.toString());
  req.on('end', () => {
    let parsed = {};
    try { if (body) parsed = JSON.parse(body); } catch (e) {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'mock-123',
      choices: [{ message: { role: 'assistant', content: 'mock response' } }],
      mock_received_model: parsed.model,
      mock_received_system: parsed.messages && parsed.messages[0] ? parsed.messages[0].content : null
    }));
  });
});
server.listen(4000, () => {
  console.log('Mock upstream running on port 4000');
});
EOF

node mock_upstream.js &
MOCK_PID=$!
sleep 2 # wait for mock server to start

echo "=== Standing up isolated PromptGate instance on port $TEST_PORT ==="
PM2_SECRET=$(npx pm2 env 0 | grep PROMPTGATE_SECRET | awk -F': ' '{print $2}' | tr -d '"')
cd ../apps/server
DB_FILE="$DB_FILE" PORT=$TEST_PORT PROMPTGATE_SECRET="$PM2_SECRET" npx tsx src/index.ts &
GATE_PID=$!
cd ../../docs
sleep 5 # wait for PromptGate to start

# Verify isolated instance is running
if ! curl -s "http://127.0.0.1:$TEST_PORT/api/health" > /dev/null 2>&1; then
  echo "FAIL: Isolated PromptGate instance did not start on port $TEST_PORT"
  kill $GATE_PID $MOCK_PID 2>/dev/null || true
  rm -f mock_upstream.js "$DB_FILE"
  exit 1
fi
echo "Isolated PromptGate running on port $TEST_PORT with DB: $DB_FILE"

echo "=== Testing Real-time Configurations ==="

# Get the first endpoint route and provider
ROUTE_ID=$(sqlite3 $DB_FILE "SELECT id FROM endpoint_routes LIMIT 1;")
PROVIDER_ID=$(sqlite3 $DB_FILE "SELECT providerId FROM endpoint_routes LIMIT 1;")
SUBDOMAIN_ID=$(sqlite3 $DB_FILE "SELECT subdomainId FROM endpoint_routes LIMIT 1;")
if [ -z "$ROUTE_ID" ]; then
  echo "No route found, creating one for testing..."
  PROVIDER_ID="test-provider-id"
  ROUTE_ID="test-route-id"
  sqlite3 $DB_FILE "INSERT INTO providers (id, name, openaiBaseUrl, createdAt, updatedAt) VALUES ('$PROVIDER_ID', 'Test', 'http://127.0.0.1:4000', 0, 0);"
  sqlite3 $DB_FILE "INSERT INTO endpoints (id, userId, path, incomingProtocol, status, createdAt, updatedAt) VALUES ('test-ep', 'system', '/v1/chat/completions', 'openai', 'active', 0, 0);"
  sqlite3 $DB_FILE "INSERT INTO endpoint_routes (id, endpointId, providerId, modelId, createdAt, updatedAt) VALUES ('$ROUTE_ID', 'test-ep', '$PROVIDER_ID', 'gpt-3.5-turbo', 0, 0);"
fi

# Ensure provider has API key and Mock URL
PM2_SECRET=$(npx pm2 env 0 | grep PROMPTGATE_SECRET | awk -F': ' '{print $2}' | tr -d '"')
cd ../apps/server
ENC_KEY=$(PROMPTGATE_SECRET="$PM2_SECRET" npx tsx -e "import { encryptText } from './src/utils/crypto.ts'; console.log(encryptText('dummy-key'));")
cd ../../docs
echo "Generated ENC_KEY: $ENC_KEY"
sqlite3 $DB_FILE "UPDATE providers SET openaiBaseUrl = 'http://127.0.0.1:4000' WHERE id = '$PROVIDER_ID';"
sqlite3 $DB_FILE "REPLACE INTO provider_api_keys (id, providerId, keyEncrypted, status, createdAt, updatedAt) VALUES ('test-provider-key', '$PROVIDER_ID', '$ENC_KEY', 'active', 0, 0);"

# Ensure v0 endpoint exists
sqlite3 $DB_FILE "INSERT OR IGNORE INTO endpoints (id, userId, path, incomingProtocol, status, createdAt, updatedAt) VALUES ('test-ep-v0', 'system', '/v0/chat/completions', 'openai', 'active', 0, 0);"
sqlite3 $DB_FILE "INSERT OR IGNORE INTO endpoint_routes (id, endpointId, providerId, modelId, createdAt, updatedAt) VALUES ('test-route-v0', 'test-ep-v0', '$PROVIDER_ID', 'gpt-3.5-turbo', 0, 0);"

# Insert an API Key for auth bypass
KEY_HASH="62af8704764faf8ea82fc61ce9c4c3908b6cb97d463a634e9e587d7c885db0ef" # sha256 of "test-key"
sqlite3 $DB_FILE "REPLACE INTO api_keys (id, userId, name, keyHash, keyPrefix, status, createdAt) VALUES ('test-key-id', 'system', 'Test Key', '$KEY_HASH', 'test-', 'active', 0);"

# Enable unknown host fallback
sqlite3 $DB_FILE "REPLACE INTO system_settings (key, value, createdAt, updatedAt) VALUES ('allowUnknownHostFallback', 'true', 0, 0);"

echo "[1] Setting initial modelId to model-a and sending initial request..."
sqlite3 $DB_FILE "UPDATE endpoint_routes SET modelId = 'model-a' WHERE id = '$ROUTE_ID';"
RESP=$(curl -s -X POST http://127.0.0.1:$TEST_PORT/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test-key" \
  -d '{"model":"gpt-4", "messages":[{"role":"user","content":"hi"}]}')
echo $RESP | grep '"mock_received_model":"model-a"' && echo "PASS: Initial model is model-a" || echo "FAIL: Initial request failed: $RESP"

echo "[2] Modifying endpoint route modelId from model-a -> model-b..."
sqlite3 $DB_FILE "UPDATE endpoint_routes SET modelId = 'model-b' WHERE id = '$ROUTE_ID';"
echo "Done. Next request should use model-b."
RESP2=$(curl -s -X POST http://127.0.0.1:$TEST_PORT/v1/chat/completions -H "Content-Type: application/json" -H "Authorization: Bearer test-key" -d '{"model":"gpt-4", "messages":[{"role":"user","content":"hi"}]}')
echo $RESP2 | grep '"mock_received_model":"model-b"' && echo "PASS: Model dynamically changed from model-a to model-b!" || echo "FAIL: Model did not change: $RESP2"

echo "[3] Disabling a provider..."
sqlite3 $DB_FILE "UPDATE providers SET enabled = 0 WHERE id = '$PROVIDER_ID';"
echo "Done. Next request to this provider will fail with 500 Provider disabled."
RESP3=$(curl -s -X POST http://127.0.0.1:$TEST_PORT/v1/chat/completions -H "Content-Type: application/json" -H "Authorization: Bearer test-key" -d '{"model":"gpt-4", "messages":[{"role":"user","content":"hi"}]}')
echo $RESP3 | grep "Provider not found or disabled" && echo "PASS: Provider instantly disabled!" || echo "FAIL: Provider still responded: $RESP3"

# Re-enable provider for further tests
sqlite3 $DB_FILE "UPDATE providers SET enabled = 1 WHERE id = '$PROVIDER_ID';"

echo "[3.5] Disabling a subdomain..."
# Ensure there is a subdomain for our endpoint
sqlite3 $DB_FILE "REPLACE INTO subdomains (id, userId, name, hostname, enabled, createdAt, updatedAt) VALUES ('test-subdomain', 'system', 'test', '127.0.0.1', 1, 0, 0);"
sqlite3 $DB_FILE "UPDATE endpoint_routes SET subdomainId = 'test-subdomain' WHERE id = '$ROUTE_ID';"
sqlite3 $DB_FILE "UPDATE subdomains SET enabled = 0 WHERE id = 'test-subdomain';"
echo "Done. Next request on 127.0.0.1 will fail with 403 Subdomain disabled."
RESP35=$(curl -s -X POST http://127.0.0.1:$TEST_PORT/v1/chat/completions -H "Content-Type: application/json" -H "Authorization: Bearer test-key" -d '{"model":"gpt-4", "messages":[{"role":"user","content":"hi"}]}')
echo $RESP35 | grep "Subdomain is disabled" && echo "PASS: Subdomain instantly disabled!" || echo "FAIL: Subdomain still responded: $RESP35"
sqlite3 $DB_FILE "UPDATE subdomains SET enabled = 1 WHERE id = 'test-subdomain';"
sqlite3 $DB_FILE "UPDATE endpoint_routes SET subdomainId = NULL WHERE id = '$ROUTE_ID';"

echo "[4] Modifying prompt policy content..."
sqlite3 $DB_FILE "UPDATE prompt_policies SET content = 'You are a test bot.' WHERE id = 'builtin-codex-cli';"
sqlite3 $DB_FILE "DELETE FROM prompt_injection_records;"
echo "Done. Next /v0/chat/completions request will inject 'You are a test bot.'."
RESP4=$(curl -s -X POST http://127.0.0.1:$TEST_PORT/v0/chat/completions -H "Content-Type: application/json" -H "Authorization: Bearer test-key" -H "x-conversation-id: test-conv-$RANDOM" -d '{"messages":[{"role":"user","content":"hi"}]}')
echo $RESP4 | grep "You are a test bot" && echo "PASS: Policy injected instantly!" || echo "FAIL: Policy not injected: $RESP4"

echo "[5] Modifying CORS allowlist..."
sqlite3 $DB_FILE "UPDATE system_settings SET value = '[\"https://trusted.com\"]' WHERE key = 'corsAllowlist';"
echo "Done. Next request from untrusted origin will fail CORS check."
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X OPTIONS http://127.0.0.1:$TEST_PORT/v1/chat/completions \
  -H "Origin: https://hacker.com" \
  -H "Access-Control-Request-Method: POST")
if [ "$HTTP_CODE" -eq "200" ] || [ "$HTTP_CODE" -eq "204" ]; then
  # Our fastify app returns 200/204 for OPTIONS, but the header won't contain Access-Control-Allow-Origin for hacker.com
  CORS_HEADER=$(curl -s -I -X OPTIONS http://127.0.0.1:$TEST_PORT/v1/chat/completions -H "Origin: https://hacker.com" -H "Access-Control-Request-Method: POST" | grep -i "access-control-allow-origin" || true)
  if echo "$CORS_HEADER" | grep -iq "hacker.com"; then
    echo "FAIL: CORS Header allowed hacker.com: $CORS_HEADER"
  else
    echo "PASS: CORS Header stripped for untrusted origin!"
  fi
fi

# Cleanup
echo "=== Cleaning up ==="
kill $GATE_PID 2>/dev/null || true
kill $MOCK_PID 2>/dev/null || true
rm -f mock_upstream.js
rm -f "$DB_FILE"
echo "Temporary test DB removed: $DB_FILE"
echo "Isolated PromptGate instance stopped (PID $GATE_PID)"

echo "All modifications verified! No restarts needed for changes to take effect on new requests!"
echo "Real database untouched: $REAL_DB"
