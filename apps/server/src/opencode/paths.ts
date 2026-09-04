import { join } from "path";

/** Vendored OpenCode root: binary, XDG homes, and auth.json live under here. */
export function resolveOpencodeVendorDir(cwd = process.cwd()): string {
  return join(cwd, ".vendor", "opencode");
}

export interface OpencodePaths {
  vendorDir: string;
  binPath: string;
  /** Empty isolated cwd for `opencode serve`. Never the gateway checkout. */
  sandboxDir: string;
  /** HOME for the sidecar process — kept inside vendor, not the host user. */
  homeDir: string;
  cacheHome: string;
  tmpDir: string;
  /** XDG_DATA_HOME — OpenCode writes `$XDG_DATA_HOME/opencode/auth.json`. */
  dataHome: string;
  configHome: string;
  /** `$XDG_CONFIG_HOME/opencode` — managed deny-all `opencode.json`. */
  configDir: string;
  configFilePath: string;
  stateHome: string;
  authDir: string;
  authPath: string;
  passwordPath: string;
  launchMetaPath: string;
}

export function resolveOpencodePaths(cwd = process.cwd()): OpencodePaths {
  const vendorDir = resolveOpencodeVendorDir(cwd);
  const dataHome = join(vendorDir, "data");
  const authDir = join(dataHome, "opencode");
  const configHome = join(vendorDir, "config");
  const configDir = join(configHome, "opencode");
  const stateHome = join(vendorDir, "state");
  return {
    vendorDir,
    binPath: join(vendorDir, "bin", "opencode"),
    sandboxDir: join(vendorDir, "sandbox"),
    homeDir: join(vendorDir, "home"),
    cacheHome: join(vendorDir, "cache"),
    tmpDir: join(vendorDir, "tmp"),
    dataHome,
    configHome,
    configDir,
    configFilePath: join(configDir, "opencode.json"),
    stateHome,
    authDir,
    authPath: join(authDir, "auth.json"),
    passwordPath: join(stateHome, "server-password"),
    launchMetaPath: join(stateHome, "sidecar-launch.json"),
  };
}

export const OPENCODE_LOOPBACK_HOST = "127.0.0.1";
export const OPENCODE_LOOPBACK_PORT = 23456;
export const OPENCODE_SERVER_USERNAME = "opencode";
export const OPENCODE_DOWNLOAD_PROXY_KEY = "opencode_download_proxy";
export const OPENCODE_AUTO_UPDATE_KEY = "opencode_auto_update";

/**
 * OpenCode 1.18 Session API (`POST /session/:id/message`) returns a completed
 * JSON message, not an SSE body. Gateway streaming clients are served via the
 * existing fake-SSE restoration path (`restoreFakeStreamIfNeeded`).
 * Real token deltas would require the unproven `GET /event` + `prompt_async`
 * pair; we do not use that here.
 */
export const OPENCODE_SESSION_STREAMING = "session-json-then-fake-sse" as const;
