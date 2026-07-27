import type { FastifyReply } from "fastify";

export type GatewayStreamProtocol = string | undefined;

export function isAnthropicStreamProtocol(protocol?: GatewayStreamProtocol): boolean {
  return protocol === "anthropic";
}

export function streamHeaders() {
  return {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  };
}

export function writeStreamHeaders(reply: FastifyReply, statusCode = 200) {
  if (reply.raw.headersSent) return;
  reply.raw.writeHead(statusCode, streamHeaders());
  if (typeof reply.raw.flushHeaders === "function") {
    reply.raw.flushHeaders();
  }
}

export function formatStreamKeepAlive(protocol?: GatewayStreamProtocol): string {
  return isAnthropicStreamProtocol(protocol)
    ? `event: ping\ndata: ${JSON.stringify({ type: "ping" })}\n\n`
    : ":\n\n";
}

export function formatStreamErrorEvent(
  protocol: GatewayStreamProtocol,
  statusCode: number,
  message: string,
  options: { type?: string; code?: string; canonicalErrorType?: string } = {},
): string {
  if (isAnthropicStreamProtocol(protocol)) {
    return `event: error\ndata: ${JSON.stringify({
      type: "error",
      error: {
        type: options.type || "api_error",
        message,
        ...(options.canonicalErrorType ? { error_type: options.canonicalErrorType } : {}),
      },
    })}\n\n`;
  }

  return `data: ${JSON.stringify({
    error: {
      message,
      type: options.type || "server_error",
      code: options.code || String(statusCode),
    },
  })}\n\n`;
}

export function writeStreamErrorResponse(
  reply: FastifyReply,
  protocol: GatewayStreamProtocol,
  statusCode: number,
  message: string,
  options?: { type?: string; code?: string; canonicalErrorType?: string },
) {
  if (reply.raw.destroyed || reply.raw.writableEnded) return;

  writeStreamHeaders(reply, statusCode);
  reply.raw.write(formatStreamErrorEvent(protocol, statusCode, message, options));
  reply.raw.end();
}
