import fs from "fs";
import path from "path";
import crypto from "crypto";
import { renderActionLogServerLine } from "./actionLogTemplates";

const MAX_HISTORY = 1000;
const logHistory: ActionLogEvent[] = [];
const listeners = new Set<(entry: ActionLogEvent) => void>();
const LOG_FILE = process.env.ACTION_LOG_FILE || process.env.LOG_FILE_NAME || path.join(process.cwd(), "data/action.log");
const TAIL_READ_BYTES = 4 * 1024 * 1024;
const MAX_FILE_BYTES = parsePositiveInt(process.env.ACTION_LOG_MAX_BYTES, 50 * 1024 * 1024);
const MAX_ROTATED_FILES = parsePositiveInt(process.env.ACTION_LOG_MAX_FILES, 5);
let currentFileBytes = 0;

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Reads only the trailing `maxBytes` of the file so startup memory stays flat regardless of log size. */
export function readLogTail(file: string, maxLines: number, maxBytes = TAIL_READ_BYTES): string[] {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    let read = 0;
    while (read < buf.length) {
      const n = fs.readSync(fd, buf, read, buf.length - read, start + read);
      if (n === 0) break;
      read += n;
    }
    let lines = buf.subarray(0, read).toString("utf-8").split("\n");
    // The first line may be cut mid-way (possibly mid UTF-8 sequence) when not starting at offset 0.
    if (start > 0) lines = lines.slice(1);
    return lines.filter(Boolean).slice(-maxLines);
  } finally {
    fs.closeSync(fd);
  }
}

/** Shifts `file` -> `file.1` -> ... -> `file.<maxFiles>`; the oldest rotated file is overwritten. */
export function rotateLogFile(file: string, maxFiles: number) {
  for (let i = maxFiles - 1; i >= 1; i--) {
    const src = `${file}.${i}`;
    if (fs.existsSync(src)) fs.renameSync(src, `${file}.${i + 1}`);
  }
  fs.renameSync(file, `${file}.1`);
}

// Ensure log directory exists
try {
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
} catch (e) {
  console.warn("警告：创建日志目录失败：", e);
}

// Load history on startup
try {
  if (fs.existsSync(LOG_FILE)) {
    currentFileBytes = fs.statSync(LOG_FILE).size;
    logHistory.push(...readLogTail(LOG_FILE, MAX_HISTORY).map(parseActionLogLine));
  }
} catch (e) {
  console.warn("警告：加载历史日志失败：", e);
}

export function getActionLogEntries(limit = MAX_HISTORY): ActionLogEvent[] {
  return logHistory.slice(Math.max(0, logHistory.length - limit));
}

// Kept for backward compatibility if any string[] is expected
export function getActionLogHistory(limit = MAX_HISTORY): string[] {
  return getActionLogEntries(limit).map((entry) => entry.serverLine || entry.line || "");
}

export function subscribeActionLogs(listener: (entry: ActionLogEvent) => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export type ActionLogLevel = "信息" | "警告" | "错误" | "INFO" | "WARN" | "ERROR";

export type ActionLogEventInput = {
  level: ActionLogLevel;
  code?: string;
  action?: string; // legacy support
  requestId?: string;
  userId?: string;
  username?: string;
  apiKeyPrefix?: string;
  host?: string;
  path?: string;
  routeId?: string;
  routeName?: string;
  providerName?: string;
  modelId?: string;
  statusCode?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  latencyMs?: number;
  queueMs?: number;
  fallback?: boolean;
  fallbackReason?: string;
  fallbackReasonCode?: string;
  errorCode?: string;
  message?: string;
  [key: string]: any;
};

export type ActionLogEvent = {
  id: string;
  timestamp: string;
  level: ActionLogLevel;
  code: string;
  params: Record<string, any>;
  serverLine: string;

  // legacy backward compatible fields
  line?: string;
  requestId?: string;
  [key: string]: any;
};

function formatTimestamp(now = new Date()): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

function parseActionLogLine(line: string): ActionLogEvent {
  const match = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) (信息|警告|错误|INFO|WARN|ERROR) /);
  const requestId = line.match(/\brequestId=([^\s]+)/)?.[1];
  return {
    id: crypto.randomUUID(),
    timestamp: match?.[1] || formatTimestamp(),
    level: (match?.[2] as ActionLogLevel) || "INFO",
    code: "raw_line",
    params: { requestId },
    serverLine: line,
    line: line,
    requestId,
  };
}

function redactSensitive(value: string): string {
  return value
    .replace(/pg_[a-f0-9]{16,}/gi, (match) => `${match.slice(0, 8)}...`)
    .replace(/sk-[A-Za-z0-9_\-]{8,}/gi, "sk_已隐藏")
    .replace(/\b[a-f0-9]{64}\b/gi, "哈希已隐藏");
}

export function logAction(input: ActionLogEventInput) {
  const timestamp = formatTimestamp();

  // Build safe params excluding sensitive info
  const {
    level,
    action, // legacy
    ...rawParams
  } = input;

  const params: Record<string, any> = {};
  for (const [k, v] of Object.entries(rawParams)) {
    if (v === undefined || v === null) continue;
    if (k.toLowerCase().includes("password") || k.toLowerCase().includes("hash") || k.toLowerCase().includes("rawkey") || k.toLowerCase().includes("secret")) {
      continue;
    }
    if (typeof v === "string") {
      params[k] = redactSensitive(v);
    } else {
      params[k] = v;
    }
  }

  if (action) {
    params.action = action;
  }

  // normalize level
  let normLevel = level;
  if (level === "信息") normLevel = "INFO";
  if (level === "警告") normLevel = "WARN";
  if (level === "错误") normLevel = "ERROR";

  const code = input.code || "legacy.log";

  const event: ActionLogEvent = {
    id: crypto.randomUUID(),
    timestamp,
    level: normLevel,
    code,
    params,
    serverLine: "",
    ...params // inject top-level for legacy template compatibility
  };

  // Generate english server line
  const serverLine = renderActionLogServerLine(event, timestamp);
  event.serverLine = serverLine;
  event.line = serverLine; // backward compatibility

  // Output to PM2 / stdout
  if (normLevel === "ERROR") {
    console.error(serverLine);
  } else if (normLevel === "WARN") {
    console.warn(serverLine);
  } else {
    console.log(serverLine);
  }

  // Add to history
  logHistory.push(event);
  if (logHistory.length > MAX_HISTORY) {
    logHistory.shift();
  }

  // Emit to SSE subscribers
  for (const listener of listeners) {
    listener(event);
  }

  // Persist to file
  const data = serverLine + "\n";
  const dataBytes = Buffer.byteLength(data);
  if (currentFileBytes + dataBytes > MAX_FILE_BYTES && currentFileBytes > 0) {
    try {
      rotateLogFile(LOG_FILE, MAX_ROTATED_FILES);
    } catch (err) {
      console.warn("警告：轮转日志文件失败", err);
    }
    currentFileBytes = 0;
  }
  currentFileBytes += dataBytes;
  fs.appendFile(LOG_FILE, data, (err) => {
    if (err) console.warn("警告：写入日志文件失败", err);
  });
}
