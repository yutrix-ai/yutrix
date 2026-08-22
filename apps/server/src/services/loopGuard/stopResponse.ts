import type { FastifyReply } from "fastify";
import type { LoopStopReason } from "./types";

export function buildLoopStopHttpPayload(options: {
  protocol: string;
  streaming: boolean;
  modelId: string;
  reason: LoopStopReason;
  message: string;
}): {
  status: 200;
  finishReason: "stop" | "end_turn";
  headers: Record<string, string>;
  body: any;
  sseChunks: string[];
} {
  const isAnthropic = options.protocol === "anthropic";
  const finishReason = isAnthropic ? "end_turn" : "stop";
  const headers = {
    "x-yutrix-loop-stop": options.reason,
  };

  if (isAnthropic) {
    const body = {
      id: `msg_loop_${options.reason}`,
      type: "message",
      role: "assistant",
      model: options.modelId,
      content: [{ type: "text", text: options.message }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    };
    const sseChunks = options.streaming
      ? [
          `event: message_start\ndata: ${JSON.stringify({
            type: "message_start",
            message: { ...body, content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } },
          })}\n\n`,
          `event: content_block_start\ndata: ${JSON.stringify({
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          })}\n\n`,
          `event: content_block_delta\ndata: ${JSON.stringify({
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: options.message },
          })}\n\n`,
          `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
          `event: message_delta\ndata: ${JSON.stringify({
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: 0 },
          })}\n\n`,
          `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
        ]
      : [];
    return { status: 200, finishReason, headers, body, sseChunks };
  }

  const body = {
    id: `chatcmpl-loop-${options.reason}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: options.modelId,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: options.message },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };

  const streamId = body.id;
  const sseChunks = options.streaming
    ? [
        `data: ${JSON.stringify({
          id: streamId,
          object: "chat.completion.chunk",
          created: body.created,
          model: options.modelId,
          choices: [{ index: 0, delta: { role: "assistant", content: options.message }, finish_reason: null }],
        })}\n\n`,
        `data: ${JSON.stringify({
          id: streamId,
          object: "chat.completion.chunk",
          created: body.created,
          model: options.modelId,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        })}\n\n`,
        "data: [DONE]\n\n",
      ]
    : [];

  return { status: 200, finishReason, headers, body, sseChunks };
}

export function serveLoopStopResponse(options: {
  reply: FastifyReply;
  protocol: string;
  streaming: boolean;
  modelId: string;
  reason: LoopStopReason;
  message: string;
}): { status: 200; data: any; isStream: false } {
  const payload = buildLoopStopHttpPayload(options);
  try {
    options.reply.header?.("x-yutrix-loop-stop", options.reason);
  } catch {
    /* reply mocks may omit header() */
  }

  if (options.streaming) {
    if (!options.reply.raw.headersSent) {
      options.reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        "x-yutrix-loop-stop": options.reason,
      });
    }
    for (const chunk of payload.sseChunks) {
      options.reply.raw.write(chunk);
    }
    options.reply.raw.end();
  } else {
    options.reply.code(200).send(payload.body);
  }

  return { status: 200, data: payload.body, isStream: false };
}
