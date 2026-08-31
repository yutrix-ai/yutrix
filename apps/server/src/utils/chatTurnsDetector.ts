import { extractTextFromContent } from "./chatText";
import { looksLikeTitleGenerationText, tryParseJson } from "./chatTurnsUtils";
import { getMessagesFromParsedRequest, selectCurrentInputMessages } from "./chatTurnsFormatter";

/**
 * Client sidecar envelopes are application-level (Claude Code Stage 1, future
 * Cursor/Codex permission checks, etc.). They are not Anthropic/OpenAI wire
 * protocol. Strategy routing must not classify embedded user/tool text inside
 * them, and sticky model lookup must not treat them as the previous turn.
 *
 * Require both a severity-only output contract and a harm-classifier frame so
 * a real user asking to "review this transcript" is not swallowed.
 */
const CLIENT_SIDECAR_SEVERITY_DIRECTIVE = /respond with\s*<severity\b/i;
const CLIENT_SIDECAR_SEVERITY_TAG = /<\s*severity\s*>\s*n\s*<\s*\/\s*severity\s*>/i;
const CLIENT_SIDECAR_HARM_FRAME =
  /grade harm only|stage 1 does not apply user intent|do not apply user intent or allow exceptions/i;

export function looksLikeClientSidecarText(text: string | null | undefined): boolean {
  if (!text) return false;
  const hasDirective =
    CLIENT_SIDECAR_SEVERITY_DIRECTIVE.test(text) ||
    CLIENT_SIDECAR_SEVERITY_TAG.test(text);
  if (!hasDirective) return false;
  return CLIENT_SIDECAR_HARM_FRAME.test(text);
}

function collectMessageTexts(messages: any[]): string[] {
  const texts: string[] = [];
  for (const msg of messages) {
    const content = msg?.content;
    if (typeof content === "string") {
      if (content.trim()) texts.push(content);
      continue;
    }
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block) continue;
        if (typeof block === "string") {
          if (block.trim()) texts.push(block);
        } else if (block.type === "text" && typeof block.text === "string") {
          if (block.text.trim()) texts.push(block.text);
        }
      }
      continue;
    }
    const text = extractTextFromContent(content);
    if (text) texts.push(text);
  }
  return texts;
}

export function looksLikeClientSidecarRequestRaw(body: any): boolean {
  if (!body) return false;
  if (typeof body === "string") return looksLikeClientSidecarText(body);

  const messages = getMessagesFromParsedRequest(body);
  const currentInput = selectCurrentInputMessages(messages);
  const currentTexts = collectMessageTexts(currentInput.messages);
  if (looksLikeClientSidecarText(currentTexts.join("\n"))) return true;

  if (typeof body.prompt === "string" && looksLikeClientSidecarText(body.prompt)) {
    return true;
  }
  return false;
}

function isAllowedContinuationTextBlock(text: string, cacheControlPresent: boolean): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;

  if (trimmed.includes("<system-reminder>") || trimmed.includes("<system_reminder>")) return true;
  if (trimmed.includes("</system-reminder>") || trimmed.includes("</system_reminder>")) return true;
  if (trimmed.includes("<task-notification>") || trimmed.includes("</task-notification>")) return true;
  if (trimmed.includes("<transcript>") || trimmed.includes("</transcript>")) return true;
  if (trimmed.includes("qqrrrrqqquuuuqqq") || trimmed.includes("vvxxxxvvvddddvvv")) return true;
  if (trimmed.startsWith("[Request interrupted")) return true;

  return false;
}

export function isGeneratedToolContinuationMessage(msg: any): boolean {
  if (!msg) return false;
  const content = msg.content;
  if (!content) return false;

  let blocks: any[] = [];
  if (Array.isArray(content)) {
    blocks = content;
  } else if (typeof content === "object") {
    blocks = [content];
  } else {
    return false;
  }

  let hasToolResult = false;
  let hasImage = false;
  let hasRealUserText = false;

  for (const block of blocks) {
    if (!block) continue;
    if (typeof block === "string") {
      if (!isAllowedContinuationTextBlock(block, false)) {
        hasRealUserText = true;
      }
      continue;
    }

    if (block.type === "tool_result" || block.role === "tool") {
      hasToolResult = true;
      continue;
    }

    if (
      block.type === "image" ||
      block.type === "image_url" ||
      block.type === "input_image" ||
      block.type === "input-image" ||
      block.image_url !== undefined ||
      block.image !== undefined ||
      block.source?.type === "base64"
    ) {
      hasImage = true;
      continue;
    }

    if (block.type === "text" && typeof block.text === "string") {
      const isCacheControl = block.cache_control !== undefined || (typeof block.metadata === "object" && block.metadata?.cache_control);
      if (!isAllowedContinuationTextBlock(block.text, isCacheControl)) {
        hasRealUserText = true;
      }
      continue;
    }

    hasRealUserText = true;
  }

  return hasToolResult && !hasImage && !hasRealUserText;
}

/**
 * Detect if a raw request body represents an unambiguous "continuation" request.
 * Operates directly on the object to bypass the CPU overhead of JSON.stringify/parse
 * which causes massive event loop blocking on payloads with base64 images.
 */
export function looksLikeContinuationRequestRaw(body: any): boolean {
  if (!body) return false;

  const messages = getMessagesFromParsedRequest(body);
  const currentInput = selectCurrentInputMessages(messages);

  if (currentInput.messages.length === 0) return false;

  // 1. All current messages are tool results / continuations
  const isToolContinuation = currentInput.messages.every((msg: any) => {
    if (!msg) return false;
    if (msg.role === "tool") return true;
    if (msg.role === "user") {
      return isGeneratedToolContinuationMessage(msg);
    }
    return false;
  });

  if (isToolContinuation) {
    return true;
  }

  // 2. Collect all text from the current input messages for pattern matching
  // [IMPORTANT] We collect text blocks individually (not joined per-message) to
  // avoid the greedy regex ^<system-reminder>[\s\S]*</system-reminder>$ from
  // swallowing <user_input> content between two system-reminder blocks.
  // Also detect image content blocks — an image means this is a real user turn.
  const currentTexts: string[] = [];
  let hasImageBlock = false;
  for (const msg of currentInput.messages) {
    const content = msg?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block) continue;
        if (typeof block === "string") {
          if (block.trim()) currentTexts.push(block.trim());
        } else if (block.type === "text" && typeof block.text === "string") {
          const trimmed = block.text.trim();
          if (trimmed) currentTexts.push(trimmed);
        } else if (
          block.type === "image" || block.type === "image_url" ||
          block.type === "input_image" || block.type === "input-image" ||
          block.image_url !== undefined || block.image !== undefined
        ) {
          hasImageBlock = true;
        }
      }
    } else {
      const text = extractTextFromContent(content);
      if (text) currentTexts.push(text);
    }
  }

  // Image content blocks = real user turn, never a continuation
  if (hasImageBlock) return false;

  const combinedText = currentTexts.join("\n");

  // 3. Check for pure continuation prompt from the user (e.g. "继续", "continue")
  const normalizedCombined = combinedText.trim().toLowerCase();
  if (
    /^(continue|go on|keep going|next|cont|proceed)$/i.test(normalizedCombined) ||
    /^(继续|继续吧|接着说|接着写|接着做|继续往下|继续说|继续写)$/.test(normalizedCombined)
  ) {
    return true;
  }

  // 4. Check for title generation
  if (combinedText && looksLikeTitleGenerationText(combinedText)) {
    return true;
  }

  // 5. Check for system-reminder patterns
  // Each text block is checked individually to prevent greedy regex from
  // swallowing user content between two system-reminder blocks.
  if (combinedText.includes("<system-reminder>")) {
    const hasUserVisibleText = currentTexts.some((text) => {
      return text && !/^<system-reminder>[\s\S]*<\/system-reminder>$/i.test(text);
    });
    if (!hasUserVisibleText) return true;
    // If there IS user-visible text alongside system-reminder, it's a new user turn
    return false;
  }

  // 6. Claude Code patterns: interrupted requests, skill calls, web content
  if (
    combinedText.includes("[Request interrupted") ||
    combinedText.includes("Web page content:") ||
    combinedText.includes("Base directory for this skill:")
  ) {
    return true;
  }

  return false;
}

/**
 * Detect if a normalized inputText represents an unambiguous "continuation"
 * request — i.e., a request that CANNOT be a new user-initiated conversation.
 *
 * Currently detects:
 * 1. Tool result messages (role: "tool") — model's tool call results being sent back
 * 2. Auto-generated title requests — coding assistants auto-generating session titles
 */
export function looksLikeContinuationRequest(normalizedInputText: string | null): boolean {
  if (!normalizedInputText) return false;

  const trimmed = normalizedInputText.trim().toLowerCase();
  if (
    /^(continue|go on|keep going|next|cont|proceed)$/i.test(trimmed) ||
    /^(继续|继续吧|接着说|接着写|接着做|继续往下|继续说|继续写)$/.test(trimmed)
  ) {
    return true;
  }

  const parsed = tryParseJson(normalizedInputText);
  if (Array.isArray(parsed) && parsed.length > 0) {
    if (parsed.every((msg: any) => {
      if (!msg) return false;
      if (msg.role === "tool") return true;
      if (msg.role === "user") {
        const content = msg.content;
        if (Array.isArray(content)) {
          return content.length > 0 && content.every((block: any) => block?.type === "tool_result");
        }
        if (content && typeof content === "object") {
          return content.type === "tool_result";
        }
      }
      return false;
    })) {
      return true;
    }
  }

  if (looksLikeTitleGenerationText(normalizedInputText)) {
    return true;
  }

  if (normalizedInputText.includes("<system-reminder>")) {
    if (Array.isArray(parsed)) {
      const hasUserVisibleText = parsed.some((block: any) => {
        const text = typeof block?.text === "string" ? block.text.trim() : "";
        return text && !/^<system-reminder>[\s\S]*<\/system-reminder>$/i.test(text);
      });
      if (hasUserVisibleText) return false;
    }
    return true;
  }

  // Claude Code patterns: interrupted requests, skill calls, web content
  if (
    normalizedInputText.includes("[Request interrupted") ||
    normalizedInputText.includes("Web page content:") ||
    normalizedInputText.includes("Base directory for this skill:")
  ) {
    return true;
  }

  return false;
}

/**
 * Heuristically detect the AI client (e.g. Claude Code, OpenCode, Xcode, Cursor, Augment Code)
 * based on headers, request path, and body content.
 */
export function detectAIClient(
  headers: Record<string, string | string[] | undefined>,
  body: any,
  path: string
): string | null {
  const userAgent = String(headers["user-agent"] || "").toLowerCase();
  const anthropicClient = String(headers["x-anthropic-client"] || "").toLowerCase();

  // 1. Check headers first
  if (anthropicClient.includes("claude-code") || userAgent.includes("claude-code") || path.startsWith("/v0/messages")) {
    return "Claude Code";
  }
  if (userAgent.includes("codex-cli") || userAgent.includes("codex") || userAgent.includes("opencode")) {
    return "Codex CLI";
  }
  if (userAgent.includes("xcode") || userAgent.includes("copilotforxcode") || userAgent.includes("copilot-xcode")) {
    return "Xcode";
  }
  if (userAgent.includes("cursor") || headers["x-cursor-client"]) {
    return "Cursor";
  }
  if (userAgent.includes("augment")) {
    return "Augment Code";
  }
  if (userAgent.includes("vscode")) {
    return "VS Code";
  }
  if (userAgent.includes("intellij") || userAgent.includes("jetbrains")) {
    return "JetBrains";
  }
  if (userAgent.includes("cline")) {
    return "Cline";
  }
  if (userAgent.includes("roo-code")) {
    return "Roo Code";
  }
  // Pi runtime clients (rakazo OS-agent et al.). pi-ai sends
  // "pi (<platform> <release>; <arch>)" or "pi (browser)".
  if (
    userAgent.includes("rakazo") ||
    userAgent.includes("pi-ai") ||
    userAgent.startsWith("pi (") ||
    userAgent.startsWith("pi/")
  ) {
    return "Rakazo / Pi Agent";
  }

  // 2. Check path
  if (path.startsWith("/v0/messages")) {
    return "Claude Code";
  }

  // 3. Inspect request body / prompt contents
  const messages = getMessagesFromParsedRequest(body);
  let systemPrompt = "";
  let firstUserPrompt = "";

  for (const msg of messages) {
    if (msg?.role === "system") {
      systemPrompt += " " + extractTextFromContent(msg.content);
    } else if (msg?.role === "user" && !firstUserPrompt) {
      firstUserPrompt = extractTextFromContent(msg.content);
    }
  }

  // Only detect based on body content if we lack strong header hints
  // But be strict: only if it's explicitly in the system prompt or VERY unambiguous
  if (!anthropicClient && !headers["x-cursor-client"]) {
    const combinedPrompts = (systemPrompt + " " + firstUserPrompt).toLowerCase();

    if (systemPrompt.toLowerCase().includes("you are claude code") || firstUserPrompt.toLowerCase().includes("you are claude code")) {
      return "Claude Code";
    }
    if (systemPrompt.toLowerCase().includes("you are codex") || systemPrompt.toLowerCase().includes("codex-cli") || combinedPrompts.includes("opencode")) {
      return "Codex CLI";
    }
    if (systemPrompt.toLowerCase().includes("you are cline") || systemPrompt.toLowerCase().includes("cline")) {
      return "Cline";
    }
    if (systemPrompt.toLowerCase().includes("you are roo") || systemPrompt.toLowerCase().includes("roo code") || systemPrompt.toLowerCase().includes("roo-code")) {
      return "Roo Code";
    }
    if (systemPrompt.toLowerCase().includes("xcode")) {
      return "Xcode";
    }
    if (systemPrompt.toLowerCase().includes("augment code") || combinedPrompts.includes("succinct title for a coding session")) {
      return "Augment Code";
    }
    if (systemPrompt.toLowerCase().includes("cursor") || systemPrompt.toLowerCase().includes("expert ai programming assistant") || combinedPrompts.includes("generate a title for this conversation")) {
      return "Cursor";
    }
  }

  return null;
}
