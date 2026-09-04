import pino from "pino";
import { OpencodeService } from "./opencodeService";
import {
  assertNoSpoofHeaders,
  buildOpencodeUserText,
  extractOpencodeSessionId,
  joinOpencodeTextParts,
  mapOpencodeHttpError,
  OPENCODE_CHAT_ONLY_RETRY_NUDGE,
  sanitizeOpencodeAssistantText,
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
  const first = await postSessionMessage({
    service,
    sessionId,
    providerId,
    modelId,
    text: userText,
    headers,
    signal,
  });
  if (!first.ok) {
    logger.warn({ status: first.status, text: first.text, sessionId }, "OpenCode message failed");
    return errorResult(first.status, first.text, incomingProtocol);
  }

  let responseText = sanitizeOpencodeAssistantText(joinOpencodeTextParts(first.data));
  if (responseText) {
    return successResult(modelId, sessionId, responseText, incomingProtocol);
  }

  const retry = await postSessionMessage({
    service,
    sessionId,
    providerId,
    modelId,
    text: `${OPENCODE_CHAT_ONLY_RETRY_NUDGE}\n\n${userText}`,
    headers,
    signal,
  });
  if (!retry.ok) {
    logger.warn({ status: retry.status, text: retry.text, sessionId }, "OpenCode chat-only retry failed");
    return errorResult(retry.status, retry.text, incomingProtocol);
  }

  responseText = sanitizeOpencodeAssistantText(joinOpencodeTextParts(retry.data));
  if (responseText) {
    return successResult(modelId, sessionId, responseText, incomingProtocol);
  }

  logger.warn({ sessionId }, "OpenCode reply was tool markup only after retry");
  return errorResult(
    502,
    "OpenCode returned no plain-text reply (tool markup only)",
    incomingProtocol,
  );
}

async function postSessionMessage(opts: {
  service: OpencodeService;
  sessionId: string;
  providerId: string;
  modelId: string;
  text: string;
  headers: Record<string, string>;
  signal: AbortSignal;
}): Promise<{ ok: true; data: any } | { ok: false; status: number; text: string }> {
  const msgRes = await fetch(opts.service.sidecarUrl(`/session/${opts.sessionId}/message`), {
    method: "POST",
    headers: opts.headers,
    body: JSON.stringify({
      model: {
        providerID: opts.providerId,
        modelID: opts.modelId,
      },
      parts: [{ type: "text", text: opts.text }],
    }),
    signal: opts.signal,
  });
  if (!msgRes.ok) {
    return { ok: false, status: msgRes.status, text: await readErrorText(msgRes) };
  }
  return { ok: true, data: await msgRes.json() };
}
