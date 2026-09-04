import { join } from "path";

/** Vendored OpenCode root: binary, XDG homes, and auth.json live under here. */
export function resolveOpencodeVendorDir(cwd = process.cwd()): string {
  return join(cwd, ".vendor", "opencode");
}

export interface OpencodePaths {
  vendorDir: string;
  binPath: string;
  /** XDG_DATA_HOME — OpenCode writes `$XDG_DATA_HOME/opencode/auth.json`. */
  dataHome: string;
  configHome: string;
  stateHome: string;
  authDir: string;
  authPath: string;
  passwordPath: string;
}

export function resolveOpencodePaths(cwd = process.cwd()): OpencodePaths {
  const vendorDir = resolveOpencodeVendorDir(cwd);
  const dataHome = join(vendorDir, "data");
  const authDir = join(dataHome, "opencode");
  return {
    vendorDir,
    binPath: join(vendorDir, "bin", "opencode"),
    dataHome,
    configHome: join(vendorDir, "config"),
    stateHome: join(vendorDir, "state"),
    authDir,
    authPath: join(authDir, "auth.json"),
    passwordPath: join(vendorDir, "state", "server-password"),
  };
}

export const OPENCODE_LOOPBACK_HOST = "127.0.0.1";
export const OPENCODE_LOOPBACK_PORT = 23456;
export const OPENCODE_SERVER_USERNAME = "opencode";
export const OPENCODE_DOWNLOAD_PROXY_KEY = "opencode_download_proxy";

/**
 * OpenCode 1.18 Session API (`POST /session/:id/message`) returns a completed
 * JSON message, not an SSE body. Gateway streaming clients are served via the
 * existing fake-SSE restoration path (`restoreFakeStreamIfNeeded`).
 * Real token deltas would require the unproven `GET /event` + `prompt_async`
 * pair; we do not use that here.
 */
export const OPENCODE_SESSION_STREAMING = "session-json-then-fake-sse" as const;
