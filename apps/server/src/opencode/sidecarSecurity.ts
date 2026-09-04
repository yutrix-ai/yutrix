import { createHash } from "crypto";
import { existsSync } from "fs";
import { mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import { OPENCODE_SERVER_USERNAME, type OpencodePaths } from "./paths";

/** Tools the compat-channel sidecar must never run (headless cannot `ask`). */
export const OPENCODE_DENIED_TOOLS = [
  "bash",
  "edit",
  "read",
  "write",
  "glob",
  "grep",
  "list",
  "task",
  "external_directory",
  "webfetch",
  "websearch",
  "skill",
  "lsp",
  "question",
] as const;

export const SIDECAR_LAUNCH_META_VERSION = 1;

/**
 * Host secrets that must never be copied into the sidecar process.
 * Auth for upstream models is synced separately via auth.json.
 */
export const SIDECAR_FORBIDDEN_ENV = [
  "PROMPTGATE_SECRET",
  "DATABASE_URL",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_SECURITY_TOKEN",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_API_KEY",
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "NPM_TOKEN",
  "NODE_OPTIONS",
  "LD_PRELOAD",
  "PYTHONPATH",
] as const;

const OPTIONAL_CONNECTIVITY_ENV = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
] as const;

const SANDBOX_FORBIDDEN_NAMES = [
  "AGENTS.md",
  ".env",
  "promptgate.sqlite",
  "yutrix.config.json",
];

export interface SidecarLaunchMeta {
  version: number;
  cwd: string;
  configHash: string;
  pid?: number;
}

export function buildManagedOpencodeConfig(): Record<string, unknown> {
  const permission: Record<string, "deny"> = { "*": "deny" };
  const tools: Record<string, false> = {};
  for (const tool of OPENCODE_DENIED_TOOLS) {
    permission[tool] = "deny";
    tools[tool] = false;
  }
  return {
    $schema: "https://opencode.ai/config.json",
    permission,
    tools,
  };
}

export function hashManagedOpencodeConfig(config: Record<string, unknown> = buildManagedOpencodeConfig()): string {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

export function buildOpencodeServeArgs(port: number, host: string): string[] {
  return ["--pure", "serve", "--port", String(port), "--hostname", host];
}

export function buildOpencodeChildEnv(paths: OpencodePaths, password: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    LANG: process.env.LANG || "C.UTF-8",
    LC_ALL: process.env.LC_ALL || process.env.LANG || "C.UTF-8",
    HOME: paths.homeDir,
    TMPDIR: paths.tmpDir,
    XDG_DATA_HOME: paths.dataHome,
    XDG_CONFIG_HOME: paths.configHome,
    XDG_STATE_HOME: paths.stateHome,
    XDG_CACHE_HOME: paths.cacheHome,
    OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_SERVER_USERNAME: OPENCODE_SERVER_USERNAME,
    OPENCODE_PURE: "1",
    OPENCODE_CONFIG: paths.configFilePath,
  };
  if (process.env.TZ) env.TZ = process.env.TZ;
  for (const key of OPTIONAL_CONNECTIVITY_ENV) {
    if (process.env[key]) env[key] = process.env[key];
  }
  for (const key of SIDECAR_FORBIDDEN_ENV) {
    delete env[key];
  }
  return env;
}

export function expectedSidecarLaunch(
  paths: OpencodePaths,
  configHash = hashManagedOpencodeConfig(),
): Pick<SidecarLaunchMeta, "version" | "cwd" | "configHash"> {
  return {
    version: SIDECAR_LAUNCH_META_VERSION,
    cwd: paths.sandboxDir,
    configHash,
  };
}

export function sidecarLaunchCompatible(
  meta: SidecarLaunchMeta | null | undefined,
  expected: Pick<SidecarLaunchMeta, "version" | "cwd" | "configHash">,
): boolean {
  if (!meta) return false;
  return (
    meta.version === expected.version &&
    meta.cwd === expected.cwd &&
    meta.configHash === expected.configHash
  );
}

export function parseSidecarLaunchMeta(raw: unknown): SidecarLaunchMeta | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.version !== "number" || typeof rec.cwd !== "string" || typeof rec.configHash !== "string") {
    return null;
  }
  const meta: SidecarLaunchMeta = {
    version: rec.version,
    cwd: rec.cwd,
    configHash: rec.configHash,
  };
  if (typeof rec.pid === "number" && Number.isInteger(rec.pid) && rec.pid > 0) {
    meta.pid = rec.pid;
  }
  return meta;
}

/** Recreate an empty sandbox (no host AGENTS.md / source / sqlite / .env). */
export async function ensureOpencodeSandbox(sandboxDir: string): Promise<void> {
  await rm(sandboxDir, { recursive: true, force: true });
  await mkdir(sandboxDir, { recursive: true, mode: 0o700 });
  // Stop OpenCode walking up to the gateway git root and treating it as the workspace.
  await mkdir(join(sandboxDir, ".git"), { recursive: true });
  await writeFile(join(sandboxDir, ".git", "HEAD"), "ref: refs/heads/main\n", { encoding: "utf8" });

  for (const name of SANDBOX_FORBIDDEN_NAMES) {
    if (existsSync(join(sandboxDir, name))) {
      throw new Error(`OpenCode sandbox must not contain ${name}`);
    }
  }
}

export async function writeManagedOpencodeConfig(paths: OpencodePaths): Promise<string> {
  const config = buildManagedOpencodeConfig();
  await mkdir(paths.configDir, { recursive: true });
  await writeFile(paths.configFilePath, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return hashManagedOpencodeConfig(config);
}

export async function prepareSidecarFilesystem(paths: OpencodePaths): Promise<string> {
  await mkdir(paths.homeDir, { recursive: true, mode: 0o700 });
  await mkdir(paths.tmpDir, { recursive: true, mode: 0o700 });
  await mkdir(paths.cacheHome, { recursive: true });
  await mkdir(paths.dataHome, { recursive: true });
  await mkdir(paths.stateHome, { recursive: true });
  await ensureOpencodeSandbox(paths.sandboxDir);
  return writeManagedOpencodeConfig(paths);
}
