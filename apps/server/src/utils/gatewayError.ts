export const MAX_ERROR_DETAIL_LENGTH = 3000;

export function formatError(
  protocol: string,
  status: number,
  message: string,
  code?: string,
  options?: { type?: string; canonicalErrorType?: string }
) {
  if (protocol === "anthropic") {
    let errType = options?.type || "api_error";
    if (!options?.type) {
      if (status === 400) errType = "invalid_request_error";
      if (status === 401) errType = "authentication_error";
      if (status === 403) errType = "permission_error";
      if (status === 404) errType = "not_found_error";
      if (status === 429) errType = "rate_limit_error";
      if (status === 502) errType = "api_error";
      if (status === 504) errType = "overloaded_error";
    }
    const errObj: any = { type: errType, message };
    if (options?.canonicalErrorType) {
      errObj.error_type = options.canonicalErrorType;
    }
    return { type: "error", error: errObj };
  } else {
    // OpenAI mappings
    let errCode = code || "server_error";
    if (status === 401) errCode = "invalid_api_key";
    if (status === 403) errCode = "permission_denied";
    if (status === 404) errCode = "model_not_found";
    if (status === 429) errCode = "rate_limit_exceeded";
    return {
      error: {
        message,
        type: status >= 500 ? "server_error" : "invalid_request_error",
        param: null,
        code: errCode,
      },
    };
  }
}

export function getStatusReasonCN(status: number): string {
  switch (status) {
    case 429: return "上游限流";
    case 503: return "上游服务不可用";
    case 529: return "上游过载";
    default: return "上游错误";
  }
}

/**
 * Map canonical adapter errorType to Anthropic-compatible error.type.
 * See: https://docs.anthropic.com/en/api/errors
 */
export function mapErrorTypeToAnthropic(errorType: string): string {
  switch (errorType) {
    case "authentication":
      return "authentication_error";
    case "rate_limit_exceeded":
      return "rate_limit_error";
    case "invalid_request":
    case "context_length_exceeded":
    case "content_policy_violation":
      return "invalid_request_error";
    case "provider_overloaded":
      return "overloaded_error";
    case "provider_unavailable":
    case "timeout":
    case "server_error":
    case "upstream_error":
      return "api_error";
    default:
      return "api_error";
  }
}

export function truncateErrorDetail(value: unknown, maxLength = MAX_ERROR_DETAIL_LENGTH): string {
  const text = String(value ?? "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...(已截断 ${text.length - maxLength} 字符)`;
}

export function parseJsonIfPossible(text: string): unknown {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

export function stringifyErrorPayload(payload: unknown): string {
  if (typeof payload === "string") return payload;
  try {
    return JSON.stringify(payload);
  } catch {
    return String(payload);
  }
}

export function extractUpstreamRequestIds(response: Response): string {
  const headerNames = [
    "request-id",
    "x-request-id",
    "x-log-id",
    "x-amzn-requestid",
    "cf-ray",
  ];
  const parts: string[] = [];
  for (const name of headerNames) {
    const value = response.headers.get(name);
    if (value) parts.push(`${name}=${value}`);
  }
  return parts.join(" ");
}

export async function readUpstreamError(response: Response) {
  let bodyText = "";
  try {
    bodyText = await response.text();
  } catch (err: any) {
    bodyText = `读取上游错误响应失败: ${err?.message || String(err)}`;
  }

  const data = parseJsonIfPossible(bodyText);
  const bodyDetail = stringifyErrorPayload(data);
  const upstreamRequestIds = extractUpstreamRequestIds(response);
  const detail = truncateErrorDetail(
    [
      `上游状态=${response.status}`,
      response.statusText ? `上游状态文本=${response.statusText}` : "",
      upstreamRequestIds ? `上游请求ID=${upstreamRequestIds}` : "",
      `上游响应=${bodyDetail || "<empty>"}`,
    ].filter(Boolean).join(" "),
  );

  return { data, bodyText, detail, upstreamRequestIds };
}

export function describeFetchError(err: any): string {
  const cause = err?.cause;
  const causeParts = cause
    ? [
        cause.name ? `cause.name=${cause.name}` : "",
        cause.code ? `cause.code=${cause.code}` : "",
        cause.errno !== undefined ? `cause.errno=${cause.errno}` : "",
        cause.syscall ? `cause.syscall=${cause.syscall}` : "",
        cause.hostname ? `cause.hostname=${cause.hostname}` : "",
        cause.port !== undefined ? `cause.port=${cause.port}` : "",
        cause.message ? `cause.message=${cause.message}` : "",
      ].filter(Boolean).join(" ")
    : "";

  return truncateErrorDetail(
    [
      err?.name ? `错误名=${err.name}` : "",
      err?.message ? `错误消息=${err.message}` : "",
      causeParts ? `错误原因=${causeParts}` : "",
      err?.stack ? `堆栈=${String(err.stack).split("\n").slice(0, 4).join(" | ")}` : "",
    ].filter(Boolean).join(" "),
  );
}

export function describeGatewayErrorPayload(payload: unknown): string {
  return truncateErrorDetail(`响应=${stringifyErrorPayload(payload) || "<empty>"}`);
}
