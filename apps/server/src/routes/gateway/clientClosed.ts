/**
 * Client-closed / downstream-gone classification.
 *
 * Transport facts (dead client socket, abort, 499) must not be treated as
 * upstream availability failures. New terminal classes plug into
 * `shouldSkipUpstreamRescue` instead of another executor if-ladder copy.
 */

import type { StreamTerminalError } from "./providerAdapters/types";

export const CLIENT_CLOSED_STATUS = 499;
export const CLIENT_CLOSED_CODE = "client_closed";
export const CLIENT_CLOSED_ERROR_TYPE = "client_closed";
export const CLIENT_CLOSED_RETRY_CLASS = "client_closed" as const;

export const DOWNSTREAM_CONNECTION_CLOSED_MESSAGE = "Downstream connection closed";
export const CLIENT_CLOSED_REQUEST_MESSAGE = "Client Closed Request";
export const STREAM_CHUNK_TIMEOUT_MESSAGE = "Stream chunk timeout";
export const FIRST_TOKEN_TIMEOUT_MESSAGE = "First token timeout";

export type ClientClosedSignals = {
  replyDestroyed?: boolean;
  replyWritableEnded?: boolean;
  clientDisconnected?: boolean;
  abortSignaled?: boolean;
};

export type StreamTransportKind = "timeout" | "client_closed" | "upstream";

export type StreamTransportClassification = {
  kind: StreamTransportKind;
  statusCode: number;
};

export type ClientClosedTerminalLike = {
  statusCode?: number;
  code?: string;
  errorType?: string;
  retryClass?: string;
  message?: string;
} | null | undefined;

export type UpstreamRescueSkipInput = ClientClosedSignals & {
  terminalError?: ClientClosedTerminalLike;
  fetchStatus?: number;
};

function errorMessageOf(err: unknown): string {
  if (err == null) return "";
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message || "";
  if (typeof err === "object" && "message" in err && typeof (err as any).message === "string") {
    return (err as any).message;
  }
  return "";
}

function nestedClientClosedType(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const rec = err as Record<string, any>;
  const direct = rec.type || rec.errorType || rec.error_type;
  if (direct === CLIENT_CLOSED_ERROR_TYPE || direct === CLIENT_CLOSED_CODE) return true;
  const nested = rec.error;
  if (nested && typeof nested === "object") {
    const nestedType = nested.type || nested.errorType || nested.error_type;
    if (nestedType === CLIENT_CLOSED_ERROR_TYPE || nestedType === CLIENT_CLOSED_CODE) return true;
    if (nested.message === CLIENT_CLOSED_REQUEST_MESSAGE) return true;
    if (nested.message === DOWNSTREAM_CONNECTION_CLOSED_MESSAGE) return true;
  }
  return false;
}

export function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const rec = err as { name?: string; code?: string };
  return rec.name === "AbortError" || rec.code === "ABORT_ERR";
}

export function isDownstreamWriteClosedError(err: unknown): boolean {
  const message = errorMessageOf(err);
  if (message === DOWNSTREAM_CONNECTION_CLOSED_MESSAGE) return true;
  if (message === CLIENT_CLOSED_REQUEST_MESSAGE) return true;
  if (message === `Stream exception: ${DOWNSTREAM_CONNECTION_CLOSED_MESSAGE}`) return true;
  const rec = err as { code?: string } | null;
  const code = rec && typeof rec === "object" ? rec.code : undefined;
  return code === "EPIPE" || code === "ECONNRESET";
}

export function isClientClosedStatus(status: number | undefined | null): boolean {
  return status === CLIENT_CLOSED_STATUS;
}

export function isStreamChunkTimeoutError(err: unknown): boolean {
  const message = errorMessageOf(err);
  return message === STREAM_CHUNK_TIMEOUT_MESSAGE || message === FIRST_TOKEN_TIMEOUT_MESSAGE;
}

/**
 * Classify a stream-forward exception using precise downstream-gone signals.
 * Client-closed wins over timeout: a dead socket cannot be rescued.
 */
export function classifyStreamTransportError(
  err: unknown,
  signals: ClientClosedSignals = {},
): StreamTransportClassification {
  if (isClientClosedFromSignals(signals) || isDownstreamWriteClosedError(err)) {
    return { kind: "client_closed", statusCode: CLIENT_CLOSED_STATUS };
  }
  if (isStreamChunkTimeoutError(err)) {
    return { kind: "timeout", statusCode: 504 };
  }
  if (signals.abortSignaled && isAbortError(err)) {
    return { kind: "client_closed", statusCode: CLIENT_CLOSED_STATUS };
  }
  return { kind: "upstream", statusCode: 502 };
}

export function isClientClosedFromSignals(signals: ClientClosedSignals = {}): boolean {
  return !!(
    signals.clientDisconnected
    || signals.replyDestroyed
    || signals.replyWritableEnded
  );
}

export function isClientClosedClassifierInput(input: {
  rawError?: unknown;
  statusCode?: number;
}): boolean {
  if (isClientClosedStatus(input.statusCode)) return true;
  if (isDownstreamWriteClosedError(input.rawError)) return true;
  if (nestedClientClosedType(input.rawError)) return true;
  return false;
}

export function isClientClosedTerminal(error: ClientClosedTerminalLike): boolean {
  if (!error) return false;
  if (error.retryClass === CLIENT_CLOSED_RETRY_CLASS) return true;
  if (error.code === CLIENT_CLOSED_CODE || error.errorType === CLIENT_CLOSED_ERROR_TYPE) return true;
  if (isClientClosedStatus(error.statusCode)) return true;
  if (error.message === DOWNSTREAM_CONNECTION_CLOSED_MESSAGE) return true;
  if (error.message === CLIENT_CLOSED_REQUEST_MESSAGE) return true;
  if (error.message === `Stream exception: ${DOWNSTREAM_CONNECTION_CLOSED_MESSAGE}`) return true;
  return false;
}

/**
 * Whether the executor must refuse funnel fallback, key rotation, same-provider
 * retry, and the next upstream fetch.
 */
export function shouldSkipUpstreamRescue(input: UpstreamRescueSkipInput): boolean {
  if (isClientClosedFromSignals(input)) return true;
  if (input.abortSignaled) return true;
  if (isClientClosedStatus(input.fetchStatus)) return true;
  if (isClientClosedTerminal(input.terminalError)) return true;
  return false;
}

export function clientClosedDisconnectMessage(gotFirstChunk: boolean): string {
  return gotFirstChunk
    ? "客户端提前关闭连接"
    : "客户端在收到响应前断开了连接";
}

export function buildClientClosedTerminalError(opts: {
  adapterId?: StreamTerminalError["adapterId"];
  phase?: StreamTerminalError["phase"];
  message?: string;
} = {}): StreamTerminalError {
  const message = opts.message && opts.message.trim()
    ? opts.message
    : DOWNSTREAM_CONNECTION_CLOSED_MESSAGE;
  return {
    statusCode: CLIENT_CLOSED_STATUS,
    code: CLIENT_CLOSED_CODE,
    errorType: CLIENT_CLOSED_ERROR_TYPE,
    message,
    retryable: false,
    retryClass: CLIENT_CLOSED_RETRY_CLASS,
    adapterId: opts.adapterId || "transparent",
    upstreamProvider: "Unknown",
    upstreamCode: CLIENT_CLOSED_CODE,
    upstreamErrorType: CLIENT_CLOSED_ERROR_TYPE,
    safeMetadata: {},
    fingerprint: "client_closed",
    phase: opts.phase || "stream",
  };
}
