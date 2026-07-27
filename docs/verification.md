# 最终验收文档 (E2E Verification)

本文档记录了一次从空库启动到网关全链路跑通的完整测试流程。

## 0. 生产部署架构说明

PromptGate 定位为**内网网关服务**，在生产环境中推荐以 **Caddy 作为前置反向代理**：

- **Caddy** 负责：HTTPS 证书自动续签（Let's Encrypt）、域名入口、外部安全 Header（HSTS、CSP 等）、基础 DDoS 防护。
- **PromptGate** 负责：多租户路由分发、供应商负载均衡、提示词策略注入、API Key 鉴权、实时配置热更新。

典型部署拓扑：

```text
Internet -> Caddy (HTTPS, :443) -> PromptGate (HTTP, :3000) -> 上游 LLM 供应商
```

PromptGate 默认监听 `127.0.0.1:3000` 或内网端口，不直接暴露到公网。Caddy 配置示例：

```caddyfile
api.example.com {
    reverse_proxy localhost:3000
    header {
        Strict-Transport-Security "max-age=63072000; includeSubDomains; preload"
        X-Content-Type-Options "nosniff"
        X-Frame-Options "DENY"
    }
}
```

## 1. 基础配置准备

假设系统以全新 SQLite 空库启动，默认会生成 `admin` 用户和密码，并可登录后台。

1. **创建二级域名**：在二级域名管理中，创建前缀为 `code` 的子域名，系统（由于 `mainDomain` 为空或本地开发环境）自动生成 `code.localhost`。
2. **创建供应商与测试**：在供应商管理中填入 OpenAI 或 Anthropic 的基础 URL 与 API Key，点击“测试”，保存。
3. **配置端点路由**：
   - 监听路径为 `/v1/chat/completions` (OpenAI 协议)
   - 系统为 `code.localhost` 自动生成占位路由，将其编辑为 `启用`，并关联配置好的供应商和具体模型（如 `gpt-4o`）。

## 2. API 请求验证 (实际执行输出)

### 2.1 基础请求验证与构建结果

```bash
$ cd apps/server && pnpm build && cd ../web && pnpm build
vite v5.3.1 building for production...
✓ 1526 modules transformed.
dist/index.html                   0.45 kB │ gzip:  0.29 kB
dist/assets/index-C751kfP4.js   167.00 kB │ gzip: 53.79 kB
✓ built in 2.32s
```

### 2.2 OpenAI 非流式请求

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Host: code.localhost" \
  -H "Authorization: Bearer pg_test_key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "any",
    "messages": [{"role": "user", "content": "hello"}],
    "stream": false
  }'
```

**实际响应结果**：

```json
{
  "id": "mock-123",
  "choices": [
    { "message": { "role": "assistant", "content": "mock response" } }
  ],
  "mock_received_model": "gpt-4o",
  "mock_received_system": "hi"
}
```

### 2.3 OpenAI 流式请求

**实际响应结果**：返回分段 SSE 数据。

```text
data: {"id":"mock-123","choices":[{"delta":{"content":"mock"}}]}
data: {"id":"mock-123","choices":[{"delta":{"content":" response"}}]}
data: [DONE]
```

### 2.4 Anthropic Messages

```bash
curl http://localhost:3000/v1/messages \
  -H "Host: code.localhost" \
  -H "x-api-key: pg_test_key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "any",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "hello"}]
  }'
```

**实际响应结果**：

```json
{
  "id": "msg_mock-123",
  "type": "message",
  "role": "assistant",
  "content": [{ "type": "text", "text": "mock response" }]
}
```

### 2.5 /v0/messages 支持

请求 `/v0/messages` 的表现完全等价于上述对应的 `/v1` 调用，网关路由机制统一接管。

## 3. 提示词防重复注入 (`once_per_conversation`)

**首次请求 (带会话 ID)**：

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Host: code.localhost" \
  -H "X-Conversation-Id: test-session-1" \
  ...
```

**上游捕获记录**：

```json
{
  "id": "mock-123",
  "choices": [
    { "message": { "role": "assistant", "content": "mock response" } }
  ],
  "mock_received_model": "gpt-3.5-turbo",
  "mock_received_system": "You are a test bot."
}
```

_注：成功注入 `You are a test bot.`_

**第二次请求 (跳过注入)**：
_请求直接发给上游（因 SQLite `prompt_injection_records` 表中已记录该会话该策略，系统不再重复注入）。_

## 4. 实时配置生效验证 (无缝 Reload)

执行自动化集成测试 `docs/realtime-tests.sh` 的真实终端输出如下，证明完全实时生效（不需重启 PM2）。

**测试环境**：隔离临时数据库 `/tmp/promptgate-e2e.sqlite` + 独立 PromptGate 实例（端口 3001），生产数据库 `data/promptgate.sqlite` 完全不受影响。

**验收指标（全部 PASS）**：

- ✅ 模型动态切换（A→B）：`model-a` → `model-b`，mock 上游收到的 `mock_received_model` 字段实时变化
- ✅ 禁用供应商：即时返回 `Provider not found or disabled`
- ✅ 禁用二级域名：即时返回 `Subdomain is disabled`
- ✅ 修改提示词策略：即时注入新的 system prompt
- ✅ 修改 CORS 允许列表：非信任 Origin 的 CORS Header 被剥离
- ✅ 数据库隔离：测试结束后临时 DB 自动删除，生产库 untouched

```text
=== Database Isolation: Copying real DB to temporary test DB ===
Temporary test DB: /tmp/promptgate-e2e.sqlite
Real DB (untouched): ../data/promptgate.sqlite
=== Standing up Mock Upstream ===
Mock upstream running on port 4000
=== Standing up isolated PromptGate instance on port 3001 ===
[PromptGate] Running migrations...
[PromptGate] Migrations completed.
[21:07:53.783] INFO (64521): Server listening at http://0.0.0.0:3001
Isolated PromptGate running on port 3001 with DB: /tmp/promptgate-e2e.sqlite
=== Testing Real-time Configurations ===
Generated ENC_KEY: cae4bf188a48895fb1a8523c:9e83e62955f359f07408727a4e3484cc:161cbdaab3e4e88ba9

[1] Setting initial modelId to model-a and sending initial request...
{"id":"mock-123","choices":[{"message":{"role":"assistant","content":"mock response"}}],"mock_received_model":"model-a","mock_received_system":"hi"}
PASS: Initial model is model-a

[2] Modifying endpoint route modelId from model-a -> model-b...
Done. Next request should use model-b.
{"id":"mock-123","choices":[{"message":{"role":"assistant","content":"mock response"}}],"mock_received_model":"model-b","mock_received_system":"hi"}
PASS: Model dynamically changed from model-a to model-b!

[3] Disabling a provider...
Done. Next request to this provider will fail with 500 Provider disabled.
{"error":{"message":"Provider not found or disabled","type":"server_error","param":null,"code":"server_error"}}
PASS: Provider instantly disabled!

[3.5] Disabling a subdomain...
Done. Next request on 127.0.0.1 will fail with 403 Subdomain disabled.
{"error":{"message":"Subdomain is disabled","type":"invalid_request_error","param":null,"code":"permission_denied"}}
PASS: Subdomain instantly disabled!

[4] Modifying prompt policy content...
Done. Next /v0/chat/completions request will inject 'You are a test bot.'.
{"id":"mock-123","choices":[{"message":{"role":"assistant","content":"mock response"}}],"mock_received_model":"gpt-3.5-turbo","mock_received_system":"You are a test bot."}
PASS: Policy injected instantly!

[5] Modifying CORS allowlist...
Done. Next request from untrusted origin will fail CORS check.
PASS: CORS Header stripped for untrusted origin!

=== Cleaning up ===
Temporary test DB removed: /tmp/promptgate-e2e.sqlite
Isolated PromptGate instance stopped (PID 64487)
All modifications verified! No restarts needed for changes to take effect on new requests!
Real database untouched: ../data/promptgate.sqlite
```

## 5. 关于 CORS 的说明

CORS 仅作为**本地开发辅助机制**，不作为生产部署的核心验收指标。

- **本地开发**：`corsAllowlist` 设置控制 `Access-Control-Allow-Origin` Header，便于前端联调。
- **生产环境**：HTTPS、域名入口、外部安全 Header 均由 Caddy 统一负责（见第 0 节），PromptGate 不再承担 CORS 主线验收职责。

因此本文档不将 CORS 列为核心技术指标，仅保留基础逻辑以兼容本地调试场景。
