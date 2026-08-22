import { classifyGatewayRequestClass } from "../requestRoutingClass";
import {
  computeContentHash,
  getMessagesFromParsedRequest,
  selectCurrentInputMessages,
  tryParseJson,
} from "../../utils/chatTurns";

/**
 * Per-call identifiers that must not distinguish otherwise-identical tool results.
 * Open for new wire names (OpenAI tool_call_id, Anthropic tool_use_id, …).
 */
export function shouldDropFingerprintKey(key: string): boolean {
  const compact = key.replace(/[_-]/g, "").toLowerCase();
  if (
    compact === "id" ||
    compact === "uuid" ||
    compact === "timestamp" ||
    compact === "createdat" ||
    compact === "updatedat" ||
    compact === "time" ||
    compact === "eventid" ||
    compact === "messageid" ||
    compact === "requestid"
  ) {
    return true;
  }
  if (compact === "callid" || compact === "toolcallid" || compact === "tooluseid") {
    return true;
  }
  return /(?:tool)?(?:call|use)id$/.test(compact);
}
const UUID_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ISO_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g;

const ERROR_RE =
  /no such file|not found|enoent|command not found|permission denied|eacces|no such directory|不存在|找不到/i;

export function parseIfJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const parsed = tryParseJson(value);
  return parsed === null ? value : parsed;
}

export function normalizeLoopValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    const parsed = tryParseJson(value);
    if (parsed !== null && typeof parsed === "object") {
      return normalizeLoopValue(parsed);
    }
    return value.replace(UUID_RE, "").replace(ISO_RE, "").trim();
  }
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(normalizeLoopValue);

  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    if (shouldDropFingerprintKey(key)) continue;
    out[key] = normalizeLoopValue((value as Record<string, unknown>)[key]);
  }
  return out;
}

function harvest(value: unknown, bag: { texts: string[]; exitCodes: number[] }): void {
  if (value === null || value === undefined) return;
  if (typeof value === "string") {
    bag.texts.push(value);
    const parsed = tryParseJson(value);
    if (parsed !== null && parsed !== value) harvest(parsed, bag);
    return;
  }
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    for (const item of value) harvest(item, bag);
    return;
  }
  if (typeof value === "object") {
    const rec = value as Record<string, unknown>;
    if (typeof rec.exitCode === "number") bag.exitCodes.push(rec.exitCode);
    if (typeof rec.exit_code === "number") bag.exitCodes.push(rec.exit_code);
    for (const nested of Object.values(rec)) harvest(nested, bag);
  }
}

export function isErrorClassPayload(payload: unknown): boolean {
  const bag = { texts: [] as string[], exitCodes: [] as number[] };
  harvest(payload, bag);
  if (bag.exitCodes.some((code) => code !== 0)) return true;
  return bag.texts.some((text) => ERROR_RE.test(text));
}

export function fingerprintCurrentTurn(body: any): {
  fingerprint: string;
  isErrorClass: boolean;
  payload: unknown;
  kind: "user_intent" | "continuation" | "other";
} {
  const requestClass = classifyGatewayRequestClass(body);
  const kind =
    requestClass.requestClass === "tool_continuation"
      ? "continuation"
      : requestClass.requestClass === "user_intent"
        ? "user_intent"
        : "other";

  const messages = selectCurrentInputMessages(getMessagesFromParsedRequest(body)).messages;
  const payload = normalizeLoopValue(
    messages.map((message: any) => ({
      role: message?.role,
      content: parseIfJson(message?.content),
    })),
  );
  const fingerprint = computeContentHash(JSON.stringify(payload));
  return {
    fingerprint,
    isErrorClass: kind === "continuation" && isErrorClassPayload(payload),
    payload,
    kind,
  };
}
