# Yutrix（驭算）

> Formerly **PromptGate**. Open-source Community edition for cost control, routing, and audit.

<p align="center">
  <img src="./apps/web/public/favicon.svg" width="120" alt="Yutrix Logo" />
</p>

**Yutrix (formerly PromptGate) is a lightweight LLM protocol gateway and admin console for OpenAI-compatible and Anthropic-style APIs.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D24.16-339933.svg)](./package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6.svg)](https://www.typescriptlang.org/)
[![pnpm](https://img.shields.io/badge/pnpm-workspace-f69220.svg)](https://pnpm.io/)

[中文文档 / Chinese documentation](./README.zh-CN.md) | [Caddy deployment guide](./docs/deployment-caddy.md)

Yutrix focuses on the gateway layer of LLM applications: one entry point, one authentication layer, one routing system, one logging surface, and one fallback path. It is not trying to reinvent a full model platform.

It gives you a deployable control plane for:

- routing requests by `Host`, path, and protocol;
- validating Yutrix API keys;
- replacing upstream provider API keys;
- rewriting the request `model` field from route configuration;
- forwarding OpenAI-compatible and Anthropic-style requests;
- adapting Anthropic requests to OpenAI-compatible upstreams when needed;
- enforcing global, provider, and API-key concurrency limits;
- applying prompt injection policies;
- enforcing per-user and per-group maximum input token policies;
- collecting token, latency, user, route, provider, and model logs;
- seamlessly auto-stitching responses that hit max token limits via the **Response Continuity Engine**;
- returning a configurable model discovery list via `/v1/models` for third-party client compatibility;
- failing over when an upstream is rate-limited, overloaded, or unavailable.

Yutrix is a **protocol gateway**, not a model-type gateway.

```text
API Key        -> user identity
Host           -> public entry point
Path + protocol -> request shape
Provider exits -> final upstream protocol
modelId        -> the string written into the request body
```

## Why Yutrix?

LLM applications often start with a simple proxy and quickly run into operational needs:

- multiple upstream providers;
- separate public hostnames for different clients;
- API-key ownership and revocation;
- route-specific models;
- Claude Code / Anthropic-style request compatibility;
- transparently handling large code-generation tasks that hit physical `max_tokens` limits (Response Continuity);
- failover when a popular backend returns 429 Too Many Requests;
- request logs that are readable by humans;
- a UI for configuration instead of hand-editing runtime files.

Yutrix keeps the small-proxy mental model, but turns it into a configurable, observable, and production-deployable gateway.

### Logo Philosophy

The Yutrix logo features a modern arch or gateway with a central glowing code spark. This symbolizes a powerful, secure, and intelligent portal for LLM prompts, with the blue gradient conveying technology, depth, and reliability.

## Features

### Recent Updates
- **Advanced Target Matrix & Cascading Funnel Routing**: Replaced the single fallback provider logic with an advanced target matrix (grid) per route. Administrators can now configure true multi-layered cascading failover (e.g., Layer 1 -> Layer 2 -> Layer 3) when upstream providers experience rate limits (429) or unavailability (503).
- **"Best Effort" Model Matching**: Added a new "Best Effort" mode for fallback targets. Instead of hard-locking to a pre-configured model, the gateway intelligently scans the fallback provider for a model sharing the same name as the originally requested model, preserving user intent across provider transitions.
- **Provider Model Aliases**: Models can now be assigned a display alias. This alias gracefully appears in the Admin UI, LLM Audit Logs, and automated DingTalk usage reports, while the gateway continues to use the actual model ID (e.g., `gpt-4o`) for strict protocol adherence with upstreams.
- **Model Discovery List**: The `/v1/models` endpoint now returns a fully configurable model list that is **completely independent** of the system's actual provider models. This ensures maximum compatibility with third-party clients (Claude Desktop, opencode, Codex CLI, etc.) by advertising well-known official model IDs. Admins configure separate OpenAI and Anthropic model lists via a dialog in the Routes page. Enabled by default with sensible defaults (`gpt-4.1`, `o3`, `claude-opus-4-20250918`, etc.).
- **Continuation-Aware Model Locking**: Strategy Routing now distinguishes real user input from tool results, system-reminders, and auto-continuations. The model is decided once on each genuine user message (text or image upload) and stays locked until the next user message arrives — no mid-task model switching during tool-call loops, agentic workflows, or background requests.
- **User / Group Input Token Limits**: Admins can now configure a default maximum input token limit on user groups and override it per user. `0` means unlimited. When a request exceeds the effective limit, Yutrix applies a conservative sliding-window truncation strategy before calling the upstream model, preserving system/developer messages and recent tool-call context whenever possible.
- **Strategy Routing**: Routes can now use deterministic task-type routing instead of LLM-driven handoff. Yutrix classifies the current user input locally into `vision`, `debug`, `code`, `long_context`, `writing`, or `general`, then forwards the request to the model configured for that task type with no extra LLM call, cache lookup, or preflight delay.
- **Route Scheduling (路由计划)**: Allows administrators to configure recurring weekly time-based overrides for route configurations. During active periods, the gateway automatically switches to scheduled models, fallback providers, and Best Effort options. The interface automatically calculates next-day cross-midnight indicators and includes a detailed tooltipped instruction manual.
- **AI Client Detection**: Automatically identifies the AI coding client (e.g., Claude Code, Cursor, OpenCode, Xcode, Augment Code) via heuristic analysis of request headers, paths, and prompt signatures. Detected clients are displayed as color-coded brand badges in the Audit Logs UI. Legacy data or unrecognized clients gracefully degrade by showing no badge.
- **Response Cache** — A response caching mechanism that lets administrators pin specific user inputs to pre-defined responses:
  - In the LLM Audit Logs, admins can click a cache button on any conversation turn to cache the user's input and the model's full response (including reasoning)
  - When any subsequent request matches a cached user input (matched by the normalized user input text, not the full agent context), the gateway returns the cached response instantly — zero tokens, zero latency, zero upstream API calls
  - Works across all clients (curl, Claude Code, Cursor, etc.) because matching is based on the extracted user input, not the full request body
  - Cache management page to view all entries, hit counts, last hit time, and delete entries
  - Cached responses are marked with a "Cache Hit" badge in audit logs and follow the normal session merging behavior
- **System Information & Database Management**: Added a comprehensive system information panel to the Settings page, displaying application, memory, and host machine details. Also introduced the ability to view SQLite database file information and download backups directly from the admin console.
- **Audit Logs UI Redesign & Markdown Support**: Redesigned the LLM Audit Logs interface with a new interactive minimap, persistent auto-scroll toggles, and lightweight markdown rendering for assistant outputs, making it much easier to review long conversations.
- **Thinking Models Compatibility**: Added gateway-level support for OpenAI-compatible "Thinking" models (e.g., DeepSeek-R1, Qwen). Yutrix now automatically strips `reasoning_content` from both stream and non-stream responses before sending them to the client, preventing naive LLM clients from crashing while still preserving the content for internal audit logs.
- **LLM Audit Logs & Smart Session Merging**: Intelligently merges multi-turn and tool-call loops (e.g., from Claude Code, Cursor, Augment Code) into cohesive sessions using a robust 4-priority fallback system. Also includes an **Audit Exemption** feature to completely bypass logging for specific privileged users.
- **Admin UI & Sidebar Improvements**: Refactored the admin sidebar with persistent expanded states, logical grouping, and a new quick access section for the Dashboard.
- **User Groups & Route Authorization**: Added user group management with a default group. Routes can now be authorized for specific users and groups, with automatic backward-compatible migration for existing deployments.
- **Global Analytics Timeframe UI**: Introduced a sleek, fully internationalized top-bar dropdown for global time range filtering, along with customizable analytics boundaries (start of day/week) in settings.
- **Webhook / IM Notifications (e.g., DingTalk)**: Send automated daily usage reports to IM groups, with support for custom Cron schedules, excluded users, and internationalized (i18n) push languages.
- **Login Security & i18n**: Fully internationalized login page featuring a modern "Keep me logged in" option.

### Protocol-aware routing

A route maps:

```text
Host + Path + incoming protocol
  -> provider + modelId + prompt policy + fallback provider
```

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

Fallback is intentionally single-level. If the fallback provider is also busy, the request waits in the fallback provider queue instead of cascading through more providers.

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
- SQLite-backed persistence.

Recommended:

- let Caddy terminate HTTPS;
- keep Yutrix bound to `127.0.0.1`;
- preserve the original `Host` header;
- do not expose the Yutrix port directly to the public internet;
- run the service as a non-root user (e.g., `yutrix`).

## Quick Start

### Docker (Recommended)

> Thanks to [Arthur](https://github.com/arthur-studio) for providing the Dockerfile and startup commands.

Three commands to get started:

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

First startup prints admin username, password, and invite code.

#### Image tags

| Branch | Tag |
| --- | --- |
| `main` | `latest` |
| other branches | branch name (e.g. `dev`, `feature-xxx`) |

### Manual Install

#### Requirements

- Node.js `>= 24.16.0`
- pnpm
- SQLite

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

On first startup, Yutrix initializes the SQLite database and prints:

- the initial admin username;
- the initial admin password;
- an invite code.

Change the admin password after first login.

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

*Note: Database migrations (schema updates) are applied automatically when the application starts up.* This release moves routing to Strategy Routing. The migration adds route-level `strategyRoutingEnabled` / `strategyRoutingRules`, removes the old LLM handoff columns and per-model routing guideline column, and drops the old routing cache table. Existing fixed routes continue to work with Strategy Routing disabled until you configure it.

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

## Configuration

Important environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `NODE_ENV` | `production` | Runtime environment |
| `HOST` | `127.0.0.1` | Listen address |
| `PORT` | `3000` | Listen port |
| `DB_FILE` | `data/promptgate.sqlite` | SQLite database path |
| `PROMPTGATE_SECRET` | none | Secret used to encrypt upstream provider API keys |
| `DB_BACKUP_PASSWORD` | none | Password required to authorize database downloads |
| `LOG_LEVEL` | `info` | Server log level |
| `ACTION_LOG_FILE` | `data/action.log` | Action log file |
| `NODE_INTERPRETER` | `node` | Node executable used by PM2 |

`PROMPTGATE_SECRET` is required in production. Keep it stable and backed up; losing it can make encrypted provider credentials unrecoverable.

### Database Backup Security Configuration

For security compliance and to enforce **Separation of Duties (SoD)**, Yutrix decouples application administration from raw database custody:
* By default, database backup downloading is **disabled** (the download button and input field are hidden, and API calls return `403 Forbidden`).
* To enable this feature, define the `DB_BACKUP_PASSWORD` environment variable (or configure it in your `.env` file).
* Once configured, administrators must enter the correct verification password in the console UI to activate and download the SQLite backup file.

## Project Structure

```text
Yutrix/
├── apps/
│   ├── server/          # Fastify backend, gateway, admin APIs, SSE logs
│   └── web/             # React + Vite admin console
├── packages/
│   └── shared/          # Shared types and validation
├── data/                # SQLite database and action.log
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

- [中文完整文档](./README.zh-CN.md)
- [Caddy deployment guide](./docs/deployment-caddy.md)
- [Fresh install test](./docs/fresh-install-test.md)
- [Realtime logging notes](./docs/realtime-config.md)
- [Release checklist](./docs/release-checklist.md)

## License

Yutrix is released under the [MIT License](./LICENSE).

Copyright (c) 2026 Tom Wu.
