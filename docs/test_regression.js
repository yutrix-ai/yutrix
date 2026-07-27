// Native fetch used
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || process.argv[2] || 'password';
let adminCookie = '';
let testProviderId = '';
let pgKey = '';

// Start Mock Server
const mockServer = http.createServer((req, res) => {
  if (req.url === '/v1/models' || req.url === '/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      data: [{ id: 'mock-model-1', object: 'model' }, { id: 'mock-model-2', object: 'model' }]
    }));
  } else if (req.url === '/v1/chat/completions') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'mock-123',
      choices: [{ message: { role: 'assistant', content: 'mock test' } }],
      usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 }
    }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

async function loginAdmin() {
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: ADMIN_PASSWORD })
  });
  const data = await res.json();
  if (!res.ok) throw new Error('Admin login failed: ' + (data.error || JSON.stringify(data)));
  adminCookie = res.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  console.log('[PASS] Admin login successful');
}

async function readSseUntil(url, predicate, { timeoutMs = 5000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const res = await fetch(url, {
    headers: { Cookie: adminCookie },
    signal: controller.signal
  });
  if (!res.ok) throw new Error('SSE connection failed: HTTP ' + res.status);

  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const events = buffer.split('\n\n');
      buffer = events.pop() || '';
      for (const eventText of events) {
        const dataLine = eventText.split('\n').find((line) => line.startsWith('data: '));
        if (!dataLine) continue;
        const data = JSON.parse(dataLine.slice(6));
        if (predicate(data)) return data;
      }
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  throw new Error('SSE did not receive expected action log');
}

async function testActionLogPipeline() {
  const testRes = await fetch(`${BASE_URL}/api/admin/logs/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
    body: '{}'
  });
  const testData = await testRes.json();
  if (!testRes.ok || testData.success !== true) {
    throw new Error('POST /api/admin/logs/test failed: ' + JSON.stringify(testData));
  }

  const historyRes = await fetch(`${BASE_URL}/api/admin/logs/action-history/entries?limit=50`, {
    headers: { Cookie: adminCookie }
  });
  const history = await historyRes.json();
  const historyLine = history.find((entry) => entry.line && entry.line.includes('Test log'));
  if (!historyLine || historyLine.level !== 'INFO' || !historyLine.line.includes('这是一条实时日志测试')) {
    throw new Error('Action log history did not include structured test log');
  }
  if (historyLine.line.includes('\n') || historyLine.line.includes('\r')) {
    throw new Error('Action log line is not single-line Chinese text');
  }

  const ssePromise = readSseUntil(
    `${BASE_URL}/api/admin/logs/stream?limit=10`,
    (entry) => entry.line && entry.line.includes('Test log')
  );
  await fetch(`${BASE_URL}/api/admin/logs/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
    body: '{}'
  });
  const sseEntry = await ssePromise;
  if (sseEntry.level !== 'INFO' || !sseEntry.timestamp || !sseEntry.line) {
    throw new Error('SSE action log payload missing timestamp/level/line');
  }

  const actionLogPath = process.env.ACTION_LOG_FILE || process.env.LOG_FILE_NAME || 'data/action.log';
  const fileText = fs.readFileSync(actionLogPath, 'utf8');
  if (!fileText.includes('Test log')) throw new Error('data/action.log does not include test log');
  if (/keyHash|passwordHash|inviteCode hash/.test(fileText)) {
    throw new Error('Action log leaked sensitive hash field names');
  }
  console.log('[PASS] Action log pipeline writes to test API, history, SSE, and data/action.log');
}

async function createUser() {
  const username = 'testuser_' + Date.now();
  const password = 'Testpassword123!';
  const res = await fetch(`${BASE_URL}/api/admin/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cookie': adminCookie },
    body: JSON.stringify({ username, password, role: 'user' })
  });
  const data = await res.json();
  if (!res.ok) throw new Error('Create user failed: ' + JSON.stringify(data));
  console.log('[PASS] Create user successful:', username);
  return { id: data.id, username, password };
}

async function testApiKeyCRUD(userId, userCookie) {
  // User creates Active API Key
  const res = await fetch(`${BASE_URL}/api/me/api-keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cookie': userCookie },
    body: JSON.stringify({ name: 'Key for ' + userId })
  });
  const data = await res.json();
  if (!res.ok) throw new Error('Create API key failed: ' + (data.error || JSON.stringify(data)));
  console.log('[PASS] User created Active API Key');

  // Create another key to be expired
  const expiredRes = await fetch(`${BASE_URL}/api/me/api-keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cookie': userCookie },
    body: JSON.stringify({ name: 'Expired Key' })
  });
  const expiredData = await expiredRes.json();
  if (!expiredRes.ok) throw new Error('Create Expired API key failed');

  // Fetch admin keys to assert no keyHash leak and to get the IDs
  const adminKeysRes = await fetch(`${BASE_URL}/api/admin/api-keys`, {
    headers: { 'Cookie': adminCookie }
  });
  const adminKeysData = await adminKeysRes.json();
  if (adminKeysData.some(k => k.keyHash)) {
    throw new Error('API Key hash was leaked to admin!');
  }
  const expKeyId = adminKeysData.find(k => k.name === 'Expired Key').id;
  
  // Admin patches the key to be expired
  const patchExpRes = await fetch(`${BASE_URL}/api/admin/api-keys/${expKeyId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'Cookie': adminCookie },
    body: JSON.stringify({ expiresAt: new Date(0).toISOString() })
  });
  if (!patchExpRes.ok) throw new Error('Admin failed to patch expiresAt');
  console.log('[PASS] Admin patched key to be expired');

  // Test invalid expiresAt via PATCH
  const invalidExpRes = await fetch(`${BASE_URL}/api/admin/api-keys/${expKeyId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'Cookie': adminCookie },
    body: JSON.stringify({ expiresAt: 'not-a-date' })
  });
  if (invalidExpRes.status !== 400) throw new Error('Admin patched API key with invalid expiresAt!');
  console.log('[PASS] Admin rejected PATCH with invalid expiresAt');

  const activeKeyId = adminKeysData.find(k => k.name === 'Key for ' + userId).id;

  // Test that Admin cannot create API key for user anymore
  const fakeRes = await fetch(`${BASE_URL}/api/admin/api-keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cookie': adminCookie },
    body: JSON.stringify({ name: 'Fake User Key', userId: 'invalid-user-uuid', concurrencyLimit: 5 })
  });
  if (fakeRes.status !== 400) throw new Error('Admin creation of API key was not rejected with 400! Status: ' + fakeRes.status);
  console.log('[PASS] Admin API key creation endpoint correctly rejects requests');

  return { activeKey: data.apiKey, expiredKey: expiredData.apiKey, activeKeyId };
}

async function createSimpleApiKeyForUser(userId, name, userCookie) {
  const res = await fetch(`${BASE_URL}/api/me/api-keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cookie': userCookie },
    body: JSON.stringify({ name })
  });
  const data = await res.json();
  if (!res.ok) throw new Error('Create simple API key failed: ' + JSON.stringify(data));
  const listRes = await fetch(`${BASE_URL}/api/admin/api-keys`, {
    headers: { 'Cookie': adminCookie }
  });
  const list = await listRes.json();
  const created = list.find(k => k.name === name);
  if (!created) throw new Error('Created simple API key not found');
  return { rawKey: data.apiKey, id: created.id };
}

async function testStatusPatching(activeKeyId, otherUserKeyId, userCookie) {
  // admin patch invalid -> 400
  const patchInvalid = await fetch(`${BASE_URL}/api/admin/api-keys/${activeKeyId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'Cookie': adminCookie },
    body: JSON.stringify({ status: 'unknown' })
  });
  if (patchInvalid.status !== 400) throw new Error('Admin patched status with invalid enum!');
  console.log('[PASS] Admin patch status=invalid rejected');

  // admin patch disabled -> 200
  const patchDisabled = await fetch(`${BASE_URL}/api/admin/api-keys/${activeKeyId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'Cookie': adminCookie },
    body: JSON.stringify({ status: 'disabled' })
  });
  const patchDisabledData = await patchDisabled.json();
  if (!patchDisabled.ok || patchDisabledData.apiKey.status !== 'disabled') throw new Error('Admin failed to patch status=disabled!');
  console.log('[PASS] Admin patch status=disabled succeeded');

  // admin patch active -> 200
  const patchActive = await fetch(`${BASE_URL}/api/admin/api-keys/${activeKeyId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'Cookie': adminCookie },
    body: JSON.stringify({ status: 'active' })
  });
  const patchActiveData = await patchActive.json();
  if (!patchActive.ok || patchActiveData.apiKey.status !== 'active') throw new Error('Admin failed to patch status=active!');
  console.log('[PASS] Admin patch status=active succeeded');

  const patchMissing = await fetch(`${BASE_URL}/api/admin/api-keys/not-found`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'Cookie': adminCookie },
    body: JSON.stringify({ status: 'disabled' })
  });
  if (patchMissing.status !== 404) throw new Error('Admin patch missing API key did not return 404');
  console.log('[PASS] Admin patch missing API Key returns 404');

  // user patch active -> 400
  const userPatchActive = await fetch(`${BASE_URL}/api/me/api-keys/${activeKeyId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'Cookie': userCookie },
    body: JSON.stringify({ status: 'active' })
  });
  if (userPatchActive.status !== 400) throw new Error('User was able to patch status=active!');
  console.log('[PASS] User patch status=active rejected');

  const userPatchMissing = await fetch(`${BASE_URL}/api/me/api-keys/not-found`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'Cookie': userCookie },
    body: JSON.stringify({ status: 'revoked' })
  });
  if (userPatchMissing.status !== 404) throw new Error('User patch missing API key did not return 404');
  console.log('[PASS] User patch missing API Key returns 404');

  const userPatchOther = await fetch(`${BASE_URL}/api/me/api-keys/${otherUserKeyId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'Cookie': userCookie },
    body: JSON.stringify({ status: 'revoked' })
  });
  if (userPatchOther.status !== 404 && userPatchOther.status !== 403) {
    throw new Error('User patch another user API key did not return 404/403');
  }
  console.log('[PASS] User cannot patch another user API Key');

  // user patch disabled -> 400
  const userPatchDisabled = await fetch(`${BASE_URL}/api/me/api-keys/${activeKeyId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'Cookie': userCookie },
    body: JSON.stringify({ status: 'disabled' })
  });
  if (userPatchDisabled.status !== 400) throw new Error('User was able to patch status=disabled!');
  console.log('[PASS] User patch status=disabled rejected');

  // Create a new key for user to revoke
  const userCreateRes = await fetch(`${BASE_URL}/api/me/api-keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cookie': userCookie },
    body: JSON.stringify({ name: 'Key to Revoke' })
  });
  const userCreateData = await userCreateRes.json();
  const revokeKeyHash = userCreateData.apiKey;
  
  const userKeysListTmp = await fetch(`${BASE_URL}/api/me/api-keys`, { headers: { 'Cookie': userCookie } });
  const userKeysDataTmp = await userKeysListTmp.json();
  const revokeKeyId = userKeysDataTmp.find(k => k.name === 'Key to Revoke').id;

  // user patch revoked -> 200
  const userPatchRevoked = await fetch(`${BASE_URL}/api/me/api-keys/${revokeKeyId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'Cookie': userCookie },
    body: JSON.stringify({ status: 'revoked' })
  });
  if (!userPatchRevoked.ok) throw new Error('User failed to patch status=revoked!');
  console.log('[PASS] User patch status=revoked succeeded');

  // user list API keys -> revoked key should not be listed
  const userKeysListAfter = await fetch(`${BASE_URL}/api/me/api-keys`, { headers: { 'Cookie': userCookie } });
  const userKeysDataAfter = await userKeysListAfter.json();
  if (userKeysDataAfter.some(k => k.id === revokeKeyId)) throw new Error('User list returned revoked key');
  console.log('[PASS] User list does not return revoked key');

  // admin list API keys -> revoked key SHOULD be listed
  const adminKeysList = await fetch(`${BASE_URL}/api/admin/api-keys`, { headers: { 'Cookie': adminCookie } });
  const adminKeysData = await adminKeysList.json();
  const adminRevokedKey = adminKeysData.find(k => k.id === revokeKeyId);
  if (!adminRevokedKey || adminRevokedKey.status !== 'revoked') throw new Error('Admin list did not return revoked key correctly');
  console.log('[PASS] Admin list returns revoked key correctly');

  // admin patch revoked -> active -> 400
  const adminPatchRevokedToActive = await fetch(`${BASE_URL}/api/admin/api-keys/${revokeKeyId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'Cookie': adminCookie },
    body: JSON.stringify({ status: 'active' })
  });
  if (adminPatchRevokedToActive.status !== 400) throw new Error('Admin was able to patch revoked to active!');
  console.log('[PASS] Admin patch revoked to active rejected');

  return revokeKeyHash;
}

async function configureGatewayRoute() {
  await fetch(`${BASE_URL}/api/admin/providers/${testProviderId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'Cookie': adminCookie },
    body: JSON.stringify({ enabled: true, concurrencyLimit: 10 })
  });

  await fetch(`${BASE_URL}/api/admin/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cookie': adminCookie },
    body: JSON.stringify({ settings: [
      { key: 'mainDomain', value: 'localhost' },
      { key: 'allowUnknownHostFallback', value: 'true' }
    ] })
  });
  const routeRes = await fetch(`${BASE_URL}/api/admin/routes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cookie': adminCookie },
    body: JSON.stringify({
      name: 'Regression Route',
      hostInput: 'reg',
      path: '/v1/chat/completions',
      incomingProtocol: 'openai',
      providerId: testProviderId,
      providerProtocol: 'openai',
      modelId: 'mock-model-1',
      enabled: true
    })
  });
  const routeData = await routeRes.json();
  if (!routeRes.ok) throw new Error('Create route failed: ' + JSON.stringify(routeData));
}

async function testActiveGatewayRequest(activeKey, activeKeyId, userCookie) {
  await configureGatewayRoute();
  await fetch(`${BASE_URL}/api/admin/api-keys/${activeKeyId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'Cookie': adminCookie },
    body: JSON.stringify({ status: 'active' })
  });

  const beforeRes = await fetch(`${BASE_URL}/api/me/usage`, {
    headers: { 'Cookie': userCookie }
  });
  const before = await beforeRes.json();

  const gatewayRes = await fetch(`http://reg.localhost:${new URL(BASE_URL).port}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${activeKey}`,
      'Host': 'reg.localhost'
    },
    body: JSON.stringify({ model: 'ignored-by-route', messages: [{ role: 'user', content: 'hi' }] })
  });
  const gatewayData = await gatewayRes.json();
  if (!gatewayRes.ok || gatewayData.choices?.[0]?.message?.content !== 'mock test') {
    throw new Error('Active API key did not enter configured gateway route: ' + JSON.stringify(gatewayData));
  }

  const afterRes = await fetch(`${BASE_URL}/api/me/usage`, {
    headers: { 'Cookie': userCookie }
  });
  const after = await afterRes.json();
  if (after.totalRequests !== before.totalRequests + 1) {
    throw new Error(`Usage totalRequests did not increase. before=${before.totalRequests} after=${after.totalRequests}`);
  }
  if (!Array.isArray(after.recentLogs) || after.recentLogs.length === 0) {
    throw new Error('Usage recentLogs did not include gateway request');
  }

  const keysRes = await fetch(`${BASE_URL}/api/me/api-keys`, {
    headers: { 'Cookie': userCookie }
  });
  const keys = await keysRes.json();
  const used = keys.find(k => k.id === activeKeyId);
  if (!used || !used.lastUsedAt) throw new Error('API Key lastUsedAt was not updated after successful gateway request');
  console.log('[PASS] Active API Key enters gateway route, usage increases, and lastUsedAt updates');
}

async function testRequestCompletionActionLog(activeKey, username) {
  const prefix = activeKey.substring(0, 8);
  const historyRes = await fetch(`${BASE_URL}/api/admin/logs/action-history/entries?limit=200`, {
    headers: { Cookie: adminCookie }
  });
  const history = await historyRes.json();
  const line = [...history]
    .reverse()
    .map((entry) => entry.line)
    .find((item) => item.includes('Request completed') && item.includes(`apiKey=${prefix}`) && item.includes('host=reg.localhost'));

  if (!line) throw new Error('Action log missing Request completed line for gateway request');
  const requiredParts = [
    `user=${username}`,
    `apiKey=${prefix}`,
    'host=reg.localhost',
    'path=/v1/chat/completions',
    'route=Regression Route',
    'provider=Updated Name',
    'model=mock-model-1',
    'inputTokens=3',
    'outputTokens=4',
    'totalTokens=7',
    'latency='
  ];
  for (const part of requiredParts) {
    if (!line.includes(part)) throw new Error(`Request completed log missing part ${part}: ${line}`);
  }
  if (line.includes(activeKey) || line.includes('keyHash')) {
    throw new Error('Request completed log leaked raw key or keyHash');
  }
  console.log('[PASS] Request completed action log contains user, apiKey prefix, host, route, provider, model, tokens, and latency');
}

async function testDisabledKey(disabledKey) {
  const res = await fetch(`http://reg.localhost:${new URL(BASE_URL).port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${disabledKey}`, 'Host': 'reg.localhost' },
    body: JSON.stringify({ model: 'gpt-3.5', messages: [] })
  });
  if (res.status !== 401) {
    const text = await res.text();
    throw new Error(`Gateway did not reject disabled key with 401. Status: ${res.status}, Body: ${text}`);
  }
  console.log('[PASS] Gateway properly rejected disabled API key');
}

async function testExpiredKey(expiredKey) {
  const res = await fetch(`http://reg.localhost:${new URL(BASE_URL).port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${expiredKey}`, 'Host': 'reg.localhost' },
    body: JSON.stringify({ model: 'gpt-3.5', messages: [] })
  });
  if (res.status !== 401) {
    const text = await res.text();
    throw new Error(`Gateway did not reject expired key with 401. Status: ${res.status}, Body: ${text}`);
  }
  console.log('[PASS] Gateway properly rejected expired API key');
}

async function testRevokedKey(revokedKey) {
  const res = await fetch(`http://reg.localhost:${new URL(BASE_URL).port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${revokedKey}`, 'Host': 'reg.localhost' },
    body: JSON.stringify({ model: 'gpt-3.5', messages: [] })
  });
  const data = await res.json();
  if (res.status !== 401 || !data.error?.message?.includes('API Key 已作废')) {
    throw new Error(`Gateway did not reject revoked key correctly. Status: ${res.status}, Body: ${JSON.stringify(data)}`);
  }
  console.log('[PASS] Gateway properly rejected revoked API key with correct message');
}

async function testInvalidModels() {
  const res1 = await fetch(`${BASE_URL}/api/admin/providers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cookie': adminCookie },
    body: JSON.stringify({
      name: 'Invalid Models',
      manualModels: 'invalid-json'
    })
  });
  if (res1.status !== 400) throw new Error('Server accepted invalid manualModels payload');
  console.log('[PASS] Server rejected invalid manualModels payload');

  const res2 = await fetch(`${BASE_URL}/api/admin/providers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cookie': adminCookie },
    body: JSON.stringify({
      name: 'Invalid Models Shape',
      manualModels: '{"not":"array"}'
    })
  });
  if (res2.status !== 400) throw new Error('Server accepted non-array manualModels payload');
  console.log('[PASS] Server rejected non-array manualModels payload');
}

async function testAndSaveProvider() {
  const testRes = await fetch(`${BASE_URL}/api/admin/providers/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cookie': adminCookie },
    body: JSON.stringify({ openaiBaseUrl: 'http://localhost:4001/v1', apiKey: 'sk-1234' })
  });
  const testData = await testRes.json();
  if (!testData.success) throw new Error('Mock upstream test failed: ' + testData.message);
  console.log('[PASS] Mock upstream test successful, testSessionId:', testData.testSessionId);

  // 0. CREATE provider with anthropic testSession only against OpenAI config -> 400
  const testAntRes = await fetch(`${BASE_URL}/api/admin/providers/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cookie': adminCookie },
    body: JSON.stringify({ anthropicBaseUrl: 'http://localhost:4001', apiKey: 'sk-ant-123' })
  });
  const testAntData = await testAntRes.json();
  
  const createFailRes = await fetch(`${BASE_URL}/api/admin/providers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cookie': adminCookie },
    body: JSON.stringify({
      name: 'No OpenAI Provider',
      openaiBaseUrl: 'http://localhost:4001/v1', // required field
      anthropicBaseUrl: 'http://localhost:4001',
      testSessionId: testAntData.testSessionId,
      timeoutMs: 60000,
      concurrencyLimit: 10
    })
  });
  if (createFailRes.status !== 400) {
    throw new Error('Server allowed creating provider without OpenAI models');
  }
  console.log('[PASS] Server rejected provider creation without OpenAI models');

  // Create valid provider
  const createRes = await fetch(`${BASE_URL}/api/admin/providers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cookie': adminCookie },
    body: JSON.stringify({
      name: 'Dual Protocol Provider ' + Date.now(),
      openaiBaseUrl: 'http://localhost:4001/v1',
      apiKey: 'sk-1234',
      anthropicBaseUrl: 'http://localhost:4001',
      testSessionId: testData.testSessionId,
      timeoutMs: 60000,
      concurrencyLimit: 10
    })
  });
  const createData = await createRes.json();
  if (!createRes.ok) throw new Error('Provider create failed: ' + JSON.stringify(createData));
  console.log('[PASS] Provider created with testSession and manual protocols');

  // get the created provider ID
  testProviderId = createData.id;
}

async function testPatchProvider() {
  if (!testProviderId) throw new Error('No provider ID to test PATCH');

  // 1. PATCH modifying baseUrl but NO testSessionId / manual models -> 400
  const patchFailRes = await fetch(`${BASE_URL}/api/admin/providers/${testProviderId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'Cookie': adminCookie },
    body: JSON.stringify({
      openaiBaseUrl: 'http://new-url.com'
    })
  });
  if (patchFailRes.status !== 400) {
    const text = await patchFailRes.text();
    throw new Error('Server allowed modifying baseUrl without test session/manual models. Status: ' + patchFailRes.status + ' Text: ' + text);
  }
  console.log('[PASS] PATCH rejected baseUrl change without tests/models');

  // 2. PATCH modifying name/timeout/concurrency/enabled ONLY -> Success
  const patchSuccessRes = await fetch(`${BASE_URL}/api/admin/providers/${testProviderId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'Cookie': adminCookie },
    body: JSON.stringify({
      name: 'Updated Name',
      timeoutMs: 120000,
      concurrencyLimit: 20,
      enabled: true
    })
  });
  if (!patchSuccessRes.ok) {
    const d = await patchSuccessRes.text();
    throw new Error('Server rejected metadata-only update: ' + d);
  }
  console.log('[PASS] PATCH allowed metadata-only update successfully');

  // 3. PATCH with mismatched key A vs provider key B -> 400
  const testMismatchRes = await fetch(`${BASE_URL}/api/admin/providers/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cookie': adminCookie },
    body: JSON.stringify({ openaiBaseUrl: 'http://localhost:4001/v1', apiKey: 'sk-different-key' })
  });
  const testMismatchData = await testMismatchRes.json();
  
  const patchMismatchRes = await fetch(`${BASE_URL}/api/admin/providers/${testProviderId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'Cookie': adminCookie },
    body: JSON.stringify({
      testSessionId: testMismatchData.testSessionId
      // omitting apiKey on purpose to force provider key comparison
    })
  });
  if (patchMismatchRes.status !== 400) {
    throw new Error('Server allowed PATCH with testSession using different apiKey than provider');
  }
  console.log('[PASS] PATCH rejected testSession using mismatched apiKey');

  // 4. PATCH with mismatched baseUrl A vs provider baseUrl B -> 400
  const testMismatchUrlRes = await fetch(`${BASE_URL}/api/admin/providers/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cookie': adminCookie },
    body: JSON.stringify({ openaiBaseUrl: 'http://localhost:4001/v1', apiKey: 'sk-1234' })
  });
  const testMismatchUrlData = await testMismatchUrlRes.json();
  
  const patchMismatchUrlRes = await fetch(`${BASE_URL}/api/admin/providers/${testProviderId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'Cookie': adminCookie },
    body: JSON.stringify({
      testSessionId: testMismatchUrlData.testSessionId,
      openaiBaseUrl: 'http://localhost:4001/v2-different' // different from testSession
    })
  });
  if (patchMismatchUrlRes.status !== 400) {
    throw new Error('Server allowed PATCH with testSession using different baseUrl');
  }
  console.log('[PASS] PATCH rejected testSession using mismatched baseUrl');

  // 5. PATCH with no-key testSession but provider has key -> 400
  const testNoKeyRes = await fetch(`${BASE_URL}/api/admin/providers/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cookie': adminCookie },
    body: JSON.stringify({ openaiBaseUrl: 'http://localhost:4001/v1', apiKey: '' })
  });
  const testNoKeyData = await testNoKeyRes.json();
  
  const patchNoKeyRes = await fetch(`${BASE_URL}/api/admin/providers/${testProviderId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'Cookie': adminCookie },
    body: JSON.stringify({
      testSessionId: testNoKeyData.testSessionId
      // provider already has 'sk-1234' key, so this should fail because testSession had no key
    })
  });
  if (patchNoKeyRes.status !== 400) {
    throw new Error('Server allowed PATCH with no-key testSession but provider has a key');
  }
  console.log('[PASS] PATCH rejected no-key testSession when provider has a key');
}

async function regularUserAccess(user) {
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: user.username, password: user.password })
  });
  const data = await res.json();
  if (!res.ok) throw new Error('User login failed: ' + (data.error || JSON.stringify(data)));
  const userCookie = res.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  
  const adminRes = await fetch(`${BASE_URL}/api/admin/providers`, {
    headers: { 'Cookie': userCookie }
  });
  if (adminRes.status !== 403) throw new Error('User fetched admin route without 403');
  console.log('[PASS] Regular user fetching /api/admin/providers -> HTTP 403');
  
  const meRes = await fetch(`${BASE_URL}/api/auth/me`, {
    headers: { 'Cookie': userCookie }
  });
  if (meRes.status === 200) {
    console.log('[PASS] User token is still valid after 403 on admin endpoint.');
  } else {
    throw new Error('User token became invalid.');
  }

  // Verify API Key hash is not leaked
  const keysRes = await fetch(`${BASE_URL}/api/me/api-keys`, {
    headers: { 'Cookie': userCookie }
  });
  const keysData = await keysRes.json();
  if (keysData.length > 0 && keysData[0].keyHash) {
    throw new Error('API Key hash was leaked to regular user!');
  }
  console.log('[PASS] API Key hash is not leaked in /me/api-keys');

  const createKeyRes = await fetch(`${BASE_URL}/api/me/api-keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cookie': userCookie },
    body: JSON.stringify({
      name: 'User Simple Key ' + Date.now(),
      concurrencyLimit: 99,
      expiresAt: new Date(0).toISOString()
    })
  });
  const createKeyData = await createKeyRes.json();
  if (!createKeyRes.ok || !createKeyData.apiKey) {
    throw new Error('Regular user failed to create API key with name only semantics: ' + JSON.stringify(createKeyData));
  }

  const userKeysAfterCreateRes = await fetch(`${BASE_URL}/api/me/api-keys`, {
    headers: { 'Cookie': userCookie }
  });
  const userKeysAfterCreate = await userKeysAfterCreateRes.json();
  const created = userKeysAfterCreate.find(k => k.keyPrefix === createKeyData.apiKey.substring(0, 8));
  if (!created) throw new Error('Created regular user key not found in /me/api-keys');
  if (created.expiresAt) throw new Error('Regular user was able to set expiresAt');
  if (created.concurrencyLimit === 99) throw new Error('Regular user was able to set custom concurrencyLimit');
  const adminKeysRes = await fetch(`${BASE_URL}/api/admin/api-keys`, {
    headers: { 'Cookie': adminCookie }
  });
  const adminKeys = await adminKeysRes.json();
  const adminViewOfCreated = adminKeys.find(k => k.id === created.id);
  if (!adminViewOfCreated) throw new Error('Admin list cannot see user-created API key');
  if (adminViewOfCreated.concurrencyLimit !== 2) {
    throw new Error('Regular user API key did not use system default concurrency');
  }
  if (adminViewOfCreated.expiresAt) throw new Error('Regular user API key stored custom expiresAt');
  console.log('[PASS] Regular user API Key creation ignores admin-only fields and stores defaults');

  const usageRes = await fetch(`${BASE_URL}/api/me/usage`, {
    headers: { 'Cookie': userCookie }
  });
  const usageData = await usageRes.json();
  if (
    !usageRes.ok ||
    usageData.totalRequests !== 0 ||
    usageData.totalTokens !== 0 ||
    usageData.successRate !== 0 ||
    usageData.errorCount !== 0 ||
    usageData.lastRequestAt !== null ||
    !Array.isArray(usageData.apiKeyUsage) ||
    !Array.isArray(usageData.recentLogs)
  ) {
    throw new Error('Regular user usage endpoint did not return stable empty metrics');
  }
  const usageLogsRes = await fetch(`${BASE_URL}/api/me/usage/logs?limit=5`, {
    headers: { 'Cookie': userCookie }
  });
  const usageLogsData = await usageLogsRes.json();
  if (!usageLogsRes.ok || !Array.isArray(usageLogsData.data)) {
    throw new Error('Regular user usage logs endpoint did not return stable data array');
  }
  if (JSON.stringify(usageData).includes('keyHash') || JSON.stringify(usageLogsData).includes('keyHash')) {
    throw new Error('Usage endpoint leaked keyHash');
  }
  console.log('[PASS] Regular user usage endpoints return safe empty metrics');

  return userCookie;
}

async function testChangePassword(user) {
  const loginRes = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: user.username, password: user.password })
  });
  if (!loginRes.ok) throw new Error('User login before password change failed');
  const userCookie = loginRes.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');

  const badChangeRes = await fetch(`${BASE_URL}/api/auth/change-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cookie': userCookie },
    body: JSON.stringify({ oldPassword: 'wrong-password', newPassword: 'Newpassword123!' })
  });
  if (badChangeRes.status !== 400) throw new Error('Password change with wrong old password did not fail');
  console.log('[PASS] Change password rejects wrong old password');

  const goodChangeRes = await fetch(`${BASE_URL}/api/auth/change-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cookie': userCookie },
    body: JSON.stringify({ oldPassword: user.password, newPassword: 'Newpassword123!' })
  });
  const goodChangeData = await goodChangeRes.json();
  if (!goodChangeRes.ok || goodChangeData.passwordHash) throw new Error('Password change with correct old password failed or leaked passwordHash');
  console.log('[PASS] Change password accepts correct old password');

  const oldLoginRes = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: user.username, password: user.password })
  });
  if (oldLoginRes.ok) throw new Error('Old password still works after password change');

  const newLoginRes = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: user.username, password: 'Newpassword123!' })
  });
  if (!newLoginRes.ok) throw new Error('New password does not work after password change');
  console.log('[PASS] Old password rejected and new password accepted');
}

async function testUnknownHostFallback() {
  console.log('\n--- Testing Unknown Host Fallback ---');
  // 1. disable allowUnknownHostFallback
  await fetch(`${BASE_URL}/api/admin/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cookie': adminCookie },
    body: JSON.stringify({ settings: [{ key: 'allowUnknownHostFallback', value: 'false' }] })
  });

  // 2. test unknown host -> should 404
  const res1 = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${pgKey}` },
    body: JSON.stringify({ model: 'gpt-3.5', messages: [] })
  });
  if (res1.status !== 404) throw new Error('Expected 404 for unknown host when fallback disabled, got ' + res1.status);

  // 3. enable allowUnknownHostFallback
  await fetch(`${BASE_URL}/api/admin/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cookie': adminCookie },
    body: JSON.stringify({ settings: [{ key: 'allowUnknownHostFallback', value: 'true' }] })
  });

  // 4. test unknown host -> should still 404 because no wildcard route exists
  const res2 = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${pgKey}` },
    body: JSON.stringify({ model: 'gpt-3.5', messages: [] })
  });
  if (res2.status !== 404) throw new Error('Expected 404 for unknown host when no wildcard route exists, got ' + res2.status);

  // 5. create wildcard route
  const wcRouteRes = await fetch(`${BASE_URL}/api/admin/routes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cookie': adminCookie },
    body: JSON.stringify({
      name: 'Wildcard Route',
      hostInput: '*',
      path: '/v1/chat/completions',
      incomingProtocol: 'openai',
      providerId: testProviderId,
      providerProtocol: 'openai',
      modelId: 'mock-model-1',
      enabled: true
    })
  });
  if (!wcRouteRes.ok) throw new Error('Failed to create wildcard route');
  const wcRouteData = await wcRouteRes.json();
  const wcRouteId = wcRouteData.id;

  // 6. test unknown host -> should hit wildcard route
  const res3 = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${pgKey}` },
    body: JSON.stringify({ model: 'mock-model-1', messages: [{role:'user',content:'hi'}] })
  });
  if (!res3.ok) throw new Error('Expected success for unknown host with wildcard route, got ' + res3.status);

  // clean up
  await fetch(`${BASE_URL}/api/admin/routes/${wcRouteId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'Cookie': adminCookie },
    body: JSON.stringify({ enabled: false })
  });

  console.log('[PASS] Unknown host fallback behavior verified');
}

async function run() {
  mockServer.listen(4001, async () => {
    try {
      await loginAdmin();
      await testActionLogPipeline();
      const user = await createUser();
      const otherUser = await createUser();
      const emptyStatsUser = await createUser();
      
      const userCookieRes = await fetch(`${BASE_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: user.username, password: user.password })
      });
      const userCookie = userCookieRes.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');

      const { activeKey, activeKeyId, disabledKey, expiredKey, revokedKey } = await testApiKeyCRUD(user.id, userCookie);
      pgKey = activeKey; // for testUnknownHostFallback
      
      const otherUserCookieRes = await fetch(`${BASE_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: otherUser.username, password: otherUser.password })
      });
      const otherUserCookie = otherUserCookieRes.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');

      const otherKey = await createSimpleApiKeyForUser(otherUser.id, 'Other User Key ' + Date.now(), otherUserCookie);
      const revokedKeyHash = await testStatusPatching(activeKeyId, otherKey.id, userCookie);
      await testInvalidModels();
      await testAndSaveProvider();
      await testPatchProvider();
      await testActiveGatewayRequest(activeKey, activeKeyId, userCookie);
      await testRequestCompletionActionLog(activeKey, user.username);
      await testUnknownHostFallback();
      await fetch(`${BASE_URL}/api/admin/api-keys/${activeKeyId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Cookie': adminCookie },
        body: JSON.stringify({ status: 'disabled' })
      });
      await testDisabledKey(activeKey);
      await testExpiredKey(expiredKey);
      await testRevokedKey(revokedKeyHash);
      await regularUserAccess(emptyStatsUser);
      await testChangePassword(user);
      
      console.log('\n=== All backend regressions fixed and verified! ===\n');
      process.exit(0);
    } catch (e) {
      console.error('\n[FAIL]', e.message);
      process.exit(1);
    }
  });
}

run();
