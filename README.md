# Yutrix

> Formerly **PromptGate**. Open-source Community edition for cost control, routing, and audit.

<p align="center">
  <img src="./apps/web/public/favicon.svg" width="120" alt="Yutrix Logo" />
</p>

**One self-hosted gateway for OpenAI-compatible and Anthropic-style clients.** Point Claude Code, Cursor, or any compatible SDK at a single URL: Yutrix handles routing, API keys, audit logs, failover, and the admin UI. Clients keep talking the APIs they already know.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D24.16-339933.svg)](./package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6.svg)](https://www.typescriptlang.org/)
[![pnpm](https://img.shields.io/badge/pnpm-workspace-f69220.svg)](https://pnpm.io/)

[中文文档](./README.zh-CN.md) · [Caddy deployment](./docs/deployment-caddy.md) · [Docker Compose (PostgreSQL)](./docker-compose.postgres.example.yml) · [OpenCode sidecar](./docs/opencode-sidecar.md)

Yutrix is a **protocol gateway**, not a model platform and not a model-type switch. One entry, one auth layer, one routing table, one log surface, one failover path.

```text
API Key        -> user identity
Host           -> public entry point
Path + protocol -> request shape
Provider exits -> final upstream protocol
modelId        -> the string written into the request body
```

## Why Yutrix?

A raw reverse proxy gets you through the first week. Then you need keys you can revoke, hostnames per team, Anthropic-shaped requests, a 429 that should hop instead of fail, and logs a human can read. Yutrix keeps that small-proxy mental model and makes it something you can actually run.

### Logo Philosophy

The Yutrix logo features a modern arch or gateway with a central glowing code spark. This symbolizes a powerful, secure, and intelligent portal for LLM prompts, with the blue gradient conveying technology, depth, and reliability.

## Features

What you actually operate day to day:

- **Protocol-aware routing** by Host, path, and OpenAI / Anthropic shape — plus per-route source IP allowlists
- **Cascading funnel failover** with Best Effort model matching when a layer is rate-limited or down
- **Strategy routing** (vision / debug / code / long_context / writing / general) with continuation-aware model lock
- **Response Continuity** so long generations that hit `max_tokens` are stitched instead of truncated
- **Compatibility channel (OpenCode sidecar)** for harness-gated models — clients never see OpenCode
- **Response cache**, prompt policies, user/group input token limits, and tool-loop circuit breaker
- **Admin UI**: keys, providers, routes, audit logs, system info, SQLite or PostgreSQL

### Protocol-aware routing

A route maps:

```text
Host + Path + incoming protocol
  -> provider + modelId + prompt policy + fallback provider
  -> optional source IP allowlist
```

### Source IP restriction

Source restriction is a route-level allowlist, configured in **Edit Routing Rule**.

| Value | Behavior |
| --- | --- |
| empty / unset | No restriction |
| `0.0.0.0/0` or `::/0` | No restriction |
| `203.0.113.10` | Only that address |
| `192.168.1.0/24` | Only that IPv4 subnet |
| `192.168.1.0/24, 10.0.0.1, 2001:db8::/32` | Any listed address or CIDR |

Multiple entries may be separated by commas, semicolons, or newlines. Invalid tokens are rejected when the route is saved. A miss returns the same client-facing `403` shape as a permission denial; it does not skip or alter later funnel hops for requests that *do* match.

Client IP is taken from Fastify `request.ip` (with `trustProxy` and IPv4-mapped `::ffff:` normalization). Do not treat raw `CF-Connecting-IP` / `X-Real-IP` from the client as authoritative.

Example:

```text
Host: code.example.com
Path: /v1/messages
Incoming protocol: Anthropic
Provider: qwen-provider
Model: qwen3.6-plus
```

### OpenAI-compatible and Anthropic-style APIs

| Incoming request | Provider has | Behavior |
| --- | --- | --- |
| OpenAI-compatible | OpenAI-compatible base URL | Direct forwarding |
| Anthropic-style | Anthropic base URL | Direct forwarding |
| Anthropic-style | OpenAI-compatible base URL only | Anthropic -> OpenAI-compatible non-stream adapter |
| OpenAI-compatible | Anthropic base URL only | Not adapted |

The model name itself does not decide the protocol. The route protocol and provider exit capability do.

### Compatibility channel (OpenCode sidecar)

Some upstreams (for example certain OpenRouter free / agentic models) only accept traffic from a recognized harness. Yutrix can send those models through a **managed loopback OpenCode sidecar** without changing the public API.

- Admins enable **兼容通道 / useOpencodeProxy** per provider model.
- API clients stay on normal OpenAI-compatible or Anthropic-style endpoints. They never see OpenCode, and Yutrix does not spoof `Referer` / `X-Title`.
- Keys stay in Yutrix `providerApiKeys` and are mirrored into the sidecar `auth.json` immediately before a call.
- **System Info** installs or updates the sidecar, optional download HTTP proxy (empty means unused), and **auto-update (default ON)** — startup plus a daily check; failures set `lastError` and do not take the gateway down.

Operator notes: [docs/opencode-sidecar.md](./docs/opencode-sidecar.md).

### API key management

Yutrix API keys identify users of the gateway.

- Full keys are shown only once when created.
- The database stores key hashes and prefixes, not raw keys.
- Users manage their own keys.
- Admins can inspect, disable, enable, and audit keys.

### User Groups and Route Authorization

Yutrix supports granular route access control through user groups:

- **Default Group**: Automatically created on first startup. All existing users and routes are automatically assigned to it for backward compatibility.
- **Custom Groups**: Admins can create additional groups, assign users to multiple groups, and remove members from any group, including the default group.
- **Route Authorization**: Each route can be authorized for specific users and/or groups. A user can access a route if they are directly authorized or belong to an authorized group.
- **Automatic Assignment**: New users (registered or admin-created) are automatically added to the default group. New routes default to authorizing the default group.
- **Admin Bypass**: Admin users can access all routes without authorization checks.

This system enables fine-grained access control while maintaining simplicity: most users belong to the default group with full access, while specific users or groups can be restricted to subsets of routes as needed.

### Input Token Limits and Truncation

Yutrix can enforce maximum input token limits before a request is sent upstream:

- **Group default**: Each user group can define `maxInputTokens`. New and existing members inherit it unless they have a user-level override.
- **User override**: Admins can set `maxInputTokensOverride` for a specific user. A non-null user override always wins over group limits.
- **Unlimited value**: `0` means unlimited. A user override of `0` explicitly disables the inherited group limit for that user.
- **Multiple groups**: If a user belongs to multiple groups and has no override, Yutrix applies the strictest positive group limit. If every group limit is `0`, the user is unlimited.
- **Request handling**: If the effective limit is exceeded, Yutrix drops older conversation turns first. If the latest turn alone is too large, it truncates the largest text block with a head-and-tail strategy.
- **Protected context**: System/developer messages, body-level system instructions, tools/functions, and recent tool-call/tool-result chains are preserved as much as possible. If fixed system/tool content already exceeds the budget, the request is rejected with a structured gateway error.
- **Counting strategy**: OpenAI-family estimates use `tiktoken-node` when compatible and `tiktoken` for newer `o200k_base` models such as GPT-4o/GPT-5/o-series. Non-OpenAI models use configured tokenizer repositories when available and fall back to conservative heuristics. Final usage logs still prefer upstream `usage` payloads when providers return them.

### Provider management

Each provider can define:

- OpenAI-compatible base URL;
- Anthropic base URL;
- encrypted upstream API keys;
- model list;
- concurrency limit;
- maximum output token policy.

### Prompt policies

Yutrix supports configurable prompt injection policies for OpenAI-compatible and Anthropic-style request shapes. This is useful for organization-wide system prompts, Claude Code policies, safety constraints, and role presets.

### Concurrency, queueing, and fallback

Yutrix supports layered concurrency limits:

```text
global concurrency
provider concurrency
API-key concurrency
```

Fallback can be triggered when:

- the primary provider queue is full;
- the upstream returns `429`;
- the upstream returns `503`;
- the upstream returns `529`.

Routes use a **cascading funnel** (L0 → L1 → …). A layer hop can be triggered by rate limits, unavailability, or empty output. **Best Effort** matching can look up the originally requested model name on the next provider instead of locking to one hardcoded fallback id.

### Strategy Routing

Strategy Routing is a route-level capability for deterministic, user-input-driven model selection. When enabled, each route owns a small task-to-model map for:

- `vision`: image, screenshot, and visual recognition requests;
- `debug`: errors, timeouts, stack traces, broken behavior, and repair intent;
- `code`: code generation, refactoring, API, component, build, and implementation work;
- `long_context`: long logs, audit records, documents, migrations, summaries, and large inputs;
- `writing`: copy, email, article, translation, rewrite, and polishing tasks;
- `general`: the required fallback when no other task type matches.

#### Decision timing

The gateway classifies the task type and selects the target model **only on real user input** — the equivalent of a user typing a message or uploading an image (the "blue bubble" in audit logs). Between two user inputs, the selected model is locked and never re-classified:

```text
User input (text / image)  →  classify task type  →  select model  →  LOCKED
  Tool results             →  keep current model (no re-classification)
  System-reminders         →  keep current model
  Auto-continuations       →  keep current model
  Title generation         →  keep current model
User input (next message)  →  classify again  →  select model  →  LOCKED
```

This ensures that multi-step agentic workflows (tool-call loops, file edits, terminal commands) never experience mid-task model switching. The model stays consistent from the moment the user sends a request until they send the next one.

#### How it works

The classifier runs locally in the gateway. It extracts the current user input text and checks for image content blocks. Classification is deterministic — it does not call a router LLM, does not create semantic cache entries, and does not depend on model self-description.

For continuation requests (tool results, system-reminders, auto-generated titles, etc.), the gateway looks up the model used in the previous turn via the session matching engine and inherits it. If no previous model is found, the current model is kept as-is.

If a matched strategy model is no longer enabled or available, Yutrix safely keeps the request on the route's current target model. Route schedules still cover time-based target and fallback overrides. Strategy Routing runs inside the normal queueing, fallback, protocol adaptation, token accounting, action log, and audit log pipeline.

#### Long Context Override Safety Net

Yutrix implements a robust, first-principles safety net for context window limits. If the requested target model has a configured `maxOutputTokens` (which doubles as the physical context ceiling for dynamic-output models like Kimi) and the incoming request (plus any injected prompt policies) exceeds this limit, the gateway intercepts the request *before* hitting the upstream API. 

It will automatically override the decision and seamlessly route the massive request to the `long_context` task model (e.g., `qwen3.7-plus`), preventing a guaranteed `400 Bad Request` context length exceeded error while preserving upstream API key cursors and fallback strategies. This operates orthogonally to the Response Continuity Engine, meaning extreme continuation requests that breach the original model's capacity are smoothly handed off to the long-context model for completion.

### Smart Session Merging

Yutrix features an advanced heuristic engine to logically group disparate API requests into cohesive, human-readable sessions. If a client does not send an explicit `X-Server-Session-Id` header, Yutrix determines the correct session through an ordered cascade. Strong deterministic signals are checked first; weaker heuristics run only if every earlier layer misses:

0. **Client Session ID**: Matches `X-Client-Session-Id`, `X-Conversation-Id`, or `X-Session-Id` when clients provide one.
1. **Previous Assistant Hash**: Matches the exact cryptographic hash of the assistant's previous response, handling truncation and stripping of reasoning tokens. Best for tools that send full conversation histories (e.g., standard API clients, basic Web UIs).
2. **Conversation Root Hash**: Matches the SHA-256 hash of the initial system and user messages. Highly resilient to tool calls and intermediate branching. Best for AI coding assistants that maintain a stable root context.
3. **Identical Input Fingerprint**: Matches identical user inputs within a 30-minute window. Resolves retry storms and non-conversational single-shot tasks.
4. **Embedded Prompt Fingerprint**: Matches exact user intent embedded inside nearby generated titles, summaries, or delegated tool-call prompts. This is client-agnostic: it compares normalized fingerprints, not client names or tool names.
5. **Context Overlap**: Uses recent conversation content as a safety net when dynamic system prompts break root hashes.
6. **Recent Activity Fallback**: Merges unambiguous continuation requests, such as isolated tool-use responses or background title-generation calls, into the user's most recent active session within the last 5 minutes.
7. **Background Heuristic**: Last-resort handling for orphan single-shot background prompts. This is intentionally the weakest layer and runs only after all stricter checks fail.

### Token Usage Quality Score (TUQS 2.0)

Yutrix evaluates developer prompt proficiency without accessing user business code, by relying purely on physical gateway telemetry. The score is calculated based on 5 core metrics:

1. **Context Spike Rate**: Detects when `promptTokens[n] > promptTokens[n-1] * 5` within the same `sessionTitle`, and `completionTokens[n]` is very short (< 200). A high rate indicates the user is blindly dumping huge, unoptimized text. (Lower is better)
2. **Stream Abort Rate**: The ratio of aborted requests to total requests (`Aborted Requests / Total Requests`), determined by `isAborted = true` when the client disconnects before the stream naturally ends. A high rate indicates poor prompt intent control. (Lower is better)
3. **Prefix Cache Efficiency**: Calculates the ratio of cached tokens (`SUM(cachedTokens) / SUM(promptTokens)`). `cachedTokens` is extracted from the upstream `usage` payload (e.g., `cached_tokens` for OpenAI or `cache_read_input_tokens` for Anthropic). (Higher is better)
4. **Thrashing & Retry Loops**: Penalizes > 4 requests within a 5-minute rolling window under the same `sessionTitle`, where the `promptTokens` variance is < 5% between calls, but output is aborted or very short. This pattern indicates "gambling" with the AI model. (Lower is better)
5. **TTFT Penalty**: Compares the user's average Time To First Token (`ttftMs`) against the team baseline. A significantly higher average TTFT penalizes the score, indicating bloated context. (Lower is better)

### Human-readable realtime logs

Action logs are written as one-line Chinese operational events and are emitted to:

- stdout / PM2 logs;
- the realtime logs page over SSE;
- in-memory history;
- `data/action.log`.

Example:

```text
2026-06-02 13:20:01 信息 请求完成 requestId=req_xxx 用户=test APIKey=pg_abcd Host=code.example.com 路径=/v1/messages 路由=ClaudeCode 供应商=ProviderA 模型=qwen3.6-plus 状态=200 输入Token=10 输出Token=20 总Token=30 耗时=1234ms 排队=0ms 降级=否
```

### Playground

The Playground helps users generate and test:

- `curl` requests;
- OpenAI-compatible calls;
- Anthropic-style calls;
- Claude Code `settings.json`;
- API-key based examples.

Because full API keys are only shown once, Playground asks users to paste their own `pg_` key instead of fetching it from the server.

## Architecture

Typical production deployment:

```text
Internet
  -> HTTPS / Caddy
  -> Yutrix on 127.0.0.1:3001
  -> upstream LLM providers
```

Yutrix is a single service:

- admin web console;
- admin API;
- gateway API;
- realtime logs;
- SQLite-backed persistence (default) or optional PostgreSQL (14+).

Recommended:

- let Caddy terminate HTTPS;
- keep Yutrix bound to `127.0.0.1`;
- preserve the original `Host` header;
- do not expose the Yutrix port directly to the public internet;
- run the service as a non-root user (e.g., `yutrix`).

## Quick Start

### Docker (Recommended)

> Thanks to [Arthur](https://github.com/arthur-studio) for providing the Dockerfile and startup commands.

Three commands to get started with the default SQLite setup:

```bash
mkdir -p /opt/promptgate/data
```

```bash
# Preferred container name for new deploys: yutrix (legacy name `promptgate` still fine).
# Keep the volume at /opt/promptgate/data for compatibility with existing data.
docker run -d \
  --name yutrix \
  --restart unless-stopped \
  -p 3000:3000 \
  -v /opt/promptgate/data:/app/data \
  -e NODE_ENV=production \
  -e HOST=0.0.0.0 \
  -e PORT=3000 \
  -e DB_FILE=/app/data/promptgate.sqlite \
  -e ACTION_LOG_FILE=/app/data/action.log \
  -e PROMPTGATE_SECRET=$(openssl rand -hex 32) \
  -e LOG_LEVEL=info \
  ghcr.io/yutrix-ai/yutrix:latest
```

```bash
docker logs -f yutrix
```

#### First Startup & Setup Wizard

- **Web Setup Wizard (`/setup`)**: On a fresh install without preset admin credentials, Yutrix starts in setup mode and outputs:
  ```text
  [PromptGate] Fresh installation detected. Open http://<host>:3000/setup to finish installation.
  ```
  Open `/setup` in your browser to choose your database engine (SQLite or PostgreSQL), set your admin username and password, and configure your primary gateway domain.
- **Unattended Mode (Environment Variables)**: To skip the web setup wizard and bootstrap directly into production, provide the following environment variables:
  - `YUTRIX_ADMIN_USER=admin`
  - `YUTRIX_ADMIN_PASSWORD=your_secure_password`
  - `YUTRIX_MAIN_DOMAIN=gateway.example.com`
  - `PROMPTGATE_SECRET=$(openssl rand -hex 32)`
  - (Optional) `DATABASE_URL=postgres://user:password@host:5432/dbname` (boots directly with PostgreSQL).
- **Existing Deployments (Seamless Upgrade)**: Existing installations with data in SQLite continue working seamlessly. Upgrades never enter `/setup`, never rewrite your config, and preserve all existing admin accounts and routes.

#### Docker Compose with PostgreSQL (Optional)

For production deployments requiring PostgreSQL 16 instead of embedded SQLite, see the [Docker Compose PostgreSQL Example](./docker-compose.postgres.example.yml):

```bash
cp docker-compose.postgres.example.yml docker-compose.yml
# Adjust passwords and secrets in docker-compose.yml
docker compose up -d
docker compose logs -f yutrix
```

#### Image tags

| Branch | Tag |
| --- | --- |
| `main` | `latest` |
| other branches | branch name (e.g. `dev`, `feature-xxx`) |

### Manual Install

#### Requirements

- Node.js `>= 24.16.0`
- pnpm
- SQLite (default, zero configuration) or PostgreSQL 14+ (optional)

#### Install

```bash
git clone https://github.com/yutrix-ai/yutrix.git
cd yutrix
pnpm install
```

#### Configure

```bash
cat > .env <<EOF
NODE_ENV=production
HOST=127.0.0.1
PORT=3001
DB_FILE=/opt/promptgate/data/promptgate.sqlite
PROMPTGATE_SECRET=$(openssl rand -hex 32)
LOG_LEVEL=info
EOF
```

#### Build and start

```bash
pnpm build
pm2 start ecosystem.config.cjs --update-env
pm2 logs promptgate-server
```

On first startup of a fresh installation, visit `http://127.0.0.1:3001/setup` to finish the setup wizard, or supply the unattended environment variables (`YUTRIX_ADMIN_USER`, `YUTRIX_ADMIN_PASSWORD`, `YUTRIX_MAIN_DOMAIN`, `PROMPTGATE_SECRET`).

### Upgrading

To upgrade an existing manual installation to the latest version:

```bash
git pull
pnpm install
pnpm build
pm2 restart promptgate-server
```

For Docker deployments, pull the new image and recreate the container while keeping the same mounted data directory:

```bash
docker pull ghcr.io/yutrix-ai/yutrix:latest
docker stop yutrix
docker rm yutrix
# run the same docker run command as above, with the same /app/data volume
```

*Note: Database migrations (schema updates) for the currently active database engine (SQLite or PostgreSQL) are applied automatically when the application starts up.* This release moves routing to Strategy Routing. The migration adds route-level `strategyRoutingEnabled` / `strategyRoutingRules`, removes the old LLM handoff columns and per-model routing guideline column, and drops the old routing cache table. Existing fixed routes continue to work with Strategy Routing disabled until you configure it.

> [!IMPORTANT]
> **No Automatic SQLite → PostgreSQL Data Migration on Upgrade**: Upgrades will NOT automatically move existing SQLite data to PostgreSQL. Yutrix continues using SQLite by default. If you wish to migrate to PostgreSQL, see [Database Configuration & Migration](#database-configuration--migration-sqlite--postgresql).

## Example Requests

### OpenAI-compatible

```bash
curl https://token.example.com/v1/chat/completions \
  -H "Authorization: Bearer pg_your_api_key_here" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "auto",
    "messages": [
      { "role": "user", "content": "hello" }
    ],
    "stream": false
  }'
```

### Anthropic-style

```bash
curl https://code.example.com/v1/messages \
  -H "x-api-key: pg_your_api_key_here" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "auto",
    "max_tokens": 1024,
    "messages": [
      { "role": "user", "content": "hello" }
    ]
  }'
```

The public hostname is part of routing. If you call Yutrix through a shared domain or local proxy, preserve or override the `Host` header accordingly.

## Reverse Proxy (SSE Optimization)

When exposing Yutrix to the internet, it is highly recommended to disable proxy buffering for the API endpoints (`/v1/*`, `/v0/*`) to ensure Server-Sent Events (SSE) and streaming responses are instantly delivered to clients without being delayed by compression or proxy buffers. This prevents `499 Client Closed Request` timeouts caused by large LLMs taking a long time to think.

### Caddy Recommended Configuration

```caddyfile
pg.example.com, code.example.com, token.example.com {
    # 1. Exclude API endpoints from compression to prevent buffer blocking
    @compress {
        not path /v1/*
        not path /v0/*
    }
    encode @compress gzip zstd

    # 2. Reverse proxy configuration
    reverse_proxy 127.0.0.1:3001 {
        # Disable response buffering completely for instant SSE delivery
        flush_interval -1
        
        header_up Host {host}
        header_up X-Real-IP {remote_host}
        header_up X-Forwarded-For {remote_host}
        header_up X-Forwarded-Proto {scheme}
    }
}
```

### Nginx Recommended Configuration

```nginx
server {
    listen 443 ssl;
    server_name pg.example.com code.example.com token.example.com;
    
    # ... your SSL configs ...

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # API endpoints specific optimization for SSE
    location ~ ^/(v1|v0)/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # Disable buffering and compression for SSE
        proxy_buffering off;
        proxy_cache off;
        gzip off;
        
        # Extend read timeout for slow-thinking models (e.g. gemma-31b, o1)
        proxy_read_timeout 300s;
    }
}
```

See [docs/deployment-caddy.md](./docs/deployment-caddy.md) for more details.

## Database Configuration & Migration (SQLite & PostgreSQL)

Yutrix supports two relational database backends:
- **SQLite** (default): Embedded, zero-configuration database stored at `data/promptgate.sqlite` (configurable via `DB_FILE`). Recommended for most single-instance deployments and quick starts.
- **PostgreSQL 14+** (optional): Production client-server database configured via `DATABASE_URL` (e.g. `postgres://user:pass@host:5432/dbname`) or `data/yutrix.config.json`. Tested on PostgreSQL 16.

### Configuration Precedence
Database settings are loaded in the following order of priority:
1. **Environment Variables**: `DATABASE_URL` (if set, forces driver to PostgreSQL) or `DB_FILE` (for SQLite).
2. **Persistent Config File**: `data/yutrix.config.json` (written by the `/setup` wizard or migration pipeline, permissions `0600`).
3. **Built-in Defaults**: SQLite with database file at `data/promptgate.sqlite`.

### Migration from SQLite to PostgreSQL
Existing deployments running on SQLite can be copied to PostgreSQL with zero data loss:

1. **Via Web Console (Recommended)**:
   - Go to **Settings → Database** in the Admin Console.
   - Enter your target PostgreSQL connection string and click **Test Connection**.
   - Click **Migrate to PostgreSQL**.
   - Yutrix automatically:
     - Enters maintenance mode: gateway calls to `/v1/*` and `/v0/*` return `503 Service Unavailable` with `Retry-After: 30`, and non-migration admin writes are temporarily blocked (route `enabled` states remain unchanged).
     - Gracefully drains in-flight requests (default 60 seconds).
     - Applies PostgreSQL schema migrations.
     - Batch-copies all tables in chunks (converting booleans, normalizing unix timestamps, preserving raw JSON text and encrypted keys byte-for-byte, and filtering out temporary maintenance keys).
     - Verifies table row counts and admin credentials.
     - Writes `driver: "postgres"` and the database URL into `data/yutrix.config.json`.
     - Exits maintenance mode.
     - **Leaves the source SQLite database file completely intact as a rollback backup.**
   - Restart the Yutrix process or container (`pm2 restart promptgate-server` or `docker restart yutrix`) to boot onto PostgreSQL.

2. **Via CLI**:
   Run the copy pipeline offline via the CLI:
   ```bash
   pnpm --filter @promptgate/server db:copy --to-url postgres://user:password@host:5432/yutrix
   ```

> [!WARNING]
> - **No PG → SQLite Reverse Migration**: Migration is one-way from SQLite to PostgreSQL. Reverse migration is **NOT** supported.
> - **No Automatic Data Move on Upgrade**: Standard updates only apply schema migrations for the currently active database engine; they will never move your data behind the scenes.
> - **Preserve `PROMPTGATE_SECRET`**: Encrypted upstream provider credentials depend on `PROMPTGATE_SECRET`. Never change this secret during or after migration.

### Database Backups
- **SQLite**: Administrators can download SQLite database backups directly from the Web Console (**Settings → Database**) when `DB_BACKUP_PASSWORD` is configured.
- **PostgreSQL**: Web download is intentionally disabled when running on PostgreSQL. Use standard PostgreSQL tooling (e.g., `pg_dump`):
  ```bash
  pg_dump -Fc -h localhost -U yutrix -d yutrix > yutrix_backup.dump
  ```

### Operational Note: Large Tables & pgloader
For emergency ops or massive historical request log tables (millions of rows), `pgloader` with `DATA ONLY` can be used as an offline batch loader *after* Yutrix has generated the target PostgreSQL schema tables via `migratePg`.
*Note: `pgloader` is an external operations tool, NOT a product dependency, and is not included in the UI. Never run `pgloader` with table creation enabled (`create tables` is prohibited as it creates incompatible schema types).*

## Configuration

Important environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `NODE_ENV` | `production` | Runtime environment |
| `HOST` | `127.0.0.1` | Listen address |
| `PORT` | `3000` | Listen port |
| `DATABASE_URL` | none | PostgreSQL connection string (`postgres://...`). If set, activates PostgreSQL driver |
| `DB_FILE` | `data/promptgate.sqlite` | SQLite database path (used when driver is SQLite) |
| `PROMPTGATE_SECRET` | none | Secret used to encrypt upstream provider API keys (required in production) |
| `DB_BACKUP_PASSWORD` | none | Password required to authorize database downloads in SQLite mode |
| `LOG_LEVEL` | `info` | Server log level |
| `ACTION_LOG_FILE` | `data/action.log` | Action log file |
| `NODE_INTERPRETER` | `node` | Node executable used by PM2 |
| `YUTRIX_ADMIN_USER` | none | Unattended setup: initial admin username |
| `YUTRIX_ADMIN_PASSWORD` | none | Unattended setup: initial admin password |
| `YUTRIX_MAIN_DOMAIN` | none | Unattended setup: primary gateway domain |

`PROMPTGATE_SECRET` is required in production. Keep it stable and backed up; losing it can make encrypted provider credentials unrecoverable.

### Database Backup Security Configuration

For security compliance and to enforce **Separation of Duties (SoD)**, Yutrix decouples application administration from raw database custody:
* When running on SQLite: database backup downloading is **disabled** by default. To enable it, set `DB_BACKUP_PASSWORD` (64-character hex string). Administrators must enter this password in the console UI to download the SQLite backup file.
* When running on PostgreSQL: web backup download is disabled; operators should use `pg_dump`.

## Project Structure

```text
Yutrix/
├── apps/
│   ├── server/          # Fastify backend, gateway, admin APIs, SSE logs
│   └── web/             # React + Vite admin console
├── packages/
│   └── shared/          # Shared types and validation
├── data/                # SQLite database (if SQLite), yutrix.config.json, and action.log
├── docs/                # Deployment and regression docs
├── scripts/             # Operational scripts
├── ecosystem.config.cjs # PM2 configuration
├── pnpm-workspace.yaml
└── package.json
```

## Use Cases

- expose different routes for Claude Code, OpenAI-compatible clients, and internal tools;
- manage user-owned gateway API keys;
- route multiple public hostnames to different providers and models;
- keep upstream provider credentials hidden from users;
- observe requests with human-readable action logs;
- apply fallback for rate limits and overloads;
- test route configuration from the admin console.

## Roadmap

Planned or likely follow-up work:

- richer streaming support for protocol adapters;
- more detailed analytics and cost reporting;
- external queue/state backends for multi-instance deployments;
- import/export for route and provider configuration;
- more documentation for production hardening.

## Contributing

Issues and pull requests are welcome.

For code changes:

```bash
pnpm build
pnpm --filter @promptgate/server test
```

Please keep changes focused and include enough context in your PR for maintainers to reproduce the behavior.

## Documentation

- [Editions overview (Community vs commercial)](./docs/editions.md)
- [中文完整文档](./README.zh-CN.md)
- [Caddy deployment guide](./docs/deployment-caddy.md)
- [Fresh install test](./docs/fresh-install-test.md)
- [Realtime logging notes](./docs/realtime-config.md)
- [Release checklist](./docs/release-checklist.md)

## License

Yutrix is released under the [MIT License](./LICENSE).

Copyright (c) 2026 Tom Wu.
