# PromptGate v1.0 Release Checklist

## Build & Test Status

- [x] **pnpm build**: PASS. (Successfully compiled all packages without TypeScript errors).
- [x] **docs/realtime-tests.sh**: PASS. (Isolated mock upstream, verified real-time patching of routes, providers, subdomains, and prompt policies without restarting server).
- [x] **docs/test_regression.js**: PASS. (Validates action log test API/history/SSE/file pipeline, request-completion action log fields and redaction, API Key status rejection, active key gateway usage and `lastUsedAt`, unknown-host fallback boundary, `/api/me/usage`, and password-change login behavior).
- [x] **docs/fresh-install-test.sh**: PASS. (Verified zero-to-one bootstrap installation, real multi-line Bash execution, action log test endpoint/history/file output, OpenAI and Anthropic request paths, stream fallback for 429/503/529, Anthropic-to-OpenAI adaptation usage, and no `keyHash` leakage in list payloads).
- [x] **docs/concurrency-tests.js**: PASS. (Mock upstream `maxActive` verifies effective concurrency is `min(globalConcurrencyLimit, provider.concurrencyLimit, apiKey.concurrencyLimit)`, including live API Key concurrency updates for new requests).

## Release Recommendation

**Recommended Action**: **Ready for `v1.0-rc.1`**, with strong confidence for promoting directly to **`v1.0`** after initial production smoke testing behind Caddy.

## API Key Rules

- 普通用户创建 API Key 只需要填写名称，创建成功后完整 Key 只显示一次。
- 普通用户创建的 Key 默认永久有效，不可配置并发限制或过期时间。
- 普通用户创建接口采用兼容策略：额外字段会被忽略；后端绝不使用普通用户传入的 `concurrencyLimit` 或 `expiresAt`。
- 普通用户可以删除/作废自己的 Key。删除后该 Key 立即失效、不可恢复，普通用户列表默认不再显示；如需继续调用，请重新创建新的 API Key。
- 状态说明：
  - status=active：启用中。
  - status=disabled：管理员临时禁用，可由管理员恢复。
  - status=revoked：用户删除/作废，不可恢复。
- 管理员可以看到 revoked Key，但不能恢复 revoked Key。
- 网关拒绝 disabled、revoked、expired Key。
- 管理员可以为任意用户创建 API Key，并可设置并发限制和过期时间。
- 供应商并发是保护上游服务的主控制点，由管理员在供应商管理中配置。
- API Key 并发是防止单个凭证占用过多资源的公平性限制；普通用户使用系统默认值，管理员可覆盖。
- 实际请求并发按全局并发、供应商并发和 API Key 并发共同约束。

## User Flow Verification

- [x] **API Key UX rules verified**: 普通用户列表不暴露所属用户、并发、过期时间或 `keyHash`；管理员列表保留所属用户、并发限制、过期时间、状态和最近使用时间。
- [x] **Ordinary-user limits verified**: 普通用户传入 `concurrencyLimit=99` 和 `expiresAt` 时，后端仍写入系统默认并发且 `expiresAt=null`。
- [x] **Disabled/expired gateway rejection verified**: disabled Key 和 expired Key 请求网关均返回失败；active 且未过期 Key 可进入已配置路由。
- [x] **My Stats empty/data states verified**: 无请求时 `/api/me/usage` 返回 0 指标、`apiKeyUsage: []`、`recentLogs: []`；发起一次请求后 `totalRequests` 增加。
- [x] **Password change verified**: 错误旧密码失败，正确旧密码成功，旧密码不能登录，新密码可以登录；前端成功文案要求重新登录并跳转登录。
- [x] **Concurrency verified**: 自动化脚本使用 mock upstream active counter 证明实际并发为 `min(global, provider, apiKey)`，并证明 API Key 并发修改对新请求实时生效。

### Justification
1. **Security Enforced**: 
   - PromptGate user API Keys use pg_ prefixes, are shown only once at creation, and are stored as hashes. Provider upstream API Keys are encrypted with PROMPTGATE_SECRET and are never returned to the frontend.
2. **Strict Identity Validation**: Admin API key creation now performs strict user existence lookups preventing orphan DB records.
3. **UX and Documentation Sync**: The `fresh-install-test.sh` acts as a definitive zero-to-one guide, explicitly fetching dynamic UUIDs using correct payloads to interact with PromptGate APIs.
4. **Robust Stateful Policies**: The system prompt injections are completely accurate. Built-in policies apply precisely based on protocol, and stateful tracking correctly prevents duplicate injections.

### Known Limitations (v1.0-rc.1)
- **Anthropic Streaming**: v1.0-rc.1 has only fully verified Anthropic non-streaming messages. Anthropic streaming remains minimally tested and should be considered a known limitation in the release candidate until full end-to-end automated streaming assertions are added. (OpenAI streaming is fully verified).

### Known Issues / Next Steps
- **Caddy Setup**: Production requires Caddy for HTTPS and rate limiting, as PromptGate runs natively on HTTP.
- **Large Log Volumes**: Stateful tracking for `once_per_conversation` records into `prompt_injection_records`. At very high scales, this table may need a pruning cron job.
