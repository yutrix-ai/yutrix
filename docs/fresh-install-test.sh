#!/usr/bin/env bash
set -euo pipefail

echo "=== PromptGate Fresh Install Acceptance Test ==="

# 1. Setup Environment
DB_FILE="data/promptgate-fresh.sqlite"
export DB_FILE
export PORT=3010
export PROMPTGATE_SECRET="fresh_secret_for_testing"

MOCK_PORT=4010

echo "Removing old DB if exists..."
rm -f "$DB_FILE"
rm -f data/action.log

echo "Initializing DB..."

# 2. Start Services
echo "Starting Mock Upstream..."
cat > /tmp/mock_upstream.js <<'EOF'
const http = require('http');
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', chunk => { body += chunk.toString(); });
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    const parsedBody = body ? JSON.parse(body) : {};
    
    if (req.url === '/v1/models') {
      res.writeHead(200);
      res.end(JSON.stringify({ data: [{ id: 'model-a' }, { id: 'model-b' }] }));
    } else if (req.url === '/v1/chat/completions') {
      if (req.headers.authorization !== 'Bearer sk-mock-key') {
         res.writeHead(401);
         return res.end(JSON.stringify({ error: "unauthorized" }));
      }
      const firstMsg = parsedBody.messages && parsedBody.messages[0] ? parsedBody.messages[0].content : '';
      
      if (firstMsg === 'trigger-429' && parsedBody.stream && parsedBody.model === 'model-a') {
         res.writeHead(429);
         return res.end(JSON.stringify({ error: "rate limit" }));
      }
      if (firstMsg === 'trigger-503' && parsedBody.stream && parsedBody.model === 'model-a') {
         res.writeHead(503);
         return res.end(JSON.stringify({ error: "unavailable" }));
      }
      if (firstMsg === 'trigger-529' && parsedBody.stream && parsedBody.model === 'model-a') {
         res.writeHead(529);
         return res.end(JSON.stringify({ error: "overloaded" }));
      }
      if (firstMsg === 'trigger-stream-interrupt' && parsedBody.stream && parsedBody.model === 'model-a') {
         res.writeHead(200, { 'Content-Type': 'text/event-stream' });
         res.write('data: {"choices":[{"delta":{"content":"Start"}}]}\n\n');
         setTimeout(() => {
           res.destroy();
         }, 100);
         return;
      }

      if (parsedBody.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      } else {
        res.writeHead(200);
        res.end(JSON.stringify({ 
          choices: [{ message: { content: "Mock" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
          _mock_received_body: parsedBody,
          _mock_received_headers: req.headers
        }));
      }
    } else if (req.url === '/v1/messages') {
      if (req.headers['x-api-key'] !== 'sk-ant-key') {
         res.writeHead(401);
         return res.end(JSON.stringify({ error: "unauthorized" }));
      }
      res.writeHead(200);
      res.end(JSON.stringify({ 
        content: [{ text: "Anthropic Mock" }],
        _mock_received_body: parsedBody,
        _mock_received_headers: req.headers
      }));
    } else {
      res.writeHead(404);
      res.end('Not found: ' + req.url);
    }
  });
});
server.listen(4010, () => console.log('Mock upstream running on 4010'));
EOF

node /tmp/mock_upstream.js > /tmp/mock.log 2>&1 &
MOCK_PID=$!

echo "Starting PromptGate Server..."
node apps/server/dist/index.js > /tmp/pg.log 2>&1 &
PG_PID=$!

function cleanup {
  echo "Cleaning up..."
  kill -9 $PG_PID $MOCK_PID 2>/dev/null || true
}
trap cleanup EXIT

echo "Waiting for servers to start..."
sleep 5

# 3. Read admin password
ADMIN_PASS=$(grep "管理员密码:" /tmp/pg.log | awk '{print $2}' || true)
if [ -z "$ADMIN_PASS" ]; then
  echo "FAIL: Could not find admin password in logs"
  exit 1
fi
echo "PASS: bootstrap generated admin password has been captured"

# 4. Admin Login
BASE_URL="http://localhost:$PORT"
LOGIN_RES=$(curl -s -c /tmp/cookies.txt -X POST "$BASE_URL/api/auth/login" -H "Content-Type: application/json" -d "{\"username\":\"admin\",\"password\":\"$ADMIN_PASS\"}")
if echo "$LOGIN_RES" | grep -q '"success":true'; then
  echo "PASS: admin login PASS"
else
  echo "FAIL: admin login failed: $LOGIN_RES"
  exit 1
fi

# Action log test
LOG_TEST_RES=$(curl -s -b /tmp/cookies.txt -X POST "$BASE_URL/api/admin/logs/test" -H "Content-Type: application/json" -d '{}')
if echo "$LOG_TEST_RES" | grep -q '"success":true'; then
  echo "PASS: action log test endpoint PASS"
else
  echo "FAIL: action log test endpoint failed: $LOG_TEST_RES"
  exit 1
fi

LOG_HISTORY=$(curl -s -b /tmp/cookies.txt "$BASE_URL/api/admin/logs/action-history/entries?limit=20")
if echo "$LOG_HISTORY" | grep -q 'Test log' && grep -q 'Test log' data/action.log; then
  echo "PASS: action log history and file contain test log"
else
  echo "FAIL: action log history/file missing test log"
  exit 1
fi

curl -s -b /tmp/cookies.txt -X POST "$BASE_URL/api/admin/policies" -H "Content-Type: application/json" -d '{"name":"O-Pol","protocol":"openai","injectPosition":"append_system","injectMode":"every_request","content":"System prompt openai"}' > /dev/null
curl -s -b /tmp/cookies.txt -X POST "$BASE_URL/api/admin/policies" -H "Content-Type: application/json" -d '{"name":"A-Pol","protocol":"anthropic","injectPosition":"append_system","injectMode":"every_request","content":"System prompt ant"}' > /dev/null
curl -s -b /tmp/cookies.txt -X POST "$BASE_URL/api/admin/policies" -H "Content-Type: application/json" -d '{"name":"Once-Pol","protocol":"openai","injectPosition":"append_system","injectMode":"once_per_conversation","content":"ONCE_SYSTEM_PROMPT"}' > /dev/null

ALL_POLICIES=$(curl -s -b /tmp/cookies.txt "$BASE_URL/api/admin/policies")
POL_O_ID=$(node -pe "JSON.parse(process.argv[1]).find(p => p.name === 'O-Pol').id" "$ALL_POLICIES")
POL_A_ID=$(node -pe "JSON.parse(process.argv[1]).find(p => p.name === 'A-Pol').id" "$ALL_POLICIES")
POL_ONCE_ID=$(node -pe "JSON.parse(process.argv[1]).find(p => p.name === 'Once-Pol').id" "$ALL_POLICIES")

# 5. Settings
curl -s -b /tmp/cookies.txt -X POST "$BASE_URL/api/admin/settings" -H "Content-Type: application/json" -d '{"settings":[{"key":"mainDomain","value":"example.test"}]}' > /dev/null

# 6. Provider Creation
TEST_SESS_RES=$(curl -s -b /tmp/cookies.txt -X POST "$BASE_URL/api/admin/providers/test" -H "Content-Type: application/json" -d '{"openaiBaseUrl":"http://localhost:4010/v1","apiKey":"sk-mock-key"}')
TEST_ID=$(echo "$TEST_SESS_RES" | grep -o '"testSessionId":"[^"]*"' | cut -d'"' -f4 || true)

if [ -z "$TEST_ID" ]; then
  echo "FAIL: provider test failed"
  exit 1
fi

PROV_RES=$(curl -s -b /tmp/cookies.txt -X POST "$BASE_URL/api/admin/providers" -H "Content-Type: application/json" -d "{\"name\":\"TestProv\",\"openaiBaseUrl\":\"http://localhost:4010/v1\",\"apiKey\":\"sk-mock-key\",\"anthropicBaseUrl\":\"http://localhost:4010\",\"manualModels\":[\"claude-test-model\"],\"testSessionId\":\"$TEST_ID\"}")
PROV_ID=$(echo "$PROV_RES" | grep -o '"id":"[^"]*"' | cut -d'"' -f4 || true)

if [ -z "$PROV_ID" ]; then
  echo "FAIL: provider creation failed: $PROV_RES"
  exit 1
fi
echo "PASS: provider created PASS"

# Inject anthropic model directly for test (since mock upstream doesn't mock anthropic models)
sqlite3 data/promptgate-fresh.sqlite "INSERT INTO provider_models (id, providerId, modelId, displayName, enabled, createdAt) VALUES ('fake-anthropic-model', '$PROV_ID', 'claude-test-model', 'Claude Test', 1, 1000);"

# 7 & 9. Routes (replaces Subdomains & Endpoints)
ROUTE_O_RES=$(curl -s -b /tmp/cookies.txt -X POST "$BASE_URL/api/admin/routes" -H "Content-Type: application/json" -d "{\"name\":\"OpenAI Route\",\"hostInput\":\"code\",\"path\":\"/v1/chat/completions\",\"incomingProtocol\":\"openai\",\"providerId\":\"$PROV_ID\",\"providerProtocol\":\"openai\",\"modelId\":\"model-a\",\"promptPolicyId\":\"$POL_O_ID\",\"enabled\":true}")
ROUTE_O_ID=$(echo "$ROUTE_O_RES" | grep -o '"id":"[^"]*"' | cut -d'"' -f4 || true)

ROUTE_A_RES=$(curl -s -b /tmp/cookies.txt -X POST "$BASE_URL/api/admin/routes" -H "Content-Type: application/json" -d "{\"name\":\"Anthropic Route\",\"hostInput\":\"code\",\"path\":\"/v1/messages\",\"incomingProtocol\":\"anthropic\",\"providerId\":\"$PROV_ID\",\"providerProtocol\":\"anthropic\",\"modelId\":\"claude-test-model\",\"promptPolicyId\":\"$POL_A_ID\",\"enabled\":true}")
echo "ROUTE_A_RES=$ROUTE_A_RES"
ROUTE_A_ID=$(echo "$ROUTE_A_RES" | grep -o '"id":"[^"]*"' | cut -d'"' -f4 || true)

ROUTE_V0_RES=$(curl -s -b /tmp/cookies.txt -X POST "$BASE_URL/api/admin/routes" -H "Content-Type: application/json" -d "{\"name\":\"Anthropic v0 Route\",\"hostInput\":\"code\",\"path\":\"/v0/messages\",\"incomingProtocol\":\"anthropic\",\"providerId\":\"$PROV_ID\",\"providerProtocol\":\"anthropic\",\"modelId\":\"claude-test-model\",\"promptPolicyId\":null,\"enabled\":true}")
ROUTE_V0_ID=$(echo "$ROUTE_V0_RES" | grep -o '"id":"[^"]*"' | cut -d'"' -f4 || true)

if [ -z "$ROUTE_O_ID" ]; then
  echo "FAIL: Route creation failed: $ROUTE_O_RES"
  exit 1
fi

echo "PASS: route matrix configured PASS"

# 10. API Key
ME_RES=$(curl -s -b /tmp/cookies.txt "$BASE_URL/api/auth/me")
REAL_USER_ID=$(echo "$ME_RES" | grep -o '"id":"[^"]*"' | cut -d'"' -f4 || true)

if [ -z "$REAL_USER_ID" ]; then
  echo "FAIL: Could not fetch real user ID from /api/auth/me"
  exit 1
fi

AK_RES=$(curl -s -b /tmp/cookies.txt -X POST "$BASE_URL/api/me/api-keys" -H "Content-Type: application/json" -d "{\"name\":\"test-key\"}")
PG_KEY=$(echo "$AK_RES" | grep -o '"apiKey":"[^"]*"' | cut -d'"' -f4 || true)
if [[ "$PG_KEY" != pg_* ]]; then
  echo "FAIL: API key missing pg_ prefix: $PG_KEY"
  exit 1
fi
echo "PASS: API key pg_ prefix PASS"

LIST_RES=$(curl -s -b /tmp/cookies.txt "$BASE_URL/api/admin/api-keys")
if echo "$LIST_RES" | grep -q '"keyHash"'; then
  echo "FAIL: API Key hash leaked in list response!"
  exit 1
fi
echo "PASS: API Key hash is not leaked in list response"

# 11. Gateway Requests
GATEWAY_URL="http://localhost:$PORT"

# Non-stream OpenAI
NS_RES=$(curl -s -X POST "$GATEWAY_URL/v1/chat/completions" -H "Host: code.example.test" -H "Authorization: Bearer $PG_KEY" -H "Content-Type: application/json" -d '{"model":"model-a","messages":[{"role":"user","content":"hi"}]}')
if echo "$NS_RES" | grep -q 'Mock' && echo "$NS_RES" | grep -q 'System prompt openai'; then
  echo "PASS: OpenAI non-stream PASS"
else
  echo "FAIL: non-stream request failed or policy not injected: $NS_RES"
  exit 1
fi

# Stream OpenAI
S_RES=$(curl -s -X POST "$GATEWAY_URL/v1/chat/completions" -H "Host: code.example.test" -H "Authorization: Bearer $PG_KEY" -H "Content-Type: application/json" -d '{"model":"model-a","stream":true,"messages":[{"role":"user","content":"hi"}]}')
if echo "$S_RES" | grep -q 'Hello'; then
  echo "PASS: OpenAI stream PASS"
else
  echo "FAIL: stream request failed: $S_RES"
  exit 1
fi

# Anthropic messages
ANT_RES=$(curl -s -X POST "$GATEWAY_URL/v1/messages" -H "Host: code.example.test" -H "Authorization: Bearer $PG_KEY" -H "Content-Type: application/json" -d '{"model":"claude-test-model","messages":[{"role":"user","content":"hi"}]}')
if echo "$ANT_RES" | grep -q 'Anthropic Mock' && echo "$ANT_RES" | grep -q 'System prompt ant'; then
  echo "PASS: Anthropic messages PASS"
else
  echo "FAIL: anthropic request failed or policy not injected: $ANT_RES"
  exit 1
fi

# v0 messages
V0_RES=$(curl -s -X POST "$GATEWAY_URL/v0/messages" -H "Host: code.example.test" -H "Authorization: Bearer $PG_KEY" -H "Content-Type: application/json" -d '{"model":"claude-test-model","messages":[{"role":"user","content":"hi"}]}')
if echo "$V0_RES" | grep -q 'x-anthropic-client' && echo "$V0_RES" | grep -q 'claude-code/1.0.0' && echo "$V0_RES" | grep -q 'Claude Code'; then
  echo "PASS: /v0/messages built-in policy PASS"
else
  echo "FAIL: /v0/messages request failed or assertions missing: $V0_RES"
  exit 1
fi

# once_per_conversation test
curl -s -b /tmp/cookies.txt -X PATCH "$BASE_URL/api/admin/routes/$ROUTE_O_ID" -H "Content-Type: application/json" -d "{\"promptPolicyId\":\"$POL_ONCE_ID\"}" > /dev/null

ONCE_REQ1=$(curl -s -X POST "$GATEWAY_URL/v1/chat/completions" -H "Host: code.example.test" -H "Authorization: Bearer $PG_KEY" -H "X-Conversation-Id: test-conv-1" -H "Content-Type: application/json" -d '{"model":"model-a","messages":[{"role":"user","content":"hi 1"}]}')
if echo "$ONCE_REQ1" | grep -q 'ONCE_SYSTEM_PROMPT'; then
  :
else
  echo "FAIL: once_per_conversation first request missing injection: $ONCE_REQ1"
  exit 1
fi

ONCE_REQ2=$(curl -s -X POST "$GATEWAY_URL/v1/chat/completions" -H "Host: code.example.test" -H "Authorization: Bearer $PG_KEY" -H "X-Conversation-Id: test-conv-1" -H "Content-Type: application/json" -d '{"model":"model-a","messages":[{"role":"user","content":"hi 2"}]}')
if echo "$ONCE_REQ2" | grep -q 'ONCE_SYSTEM_PROMPT'; then
  echo "FAIL: once_per_conversation second request should NOT have injection: $ONCE_REQ2"
  exit 1
else
  echo "PASS: once_per_conversation first inject / second skip PASS"
fi

# Change route model
curl -s -b /tmp/cookies.txt -X PATCH "$BASE_URL/api/admin/routes/$ROUTE_O_ID" -H "Content-Type: application/json" -d "{\"modelId\":\"model-b\"}" > /dev/null
MODEL_CHANGE_RES=$(curl -s -X POST "$GATEWAY_URL/v1/chat/completions" -H "Host: code.example.test" -H "Authorization: Bearer $PG_KEY" -H "Content-Type: application/json" -d '{"model":"model-a","messages":[{"role":"user","content":"hi"}]}')
if echo "$MODEL_CHANGE_RES" | grep -q '"model":"model-b"'; then
  echo "PASS: model-a -> model-b PASS"
else
  echo "FAIL: route changed model-a -> model-b failed: $MODEL_CHANGE_RES"
  exit 1
fi

# Disable provider
curl -s -b /tmp/cookies.txt -X PATCH "$BASE_URL/api/admin/providers/$PROV_ID" -H "Content-Type: application/json" -d "{\"enabled\":false}" > /dev/null
FAIL_RES=$(curl -s -w "%{http_code}" -X POST "$GATEWAY_URL/v1/chat/completions" -H "Host: code.example.test" -H "Authorization: Bearer $PG_KEY" -H "Content-Type: application/json" -d '{"model":"model-b","messages":[]}' -o /dev/null)
if [ "$FAIL_RES" -eq 503 ] || [ "$FAIL_RES" -eq 404 ] || [ "$FAIL_RES" -eq 400 ]; then
  echo "PASS: disabled provider PASS"
else
  echo "FAIL: request should be rejected when provider disabled. HTTP $FAIL_RES"
  exit 1
fi

# Enable provider, disable route
curl -s -b /tmp/cookies.txt -X PATCH "$BASE_URL/api/admin/providers/$PROV_ID" -H "Content-Type: application/json" -d "{\"enabled\":true}" > /dev/null
curl -s -b /tmp/cookies.txt -X PATCH "$BASE_URL/api/admin/routes/$ROUTE_O_ID" -H "Content-Type: application/json" -d "{\"enabled\":false}" > /dev/null
FAIL_RES2=$(curl -s -w "%{http_code}" -X POST "$GATEWAY_URL/v1/chat/completions" -H "Host: code.example.test" -H "Authorization: Bearer $PG_KEY" -H "Content-Type: application/json" -d '{"model":"model-b","messages":[]}' -o /dev/null)
if [ "$FAIL_RES2" -eq 403 ] || [ "$FAIL_RES2" -eq 404 ]; then
  echo "PASS: disabled route PASS"
else
  echo "FAIL: request should be rejected when route disabled. HTTP $FAIL_RES2"
  exit 1
fi

# Re-enable route for further tests
curl -s -b /tmp/cookies.txt -X PATCH "$BASE_URL/api/admin/routes/$ROUTE_O_ID" -H "Content-Type: application/json" -d "{\"enabled\":true,\"modelId\":\"model-a\"}" > /dev/null

# === FALLBACK VALIDATION TESTS ===
echo ""
echo "=== Fallback Validation Tests ==="

FB_TEST1=$(curl -s -w "\n%{http_code}" -b /tmp/cookies.txt -X POST "$BASE_URL/api/admin/routes" -H "Content-Type: application/json" -d "{\"name\":\"FB Test\",\"hostInput\":\"fbtest\",\"path\":\"/v1/chat/completions\",\"incomingProtocol\":\"openai\",\"providerId\":\"$PROV_ID\",\"providerProtocol\":\"openai\",\"modelId\":\"model-a\",\"enabled\":true,\"fallbackEnabled\":true}")
FB_TEST1_CODE=$(echo "$FB_TEST1" | tail -1)
if [ "$FB_TEST1_CODE" -eq 400 ]; then
  echo "PASS: fallbackEnabled=true without fallbackProviderId returns 400"
else
  echo "FAIL: expected 400 but got $FB_TEST1_CODE: $(echo "$FB_TEST1" | head -1)"
  exit 1
fi

FB_TEST2=$(curl -s -w "\n%{http_code}" -b /tmp/cookies.txt -X POST "$BASE_URL/api/admin/routes" -H "Content-Type: application/json" -d "{\"name\":\"FB Test2\",\"hostInput\":\"fbtest2\",\"path\":\"/v1/chat/completions\",\"incomingProtocol\":\"openai\",\"providerId\":\"$PROV_ID\",\"providerProtocol\":\"openai\",\"modelId\":\"model-a\",\"enabled\":true,\"fallbackEnabled\":true,\"fallbackProviderId\":\"$PROV_ID\",\"fallbackProviderProtocol\":\"openai\",\"fallbackModelId\":\"nonexistent-model\"}")
FB_TEST2_CODE=$(echo "$FB_TEST2" | tail -1)
if [ "$FB_TEST2_CODE" -eq 400 ]; then
  echo "PASS: invalid fallbackModelId returns 400"
else
  echo "FAIL: expected 400 but got $FB_TEST2_CODE: $(echo "$FB_TEST2" | head -1)"
  exit 1
fi

FB_TEST3=$(curl -s -w "\n%{http_code}" -b /tmp/cookies.txt -X POST "$BASE_URL/api/admin/routes" -H "Content-Type: application/json" -d "{\"name\":\"FB Test3\",\"hostInput\":\"fbtest3\",\"path\":\"/v1/chat/completions\",\"incomingProtocol\":\"openai\",\"providerId\":\"$PROV_ID\",\"providerProtocol\":\"openai\",\"modelId\":\"model-a\",\"enabled\":true,\"fallbackEnabled\":true,\"fallbackProviderId\":\"$PROV_ID\",\"fallbackProviderProtocol\":\"openai\",\"fallbackModelId\":\"model-a\"}")
FB_TEST3_CODE=$(echo "$FB_TEST3" | tail -1)
if [ "$FB_TEST3_CODE" -eq 400 ]; then
  echo "PASS: fallback same as primary returns 400"
else
  echo "FAIL: expected 400 but got $FB_TEST3_CODE: $(echo "$FB_TEST3" | head -1)"
  exit 1
fi

FB_TEST4=$(curl -s -w "\n%{http_code}" -b /tmp/cookies.txt -X PATCH "$BASE_URL/api/admin/routes/$ROUTE_O_ID" -H "Content-Type: application/json" -d '{"fallbackEnabled":true}')
FB_TEST4_CODE=$(echo "$FB_TEST4" | tail -1)
if [ "$FB_TEST4_CODE" -eq 400 ]; then
  echo "PASS: PATCH fallbackEnabled=true without fields returns 400"
else
  echo "FAIL: expected 400 but got $FB_TEST4_CODE: $(echo "$FB_TEST4" | head -1)"
  exit 1
fi

# === STREAM FALLBACK TESTS ===
echo ""
echo "=== Stream Fallback Tests ==="

FB_ROUTE_RES=$(curl -s -b /tmp/cookies.txt -X POST "$BASE_URL/api/admin/routes" -H "Content-Type: application/json" -d "{\"name\":\"FB Test Route\",\"hostInput\":\"fbtest\",\"path\":\"/v1/chat/completions\",\"incomingProtocol\":\"openai\",\"providerId\":\"$PROV_ID\",\"providerProtocol\":\"openai\",\"modelId\":\"model-a\",\"enabled\":true,\"fallbackEnabled\":true,\"fallbackProviderId\":\"$PROV_ID\",\"fallbackProviderProtocol\":\"openai\",\"fallbackModelId\":\"model-b\"}")
FB_ROUTE_ID=$(echo "$FB_ROUTE_RES" | grep -o '"id":"[^"]*"' | cut -d'"' -f4 || true)

if [ -z "$FB_ROUTE_ID" ]; then
  echo "FAIL: Failed to create fallback test route"
  exit 1
fi

# 429
S429_RES=$(curl -s -X POST "$GATEWAY_URL/v1/chat/completions" -H "Host: fbtest.example.test" -H "Authorization: Bearer $PG_KEY" -H "Content-Type: application/json" -d '{"model":"model-a","stream":true,"messages":[{"role":"user","content":"trigger-429"}]}')
if echo "$S429_RES" | grep -q 'Hello' || echo "$S429_RES" | grep -q 'Mock'; then
  echo "PASS: stream 429 triggered fallback"
else
  echo "FAIL: stream 429 failed to fallback: $S429_RES"
  exit 1
fi

# 503
S503_RES=$(curl -s -X POST "$GATEWAY_URL/v1/chat/completions" -H "Host: fbtest.example.test" -H "Authorization: Bearer $PG_KEY" -H "Content-Type: application/json" -d '{"model":"model-a","stream":true,"messages":[{"role":"user","content":"trigger-503"}]}')
if echo "$S503_RES" | grep -q 'Hello' || echo "$S503_RES" | grep -q 'Mock'; then
  echo "PASS: stream 503 triggered fallback"
else
  echo "FAIL: stream 503 failed to fallback: $S503_RES"
  exit 1
fi

# 529
S529_RES=$(curl -s -X POST "$GATEWAY_URL/v1/chat/completions" -H "Host: fbtest.example.test" -H "Authorization: Bearer $PG_KEY" -H "Content-Type: application/json" -d '{"model":"model-a","stream":true,"messages":[{"role":"user","content":"trigger-529"}]}')
if echo "$S529_RES" | grep -q 'Hello' || echo "$S529_RES" | grep -q 'Mock'; then
  echo "PASS: stream 529 triggered fallback"
else
  echo "FAIL: stream 529 failed to fallback: $S529_RES"
  exit 1
fi

# interrupt
SINT_RES=$(curl -s -X POST "$GATEWAY_URL/v1/chat/completions" -H "Host: fbtest.example.test" -H "Authorization: Bearer $PG_KEY" -H "Content-Type: application/json" -d '{"model":"model-a","stream":true,"messages":[{"role":"user","content":"trigger-stream-interrupt"}]}' || true)
if echo "$SINT_RES" | grep -q 'Start' && ! (echo "$SINT_RES" | grep -q 'Hello'); then
  echo "PASS: stream interrupt did not fallback"
else
  echo "FAIL: stream interrupt behaved incorrectly: $SINT_RES"
  exit 1
fi

# === Anthropic->OpenAI ADAPTATION TOKEN TEST ===
echo ""
echo "=== Anthropic->OpenAI Adaptation Token Test ==="

ADAPT_ROUTE_RES=$(curl -s -b /tmp/cookies.txt -X POST "$BASE_URL/api/admin/routes" -H "Content-Type: application/json" -d "{\"name\":\"Adapt Route\",\"hostInput\":\"code\",\"path\":\"/v1/messages\",\"incomingProtocol\":\"anthropic\",\"providerId\":\"$PROV_ID\",\"providerProtocol\":\"openai\",\"modelId\":\"model-a\",\"enabled\":true}")
ADAPT_ROUTE_ID=$(echo "$ADAPT_ROUTE_RES" | grep -o '"id":"[^"]*"' | cut -d'"' -f4 || true)

curl -s -b /tmp/cookies.txt -X PATCH "$BASE_URL/api/admin/routes/$ROUTE_A_ID" -H "Content-Type: application/json" -d '{"enabled":false}' > /dev/null

ADAPT_RES=$(curl -s -X POST "$GATEWAY_URL/v1/messages" -H "Host: code.example.test" -H "Authorization: Bearer $PG_KEY" -H "Content-Type: application/json" -d '{"model":"model-a","messages":[{"role":"user","content":"hi"}],"max_tokens":100}')
if echo "$ADAPT_RES" | grep -q '"input_tokens"' && echo "$ADAPT_RES" | grep -q '"output_tokens"'; then
  echo "PASS: Anthropic->OpenAI adaptation returns usage with input_tokens/output_tokens"
else
  echo "FAIL: Adapted response missing Anthropic usage fields: $ADAPT_RES"
  exit 1
fi

INPUT_TOKENS=$(echo "$ADAPT_RES" | node -pe "JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).usage.input_tokens" || true)
OUTPUT_TOKENS=$(echo "$ADAPT_RES" | node -pe "JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).usage.output_tokens" || true)
if [ "$INPUT_TOKENS" = "10" ] && [ "$OUTPUT_TOKENS" = "20" ]; then
  echo "PASS: Adapted usage tokens correct (input=10 output=20)"
else
  echo "FAIL: Token values wrong input=$INPUT_TOKENS output=$OUTPUT_TOKENS"
  exit 1
fi

# === ACTION LOG PATH TEST ===
echo ""
echo "=== Action Log Path Test ==="
if [ -f "data/action.log" ]; then
  echo "PASS: action.log exists at data/action.log"
else
  echo "FAIL: data/action.log does not exist"
  exit 1
fi

# === CHINESE LOG TEST ===
echo ""
echo "=== Chinese Log Test ==="
if grep -q 'Upstream returned' data/action.log 2>/dev/null; then
  echo "FAIL: Found 'Upstream returned' in action.log"
  exit 1
fi
if grep -q 'Queue Full' data/action.log 2>/dev/null; then
  echo "FAIL: Found 'Queue Full' in action.log"
  exit 1
fi
if grep -q 'Failed to load action log history' data/action.log 2>/dev/null; then
  echo "FAIL: Found 'Failed to load action log history' in action.log"
  exit 1
fi
if grep -q 'apiKey=test-key' data/action.log 2>/dev/null; then
  echo "FAIL: Found raw APIKey name 'test-key' in action.log (should be pg_xxx)"
  exit 1
fi
if grep -q 'apiKey=pg_' data/action.log 2>/dev/null; then
  echo "PASS: Found correct APIKey prefix in action.log"
else
  echo "FAIL: No apiKey=pg_ found in action.log"
  exit 1
fi
echo "PASS: No English business messages in action.log"

# === providerProtocol DERIVATION TEST ===
echo ""
echo "=== providerProtocol Derivation Test ==="
DERIVE_RES=$(curl -s -w "\n%{http_code}" -b /tmp/cookies.txt -X POST "$BASE_URL/api/admin/routes" -H "Content-Type: application/json" -d "{\"name\":\"Derive Test\",\"hostInput\":\"derive\",\"path\":\"/v1/chat/completions\",\"incomingProtocol\":\"openai\",\"providerId\":\"$PROV_ID\",\"modelId\":\"model-a\",\"enabled\":true}")
DERIVE_CODE=$(echo "$DERIVE_RES" | tail -1)
DERIVE_ID=$(echo "$DERIVE_RES" | head -1 | grep -o '"id":"[^"]*"' | cut -d'"' -f4 || true)
if [ "$DERIVE_CODE" -eq 201 ] && [ -n "$DERIVE_ID" ]; then
  DERIVE_ROUTE=$(curl -s -b /tmp/cookies.txt "$BASE_URL/api/admin/routes/$DERIVE_ID")
  DERIVE_PROTO=$(echo "$DERIVE_ROUTE" | node -pe "JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).providerProtocol" || true)
  if [ "$DERIVE_PROTO" = "openai" ]; then
    echo "PASS: providerProtocol auto-derived as openai"
  else
    echo "FAIL: providerProtocol should be openai but got $DERIVE_PROTO"
    exit 1
  fi
else
  echo "FAIL: Route creation without providerProtocol failed: code=$DERIVE_CODE"
  exit 1
fi

SPOOF_RES=$(curl -s -w "\n%{http_code}" -b /tmp/cookies.txt -X POST "$BASE_URL/api/admin/routes" -H "Content-Type: application/json" -d "{\"name\":\"Spoof Test\",\"hostInput\":\"spoof\",\"path\":\"/v1/chat/completions\",\"incomingProtocol\":\"openai\",\"providerId\":\"$PROV_ID\",\"providerProtocol\":\"anthropic\",\"modelId\":\"model-a\",\"enabled\":true}")
SPOOF_CODE=$(echo "$SPOOF_RES" | tail -1)
SPOOF_ID=$(echo "$SPOOF_RES" | head -1 | grep -o '"id":"[^"]*"' | cut -d'"' -f4 || true)
if [ "$SPOOF_CODE" -eq 201 ] && [ -n "$SPOOF_ID" ]; then
  SPOOF_ROUTE=$(curl -s -b /tmp/cookies.txt "$BASE_URL/api/admin/routes/$SPOOF_ID")
  SPOOF_PROTO=$(echo "$SPOOF_ROUTE" | node -pe "JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).providerProtocol" || true)
  if [ "$SPOOF_PROTO" = "openai" ]; then
    echo "PASS: providerProtocol cannot be spoofed (model-a is openai only, spoofed anthropic ignored)"
  else
    echo "FAIL: providerProtocol spoofed to $SPOOF_PROTO should be openai"
    exit 1
  fi
else
  echo "FAIL: Route creation with spoofed providerProtocol failed: code=$SPOOF_CODE"
  exit 1
fi

echo ""
echo "All tests passed!"
