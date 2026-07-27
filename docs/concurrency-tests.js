const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');

const DB_FILE = '/tmp/promptgate-concurrency.sqlite';
const BASE_URL = 'http://127.0.0.1:3020';
const MOCK_URL = 'http://127.0.0.1:4020';
const SECRET = 'concurrency_secret_for_tests_32_bytes';

let active = 0;
let maxActive = 0;
let gateway;
let mock;
let adminCookie = '';
let adminUserId = '';
let providerId = '';
let apiKeyId = '';
let rawApiKey = '';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cookieFrom(res) {
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}

async function jsonFetch(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  return { res, data };
}

function startMock() {
  mock = http.createServer((req, res) => {
    if (req.url === '/stats') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ active, maxActive }));
      return;
    }
    if (req.url === '/reset') {
      active = 0;
      maxActive = 0;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
      return;
    }
    if (req.url === '/v1/chat/completions') {
      active += 1;
      maxActive = Math.max(maxActive, active);
      setTimeout(() => {
        active -= 1;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'mock-concurrency',
          choices: [{ message: { role: 'assistant', content: 'ok' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }));
      }, 500);
      return;
    }
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'concurrency-model' }] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  return new Promise((resolve) => mock.listen(4020, '127.0.0.1', resolve));
}

function startGateway() {
  try {
    fs.unlinkSync(DB_FILE);
  } catch {}

  gateway = spawn('node', ['apps/server/dist/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DB_FILE,
      PORT: '3020',
      PROMPTGATE_SECRET: SECRET,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('Timed out waiting for gateway admin password')), 15000);

    function onData(chunk) {
      buffer += chunk.toString();
      const match = buffer.match(/管理员密码:\s*([a-f0-9]+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    }

    gateway.stdout.on('data', onData);
    gateway.stderr.on('data', onData);
    gateway.stdout.pipe(process.stdout);
    gateway.stderr.pipe(process.stderr);
    gateway.on('exit', (code) => {
      reject(new Error(`Gateway exited early with code ${code}. Output: ${buffer}`));
    });
  });
}

async function setup(adminPassword) {
  await sleep(500);
  const login = await jsonFetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    body: JSON.stringify({ username: 'admin', password: adminPassword }),
  });
  if (!login.res.ok) throw new Error('Admin login failed: ' + JSON.stringify(login.data));
  adminCookie = cookieFrom(login.res);

  const me = await jsonFetch(`${BASE_URL}/api/auth/me`, {
    headers: { Cookie: adminCookie },
  });
  adminUserId = me.data.id;

  await jsonFetch(`${BASE_URL}/api/admin/settings`, {
    method: 'POST',
    headers: { Cookie: adminCookie },
    body: JSON.stringify({
      settings: [
        { key: 'mainDomain', value: 'localhost' },
        { key: 'allowUnknownHostFallback', value: 'true' },
        { key: 'globalConcurrencyLimit', value: '10' },
      ],
    }),
  });

  const testRes = await jsonFetch(`${BASE_URL}/api/admin/providers/test`, {
    method: 'POST',
    headers: { Cookie: adminCookie },
    body: JSON.stringify({
      openaiBaseUrl: `${MOCK_URL}/v1`,
      apiKey: 'sk-concurrency',
      manualModels: ['concurrency-model'],
    }),
  });
  if (!testRes.res.ok) throw new Error('Provider test failed: ' + JSON.stringify(testRes.data));
  const testSessionId = testRes.data.testSessionId;

  const provider = await jsonFetch(`${BASE_URL}/api/admin/providers`, {
    method: 'POST',
    headers: { Cookie: adminCookie },
    body: JSON.stringify({
      name: 'Concurrency Provider',
      openaiBaseUrl: `${MOCK_URL}/v1`,
      apiKey: 'sk-concurrency',
      manualModels: ['concurrency-model'],
      timeoutMs: 10000,
      concurrencyLimit: 10,
      testSessionId,
    }),
  });
  if (!provider.res.ok) throw new Error('Provider create failed: ' + JSON.stringify(provider.data));
  providerId = provider.data.id;

  const subdomain = await jsonFetch(`${BASE_URL}/api/admin/subdomains`, {
    method: 'POST',
    headers: { Cookie: adminCookie },
    body: JSON.stringify({ name: 'conc' }),
  });
  if (!subdomain.res.ok) throw new Error('Subdomain create failed: ' + JSON.stringify(subdomain.data));

  const endpoint = await jsonFetch(`${BASE_URL}/api/admin/endpoints`, {
    method: 'POST',
    headers: { Cookie: adminCookie },
    body: JSON.stringify({ path: '/v1/chat/completions', incomingProtocol: 'openai', enabled: true }),
  });
  if (!endpoint.res.ok) throw new Error('Endpoint create failed: ' + JSON.stringify(endpoint.data));

  const routes = await jsonFetch(`${BASE_URL}/api/admin/endpoints/${endpoint.data.id}/routes`, {
    headers: { Cookie: adminCookie },
  });
  const route = routes.data.find((r) => r.subdomainId === null) || routes.data[0];
  const patchedRoute = await jsonFetch(`${BASE_URL}/api/admin/routes/${route.id}`, {
    method: 'PATCH',
    headers: { Cookie: adminCookie },
    body: JSON.stringify({
      providerId,
      providerProtocol: 'openai',
      modelId: 'concurrency-model',
      enabled: true,
      status: 'active',
    }),
  });
  if (!patchedRoute.res.ok) throw new Error('Route patch failed: ' + JSON.stringify(patchedRoute.data));

  const key = await jsonFetch(`${BASE_URL}/api/me/api-keys`, {
    method: 'POST',
    headers: { Cookie: adminCookie },
    body: JSON.stringify({ name: 'Concurrency Key' }),
  });
  if (!key.res.ok) throw new Error('API key create failed: ' + JSON.stringify(key.data));
  rawApiKey = key.data.apiKey;

  const keys = await jsonFetch(`${BASE_URL}/api/admin/api-keys`, {
    headers: { Cookie: adminCookie },
  });
  apiKeyId = keys.data.find((item) => item.keyPrefix === rawApiKey.substring(0, 8)).id;
}

async function setLimits({ globalLimit, providerLimit, keyLimit }) {
  await jsonFetch(`${BASE_URL}/api/admin/settings`, {
    method: 'POST',
    headers: { Cookie: adminCookie },
    body: JSON.stringify({ settings: [{ key: 'globalConcurrencyLimit', value: String(globalLimit) }] }),
  });
  await jsonFetch(`${BASE_URL}/api/admin/providers/${providerId}`, {
    method: 'PATCH',
    headers: { Cookie: adminCookie },
    body: JSON.stringify({ concurrencyLimit: providerLimit }),
  });
  const keyPatch = await jsonFetch(`${BASE_URL}/api/admin/api-keys/${apiKeyId}`, {
    method: 'PATCH',
    headers: { Cookie: adminCookie },
    body: JSON.stringify({ concurrencyLimit: keyLimit }),
  });
  if (!keyPatch.res.ok || keyPatch.data.apiKey.concurrencyLimit !== keyLimit) {
    throw new Error('API key concurrency patch failed: ' + JSON.stringify(keyPatch.data));
  }
  await sleep(100);
}

async function runBatch(expectedMax, label, requestCount = 3) {
  await fetch(`${MOCK_URL}/reset`);
  const requests = Array.from({ length: requestCount }, () =>
    fetch(`${BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${rawApiKey}`,
      },
      body: JSON.stringify({ model: 'ignored', messages: [{ role: 'user', content: 'hi' }] }),
    })
  );
  const responses = await Promise.all(requests);
  for (const res of responses) {
    if (!res.ok) {
      const text = await res.text();
      console.error('Gateway request failed:', res.status, text);
      throw new Error(`${label}: one or more gateway requests failed`);
    }
  }
  const stats = await (await fetch(`${MOCK_URL}/stats`)).json();
  if (stats.maxActive !== expectedMax) {
    throw new Error(`${label}: expected maxActive=${expectedMax}, got ${stats.maxActive}`);
  }
  console.log(`[PASS] ${label}: maxActive=${stats.maxActive}`);
}

async function cleanup() {
  if (gateway) gateway.kill('SIGTERM');
  if (mock) await new Promise((resolve) => mock.close(resolve));
  try {
    fs.unlinkSync(DB_FILE);
  } catch {}
}

(async () => {
  try {
    await startMock();
    const adminPassword = await startGateway();
    await setup(adminPassword);

    await setLimits({ globalLimit: 10, providerLimit: 10, keyLimit: 1 });
    await runBatch(1, 'API Key concurrency limit');

    await setLimits({ globalLimit: 10, providerLimit: 1, keyLimit: 10 });
    await runBatch(1, 'Provider concurrency limit');

    await setLimits({ globalLimit: 1, providerLimit: 10, keyLimit: 10 });
    await runBatch(1, 'Global concurrency limit');

    await setLimits({ globalLimit: 10, providerLimit: 10, keyLimit: 1 });
    await runBatch(1, 'API Key concurrency before live update');
    await setLimits({ globalLimit: 10, providerLimit: 10, keyLimit: 2 });
    await runBatch(2, 'API Key concurrency after live update', 4);

    console.log('\n=== Concurrency limits verified: min(global, provider, apiKey) ===\n');
    await cleanup();
    process.exit(0);
  } catch (err) {
    console.error('\n[FAIL]', err.message);
    await cleanup();
    process.exit(1);
  }
})();
