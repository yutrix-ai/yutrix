import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  assertNoSpoofHeaders,
  buildOpencodeUserText,
  extractOpencodeSessionId,
  joinOpencodeTextParts,
  mapOpencodeHttpError,
  normalizeDownloadProxyUrl,
  resolveOpencodeProviderSlug,
  shouldRouteViaOpencode,
} from "../src/opencode/protocol";
import { resolveOpencodePaths } from "../src/opencode/paths";
import { writeOpencodeAuthJson } from "../src/opencode/authJson";
import { buildUpstreamHeaders } from "../src/routes/gateway/upstream";

function bootstrapScript(): string {
  const fromServer = join(process.cwd(), "../../scripts/bootstrap-opencode.sh");
  const fromRoot = join(process.cwd(), "scripts/bootstrap-opencode.sh");
  return existsSync(fromServer) ? fromServer : fromRoot;
}

function printPkg(arch?: string): string {
  const args = ["--print-pkg"];
  if (arch) args.push(arch);
  return execFileSync("bash", [bootstrapScript(), ...args], {
    encoding: "utf8",
    env: { ...process.env, TARGETARCH: arch || "" },
  }).trim();
}

const syncCredential = vi.fn().mockResolvedValue(undefined);
const start = vi.fn().mockResolvedValue(undefined);
const isReady = vi.fn().mockReturnValue(true);

vi.mock("../src/opencode/opencodeService", () => ({
  OpencodeService: {
    getInstance: () => ({
      port: 23456,
      host: "127.0.0.1",
      isReady,
      start,
      syncCredential,
      sidecarUrl: (pathname: string) => `http://127.0.0.1:23456${pathname}`,
      sidecarHeaders: (extra: Record<string, string> = {}) => ({
        ...extra,
        Authorization: "Basic dGVzdA==",
      }),
    }),
  },
}));

describe("OpenCode protocol helpers", () => {
  it("maps provider URLs to OpenCode slugs, never a yutrix UUID", () => {
    expect(resolveOpencodeProviderSlug({ openaiBaseUrl: "https://openrouter.ai/api/v1" })).toBe("openrouter");
    expect(resolveOpencodeProviderSlug({ openaiBaseUrl: "https://api.openai.com/v1" })).toBe("openai");
    expect(resolveOpencodeProviderSlug({ protocol: "anthropic", anthropicBaseUrl: "https://api.anthropic.com" })).toBe("anthropic");
    expect(resolveOpencodeProviderSlug({ openaiBaseUrl: "https://generativelanguage.googleapis.com/v1beta" })).toBe("google");
    expect(resolveOpencodeProviderSlug({ openaiBaseUrl: "https://example.com/v1" })).toBe("openrouter");
  });

  it("gates the sidecar only when useOpencodeProxy is explicitly on", () => {
    expect(shouldRouteViaOpencode({ useOpencodeProxy: true })).toBe(true);
    expect(shouldRouteViaOpencode({ useOpencodeProxy: false })).toBe(false);
    expect(shouldRouteViaOpencode({})).toBe(false);
    expect(shouldRouteViaOpencode(null)).toBe(false);
  });

  it("joins only type===text parts and skips reasoning", () => {
    expect(
      joinOpencodeTextParts({
        parts: [
          { type: "reasoning", text: "hidden chain" },
          { type: "text", text: "Hello" },
          { type: "thinking", text: "nope" },
          { type: "text", text: " world" },
        ],
      }),
    ).toBe("Hello world");
    expect(joinOpencodeTextParts({ data: { parts: [{ type: "text", text: "nested" }] } })).toBe("nested");
    expect(joinOpencodeTextParts({ text: "legacy" })).toBe("");
  });

  it("reads session id from proven and nested shapes", () => {
    expect(extractOpencodeSessionId({ id: "ses_123" })).toBe("ses_123");
    expect(extractOpencodeSessionId({ data: { id: "ses_nested" } })).toBe("ses_nested");
    expect(extractOpencodeSessionId({})).toBeNull();
  });

  it("flattens conversation history, not only the last message", () => {
    const text = buildOpencodeUserText({
      system: "be brief",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
        { role: "user", content: [{ type: "text", text: "follow up" }] },
      ],
    });
    expect(text).toContain("system: be brief");
    expect(text).toContain("user: hi");
    expect(text).toContain("assistant: hello");
    expect(text).toContain("user: follow up");
  });

  it("maps 429/auth so the gateway can sticky-rotate providerApiKeys", () => {
    expect(mapOpencodeHttpError(429, "Rate limited").status).toBe(429);
    expect(mapOpencodeHttpError(429, "Rate limited").rateLimited).toBe(true);
    expect(mapOpencodeHttpError(401, "invalid api key").status).toBe(401);
    expect(mapOpencodeHttpError(401, "invalid api key").authFailed).toBe(true);
    expect(mapOpencodeHttpError(403, "forbidden").authFailed).toBe(true);
    expect(mapOpencodeHttpError(500, "boom").status).toBe(500);
  });

  it("accepts empty or http(s) download proxies and rejects junk", () => {
    expect(normalizeDownloadProxyUrl("")).toBe("");
    expect(normalizeDownloadProxyUrl("  https://proxy.example:8080  ")).toBe("https://proxy.example:8080");
    expect(() => normalizeDownloadProxyUrl("ftp://nope")).toThrow(/http/);
    expect(() => normalizeDownloadProxyUrl("not-a-url")).toThrow(/http/);
  });

  it("never allows Referer / X-Title spoof headers on sidecar calls", () => {
    expect(() => assertNoSpoofHeaders({ "Content-Type": "application/json" })).not.toThrow();
    expect(() => assertNoSpoofHeaders({ "HTTP-Referer": "https://localhost" })).toThrow(/spoof/i);
    expect(() => assertNoSpoofHeaders({ "X-Title": "yutrix" })).toThrow(/spoof/i);
  });
});

describe("OpenCode Session API adapter", () => {
  beforeEach(() => {
    syncCredential.mockClear();
    start.mockClear();
    isReady.mockReturnValue(true);
    vi.unstubAllGlobals();
  });

  it("syncs the key, uses provider slug, and returns gateway-shaped non-stream data", async () => {
    const { executeOpencodeSessionApi } = await import("../src/opencode/opencodeClient");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "ses_123" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          parts: [
            { type: "reasoning", text: "ignore me" },
            { type: "text", text: "Hello from opencode!" },
          ],
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeOpencodeSessionApi(
      { messages: [{ role: "user", content: "Hi" }] },
      "openrouter",
      "gpt-4o",
      "test-key",
      new AbortController(),
    );

    expect(start).toHaveBeenCalled();
    expect(syncCredential).toHaveBeenCalledWith("openrouter", "test-key");
    expect(result.status).toBe(200);
    expect(result.isStream).toBe(false);
    expect(result.sidecarNonStream).toBe(true);
    expect(result.responseProtocol).toBe("openai");
    expect(result.data.choices[0].message.content).toBe("Hello from opencode!");
    expect(result.data.object).toBe("chat.completion");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe("http://127.0.0.1:23456/session");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).title).toBe("gateway request");
    expect(fetchMock.mock.calls[1][0]).toBe("http://127.0.0.1:23456/session/ses_123/message");
    const msgBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(msgBody.model.providerID).toBe("openrouter");
    expect(msgBody.model.modelID).toBe("gpt-4o");
    expect(msgBody.parts[0].text).toBe("user: Hi");

    const sentHeaders = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(sentHeaders["HTTP-Referer"]).toBeUndefined();
    expect(sentHeaders["Referer"]).toBeUndefined();
    expect(sentHeaders["X-Title"]).toBeUndefined();
    expect(sentHeaders.Authorization).toMatch(/^Basic /);
  });

  it("returns Anthropic-shaped JSON when the incoming client is Anthropic", async () => {
    const { executeOpencodeSessionApi } = await import("../src/opencode/opencodeClient");
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "ses_a" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ parts: [{ type: "text", text: "ok" }] }) }));

    const result = await executeOpencodeSessionApi(
      { messages: [{ role: "user", content: "Hi" }] },
      "openrouter",
      "claude",
      "k",
      new AbortController(),
      "anthropic",
    );
    expect(result.responseProtocol).toBe("anthropic");
    expect(result.data.type).toBe("message");
    expect(result.data.content[0].text).toBe("ok");
  });

  it("returns 429 so the gateway can rotate keys", async () => {
    const { executeOpencodeSessionApi } = await import("../src/opencode/opencodeClient");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 429,
      text: async () => "Rate limited",
    }));

    const result = await executeOpencodeSessionApi(
      { messages: [{ content: "Hi" }] },
      "openrouter",
      "gpt-4o",
      "test-key",
      new AbortController(),
    );
    expect(result.status).toBe(429);
    expect(result.isStream).toBe(false);
    expect(result.data.error.type).toBe("rate_limit_error");
  });

  it("maps auth failures to 401 for sticky rotate", async () => {
    const { executeOpencodeSessionApi } = await import("../src/opencode/opencodeClient");
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "ses_1" }) })
      .mockResolvedValueOnce({ ok: false, status: 401, text: async () => "invalid api key" }));

    const result = await executeOpencodeSessionApi(
      { messages: [{ content: "Hi" }] },
      "openrouter",
      "gpt-4o",
      "bad-key",
      new AbortController(),
    );
    expect(result.status).toBe(401);
    expect(result.data.error.type).toBe("auth_error");
  });

  it("refuses to start when the binary is missing", async () => {
    isReady.mockReturnValue(false);
    const { executeOpencodeSessionApi } = await import("../src/opencode/opencodeClient");
    await expect(
      executeOpencodeSessionApi({ messages: [] }, "openrouter", "m", "k", new AbortController()),
    ).rejects.toThrow(/not installed/i);
    expect(start).not.toHaveBeenCalled();
  });
});

describe("auth.json + XDG paths", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "opencode-auth-"));
  });

  afterEach(() => {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("writes { provider: { type: api, key } } under XDG_DATA_HOME/opencode/auth.json", async () => {
    const paths = resolveOpencodePaths(root);
    expect(paths.authPath).toBe(join(root, ".vendor/opencode/data/opencode/auth.json"));
    expect(paths.dataHome).toBe(join(root, ".vendor/opencode/data"));

    await writeOpencodeAuthJson(paths.authPath, "openrouter", "sk-or-1");
    await writeOpencodeAuthJson(paths.authPath, "openrouter", "sk-or-2");
    const parsed = JSON.parse(readFileSync(paths.authPath, "utf8"));
    expect(parsed).toEqual({ openrouter: { type: "api", key: "sk-or-2" } });
  });

  it("refuses to write a yutrix provider UUID as OpenCode slug", async () => {
    const authPath = join(root, "auth.json");
    await expect(
      writeOpencodeAuthJson(authPath, "3fa85f64-5717-4562-b3fc-2c963f66afa6", "k"),
    ).rejects.toThrow(/slug/i);
  });
});

describe("bootstrap arch mapping", () => {
  it("maps Docker TARGETARCH and uname aliases", () => {
    expect(printPkg("amd64")).toBe("opencode-linux-x64");
    expect(printPkg("x86_64")).toBe("opencode-linux-x64");
    expect(printPkg("arm64")).toBe("opencode-linux-arm64");
    expect(printPkg("aarch64")).toBe("opencode-linux-arm64");
  });

  it("fails loudly on unsupported arch", () => {
    try {
      printPkg("ppc64le");
      throw new Error("expected bootstrap to fail");
    } catch (e: any) {
      expect(String(e.stderr || e.message)).toMatch(/Unsupported arch/);
    }
  });

  it("sqlite useOpencodeProxy migration is additive-only", () => {
    const sqlPath = existsSync(join(process.cwd(), "drizzle/0038_provider_model_opencode_proxy.sql"))
      ? join(process.cwd(), "drizzle/0038_provider_model_opencode_proxy.sql")
      : join(process.cwd(), "apps/server/drizzle/0038_provider_model_opencode_proxy.sql");
    const sql = readFileSync(sqlPath, "utf8");
    expect(sql).toMatch(/ALTER TABLE `provider_models` ADD `useOpencodeProxy`/);
    expect(sql).not.toMatch(/CREATE TABLE/);
    expect(sql).not.toMatch(/DROP TABLE/);
  });
});

describe("gateway OpenCode flag + no OpenRouter spoof", () => {
  it("buildUpstreamHeaders never sets Referer or X-Title", () => {
    const headers = buildUpstreamHeaders("sk-test", false, "/v1/chat/completions");
    const keys = Object.keys(headers).map((k) => k.toLowerCase());
    expect(keys).not.toContain("referer");
    expect(keys).not.toContain("http-referer");
    expect(keys).not.toContain("x-title");
  });
});

describe("admin UI persists useOpencodeProxy (static)", () => {
  it("ProviderModelsModal save payload includes useOpencodeProxy", () => {
    const modalPath = existsSync(join(process.cwd(), "apps/web/src/components/ProviderModelsModal.tsx"))
      ? join(process.cwd(), "apps/web/src/components/ProviderModelsModal.tsx")
      : join(process.cwd(), "../web/src/components/ProviderModelsModal.tsx");
    const src = readFileSync(modalPath, "utf8");
    expect(src).toMatch(/useOpencodeProxy:\s*Boolean\(m\.useOpencodeProxy\)/);
    expect(src).toMatch(/onChange\(\"useOpencodeProxy\"/);
  });
});
