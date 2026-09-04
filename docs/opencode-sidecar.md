# OpenCode sidecar (admin-managed, client-transparent)

Yutrix can route selected provider models through a **loopback OpenCode sidecar**
so harness-gated upstreams (for example OpenRouter Inkling and similar free / agentic models) work without
exposing OpenCode to API clients. The public gateway stays OpenAI / Anthropic
compatible. Keys stay in `providerApiKeys`; the selected key is mirrored into
OpenCode `auth.json` immediately before a call.

## Streaming limitation

OpenCode 1.18.x `POST /session/:id/message` returns a **completed JSON** message
(`parts[]`). It is not an SSE body.

- Token-delta streaming would require the unproven `GET /event` + `prompt_async`
  pair. Yutrix does **not** use that path.
- Streaming clients are **not** left hanging: the gateway already converts a
  successful non-stream JSON completion into fake SSE via
  `restoreFakeStreamIfNeeded`.
- `executeOpencodeSessionApi` always returns `isStream: false` plus
  `responseProtocol` so that restoration can run.

## Never spoof OpenRouter identity

Sidecar HTTP calls send only `Content-Type` and loopback Basic auth
(`OPENCODE_SERVER_PASSWORD`). They never set `Referer` / `HTTP-Referer` /
`X-Title`.

## Security model (text-only compat channel)

The sidecar is for **gateway chat**, not a coding agent on the host install.
`opencode serve` defaults to coding-agent tools and inherits the process working
directory. If that cwd is the gateway checkout (for example `/opt/promptgate`),
the model can read `AGENTS.md`, source, sqlite, and env files and echo host
paths or secret *names* back to clients.

Yutrix therefore:

- **Isolated cwd** — spawn uses `.vendor/opencode/sandbox` (see `paths.ts`).
  That directory is recreated empty on each start. It is not the repo root and
  must not contain `AGENTS.md`, source, sqlite, or `.env`. A nested `.git`
  marker stops OpenCode walking up to the gateway repository.
- **Deny-all tools** — managed `$XDG_CONFIG_HOME/opencode/opencode.json` sets
  `permission["*"] = "deny"` plus explicit deny for `bash`, `edit`, `read`,
  `write`, `glob`, `grep`, `list`, `task`, `external_directory`, `webfetch`,
  `websearch`, `skill`, `lsp`, and `question`. Headless serve cannot prompt, so
  `ask` is never used.
- **`--pure`** — serve args include `--pure` and the child env sets
  `OPENCODE_PURE=1` so external plugins do not load.
- **Env whitelist** — the child does **not** receive `...process.env`. Only
  `PATH`, locale, isolated `HOME` / `TMPDIR` / `XDG_*`, loopback
  `OPENCODE_SERVER_*`, `OPENCODE_CONFIG`, `OPENCODE_PURE`, and optional
  `HTTP(S)_PROXY` are passed. Gateway secrets (`PROMPTGATE_SECRET`,
  `DATABASE_URL`, cloud/SSH tokens, host API keys) are not inherited.
  Provider keys still sync through `auth.json` immediately before a call.
- **Restart stale leftovers** — `start()` rewrites sandbox + config first. A
  healthy leftover whose launch metadata (cwd + config hash) does not match is
  stopped and replaced. An old process started with the host workspace must
  not be adopted forever.

Do not run `opencode serve` against the gateway checkout or with default
allow-all tool permissions. Session API request/response shapes are unchanged.
