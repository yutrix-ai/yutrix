import pino from "pino";
import { OpencodeService } from "./opencodeService";
import {
  assertNoSpoofHeaders,
  buildOpencodeUserText,
  extractOpencodeSessionId,
  joinOpencodeTextParts,
  mapOpencodeHttpError,
  toAnthropicMessage,
  toOpenAICompletion,
} from "./protocol";

const logger = pino({ name: "opencode-client" });

let opencodeMutex = Promise.resolve();

export async function withOpencodeMutex<T>(fn: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const previous = opencodeMutex;
  opencodeMutex = previous.then(() => wait);
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

export interface OpencodeSessionResult {
  status: number;
  data: any;
  isStream: false;
  responseProtocol: "openai" | "anthropic";
  errorDetail?: string;
  /** Session API is JSON-complete; gateway wraps streaming clients as fake SSE. */
  sidecarNonStream: true;
}

function sidecarFetchHeaders(service: OpencodeService): Record<string, string> {
  const headers = service.sidecarHeaders({ "Content-Type": "application/json" });
  assertNoSpoofHeaders(headers);
  return headers;
}

async function readErrorText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 2000);
  } catch {
    return res.statusText || "";
  }
}

function errorResult(
  status: number,
  bodyText: string,
  incomingProtocol: string,
): OpencodeSessionResult {
  const mapped = mapOpencodeHttpError(status, bodyText);
  return {
    status: mapped.status,
    data: mapped.data,
    isStream: false,
    responseProtocol: incomingProtocol === "anthropic" ? "anthropic" : "openai",
    errorDetail: mapped.data.error.message,
    sidecarNonStream: true,
  };
}

function successResult(
  modelId: string,
  sessionId: string,
  text: string,
  incomingProtocol: string,
): OpencodeSessionResult {
  const anthropic = incomingProtocol === "anthropic";
  return {
    status: 200,
    data: anthropic
      ? toAnthropicMessage(modelId, sessionId, text)
      : toOpenAICompletion(modelId, sessionId, text),
    isStream: false,
    responseProtocol: anthropic ? "anthropic" : "openai",
    sidecarNonStream: true,
  };
}

export async function executeOpencodeSessionApi(
  body: any,
  providerId: string,
  modelId: string,
  apiKey: string,
  controller: AbortController,
  incomingProtocol: string = "openai",
): Promise<OpencodeSessionResult> {
  const service = OpencodeService.getInstance();
  if (!service.isReady()) {
    throw new Error("OpenCode sidecar binary not installed");
  }

  await service.start();

  // Sticky rotate: gateway hops 429/401 to the next providerApiKeys row, then
  // re-enters here. Mutex serializes auth.json so concurrent calls cannot clobber.
  await withOpencodeMutex(() => service.syncCredential(providerId, apiKey));

  const signal = controller.signal;
  const headers = sidecarFetchHeaders(service);

  const createRes = await fetch(service.sidecarUrl("/session"), {
    method: "POST",
    headers,
    body: JSON.stringify({ title: "gateway request" }),
    signal,
  });

  if (!createRes.ok) {
    const text = await readErrorText(createRes);
    logger.warn({ status: createRes.status, text }, "OpenCode create session failed");
    return errorResult(createRes.status, text, incomingProtocol);
  }

  const sessionData = await createRes.json();
  const sessionId = extractOpencodeSessionId(sessionData);
  if (!sessionId) {
    throw new Error("OpenCode create session missing id");
  }

  const userText = buildOpencodeUserText(body);
  const msgReqBody = {
    model: {
      providerID: providerId,
      modelID: modelId,
    },
    parts: [{ type: "text", text: userText }],
  };

  const msgRes = await fetch(service.sidecarUrl(`/session/${sessionId}/message`), {
    method: "POST",
    headers,
    body: JSON.stringify(msgReqBody),
    signal,
  });

  if (!msgRes.ok) {
    const text = await readErrorText(msgRes);
    logger.warn({ status: msgRes.status, text, sessionId }, "OpenCode message failed");
    return errorResult(msgRes.status, text, incomingProtocol);
  }

  const msgData = await msgRes.json();
  const responseText = joinOpencodeTextParts(msgData);

  return successResult(modelId, sessionId, responseText, incomingProtocol);
}
