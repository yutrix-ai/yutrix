import { classifyGatewayRequestClass } from "../requestRoutingClass";
import { tryParseJson } from "../../utils/chatTurns";

export function looksLikeToolContinuationInputText(inputText: string | null | undefined): boolean {
  if (!inputText || typeof inputText !== "string") return false;
  try {
    const parsed = tryParseJson(inputText);
    const body = Array.isArray(parsed)
      ? { messages: parsed }
      : parsed && typeof parsed === "object"
        ? parsed
        : { messages: [{ role: "user", content: inputText }] };
    return classifyGatewayRequestClass(body).requestClass === "tool_continuation";
  } catch {
    return false;
  }
}

export function evaluateResponseCacheWrite(
  inputText: string,
): { ok: true } | { ok: false; status: 400; error: string } {
  if (looksLikeToolContinuationInputText(inputText)) {
    return {
      ok: false,
      status: 400,
      error: "Cannot cache a tool_continuation turn",
    };
  }
  return { ok: true };
}

export function shouldSkipResponseCacheServe(body: any): boolean {
  try {
    return classifyGatewayRequestClass(body).requestClass === "tool_continuation";
  } catch {
    return false;
  }
}
