# OpenCode sidecar (admin-managed, client-transparent)

Yutrix can route selected provider models through a **loopback OpenCode sidecar**
so harness-gated upstreams (for example some OpenRouter free models) work without
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
