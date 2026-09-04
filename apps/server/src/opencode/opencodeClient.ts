import { OpencodeService } from "./opencodeService";
import pino from "pino";

const logger = pino({ name: "opencode-client" });

let opencodeMutex = Promise.resolve();
async function withOpencodeMutex<T>(fn: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const wait = new Promise<void>(r => release = r);
  const old = opencodeMutex;
  opencodeMutex = opencodeMutex.then(() => wait);
  await old;
  try {
    return await fn();
  } finally {
    release();
  }
}

export async function executeOpencodeSessionApi(
  body: any,
  providerId: string, // now the mapped provider slug like "openrouter"
  modelId: string,
  apiKey: string,
  controller: AbortController
) {
  const service = OpencodeService.getInstance();
  if (!service.isReady()) {
    throw new Error("OpenCode sidecar binary not installed");
  }
  if (!service.isRunning()) {
    await service.start();
  }
  const port = service.port;
  
  // 1. Sync key with mutex
  await withOpencodeMutex(async () => {
    await service.syncCredential(providerId, apiKey);
  });

  const signal = controller.signal;

  // 2. Create session
  const sessionReqBody = {
    title: "gateway request"
  };

  const createRes = await fetch(`http://127.0.0.1:${port}/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(sessionReqBody),
    signal,
  });

  if (!createRes.ok) {
    if (createRes.status === 429) {
       return { status: 429, error: await createRes.text(), isStream: false };
    }
    throw new Error(`OpenCode create session failed: ${createRes.status} ${await createRes.text()}`);
  }

  const sessionData = await createRes.json();
  const sessionId = sessionData?.id || sessionData?.data?.id;
  if (!sessionId) {
    throw new Error("OpenCode create session missing id");
  }

  // 3. Send message
  let text = "";
  if (Array.isArray(body.messages)) {
    const lastMsg = body.messages[body.messages.length - 1];
    text = typeof lastMsg.content === 'string' ? lastMsg.content : JSON.stringify(lastMsg.content);
  } else if (typeof body.prompt === 'string') {
    text = body.prompt;
  }

  const msgReqBody = {
    model: {
      providerID: providerId,
      modelID: modelId,
    },
    parts: [
      {
        type: "text",
        text: text
      }
    ]
  };

  const msgRes = await fetch(`http://127.0.0.1:${port}/session/${sessionId}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(msgReqBody),
    signal,
  });

  if (!msgRes.ok) {
    if (msgRes.status === 429) {
       return { status: 429, error: await msgRes.text(), isStream: false };
    }
    throw new Error(`OpenCode message failed: ${msgRes.status} ${await msgRes.text()}`);
  }

  const msgData = await msgRes.json();
  
  let responseText = "";
  if (Array.isArray(msgData?.parts)) {
    responseText = msgData.parts.filter((p: any) => p.type === "text").map((p: any) => p.text).join('');
  } else if (typeof msgData?.text === 'string') {
    responseText = msgData.text;
  } else if (typeof msgData?.data === 'string') {
    responseText = msgData.data;
  } else {
    responseText = JSON.stringify(msgData);
  }

  const openaiResponse = {
    id: "chatcmpl-" + sessionId,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: modelId,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: responseText,
        },
        finish_reason: "stop"
      }
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    }
  };

  return {
    status: 200,
    headers: msgRes.headers,
    responseData: openaiResponse,
    isStream: false,
    costContext: null,
  };
}
