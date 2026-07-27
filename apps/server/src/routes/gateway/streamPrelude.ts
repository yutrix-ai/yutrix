import type { FastifyReply } from "fastify";
import {
  isAnthropicStreamProtocol,
  formatStreamKeepAlive,
  writeStreamHeaders,
} from "./streamProtocol";

export const STREAM_PRELUDE_INTERVAL_MS = 2500;

export interface StreamPreludeOptions {
  anthropicMessage?: {
    messageId: string;
    modelId: string;
    promptTokens: number;
  };
}

function formatAnthropicMessageStart(message: NonNullable<StreamPreludeOptions["anthropicMessage"]>): string {
  return `event: message_start\ndata: ${JSON.stringify({
    type: "message_start",
    message: {
      id: message.messageId,
      type: "message",
      role: "assistant",
      content: [],
      model: message.modelId,
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: message.promptTokens,
        output_tokens: 0,
      },
    },
  })}\n\n`;
}

export function startStreamPrelude(
  reply: FastifyReply,
  protocol?: string,
  options: StreamPreludeOptions = {},
): () => void {
  let stopped = false;
  let interval: NodeJS.Timeout | undefined;

  const stop = () => {
    stopped = true;
    if (interval) {
      clearInterval(interval);
      interval = undefined;
    }
  };

  const writeKeepAlive = () => {
    if (stopped || reply.raw.destroyed || reply.raw.writableEnded) {
      stop();
      return;
    }
    try {
      reply.raw.write(formatStreamKeepAlive(protocol));
    } catch {
      stop();
    }
  };

  writeStreamHeaders(reply);

  const shouldEmitAnthropicMessageStart =
    isAnthropicStreamProtocol(protocol) &&
    options.anthropicMessage &&
    !(reply.raw as any).__promptgateAnthropicMessageStarted;

  if (shouldEmitAnthropicMessageStart) {
    reply.raw.write(formatAnthropicMessageStart(options.anthropicMessage!));
    (reply.raw as any).__promptgateAnthropicMessageStarted = true;
  } else {
    writeKeepAlive();
  }
  interval = setInterval(writeKeepAlive, STREAM_PRELUDE_INTERVAL_MS);
  return stop;
}
