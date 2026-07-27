import { ModelTranslator, TranslatorState, TranslatorContext } from "./types";

function isGoogleThoughtPayload(payload: any, context?: TranslatorContext): boolean {
  const modelId = (context?.modelId || "").toLowerCase();
  return (
    context?.providerProtocol === "google" ||
    modelId.includes("gemma") ||
    modelId.includes("gemini") ||
    payload?.extra_content?.google?.thought === true
  );
}

function splitThoughtTags(text: string, state: TranslatorState) {
  let remaining = text;
  let content = "";
  let reasoning = "";
  let modified = false;

  while (remaining) {
    if (state.isInsideGoogleThoughtTag) {
      const closeIndex = remaining.indexOf("</thought>");
      if (closeIndex === -1) {
        reasoning += remaining;
        remaining = "";
      } else {
        reasoning += remaining.slice(0, closeIndex);
        remaining = remaining.slice(closeIndex + "</thought>".length);
        state.isInsideGoogleThoughtTag = false;
        modified = true;
      }
      continue;
    }

    const openIndex = remaining.indexOf("<thought>");
    const strayCloseIndex = remaining.indexOf("</thought>");

    if (openIndex === -1) {
      if (strayCloseIndex === -1) {
        content += remaining;
        remaining = "";
      } else {
        content += remaining.slice(0, strayCloseIndex);
        remaining = remaining.slice(strayCloseIndex + "</thought>".length);
        modified = true;
      }
      continue;
    }

    content += remaining.slice(0, openIndex);
    remaining = remaining.slice(openIndex + "<thought>".length);
    state.isInsideGoogleThoughtTag = true;
    state.isGoogleGemmaStream = true;
    modified = true;
  }

  return {
    content,
    reasoning,
    modified,
  };
}

export const googleGemmaTranslator: ModelTranslator = {
  name: "google-gemma-thought",

  translateStreamChunk(chunk: any, state: TranslatorState, context?: TranslatorContext): boolean {
    const delta = chunk?.choices?.[0]?.delta;

    if (!delta) return false;
    if (!isGoogleThoughtPayload(delta, context)) return false;

    // Auto-detect Google Gemma stream by the presence of the thought flag
    if (delta.extra_content?.google?.thought === true) {
      state.isGoogleGemmaStream = true;
    }

    if (typeof delta.content !== "string") return false;

    const isMetadataThought = delta.extra_content?.google?.thought === true;
    const hasThoughtTags =
      delta.content.includes("<thought>") ||
      delta.content.includes("</thought>") ||
      state.isInsideGoogleThoughtTag;

    let content = "";
    let reasoning = "";
    let modified = false;

    if (hasThoughtTags) {
      const split = splitThoughtTags(delta.content, state);
      content = split.content;
      reasoning = split.reasoning;
      modified = split.modified || content !== delta.content || reasoning.length > 0;
    } else if (isMetadataThought) {
      reasoning = delta.content;
      modified = true;
    } else {
      return false;
    }

    if (reasoning) {
      delta.reasoning_content = `${delta.reasoning_content || ""}${reasoning}`;
    }

    if (content) {
      delta.content = content;
    } else {
      delete delta.content;
    }

    if (modified) {
      delete delta.extra_content;
    }
    return modified;
  },

  translateNonStreamMessage(message: any, context?: TranslatorContext): boolean {
    if (!message || typeof message.content !== "string") {
      return false;
    }
    if (!isGoogleThoughtPayload(message, context)) return false;

    const contentString = message.content;
    let modified = false;

    if (message.extra_content?.google?.thought === true) {
      const split = splitThoughtTags(contentString, {});
      message.reasoning_content = split.reasoning || split.content;
      message.content = split.reasoning ? split.content.trim() : "";
      delete message.extra_content;
      modified = true;
    } else if (contentString.includes("<thought>")) {
      // Content contains <thought> tags — extract reasoning and keep the rest
      const split = splitThoughtTags(contentString, {});
      message.reasoning_content = split.reasoning;
      message.content = split.content.trim();
      modified = true;
    }

    return modified;
  }
};
