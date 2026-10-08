// Gemini reads a `$ref` key inside function_response.response as a pointer to a
// multimodal part display_name and 400s when none matches (e.g. OpenAPI dumps).
// Also matches the escaped form for JSON nested inside JSON strings.
const REF_KEY_PATTERN = String.raw`(\\?")\$ref(\\?"\s*:)`;

function escapeRefKeys(text: string): string {
  return text.replace(new RegExp(REF_KEY_PATTERN, "g"), "$1_ref$2");
}

function hasRefKey(text: string): boolean {
  return new RegExp(REF_KEY_PATTERN).test(text);
}

function toolResultTexts(message: any): string[] {
  if (message?.role !== "tool") return [];
  const content = message.content;
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text);
}

export function hasToolResultRefKeys(body: any): boolean {
  if (!Array.isArray(body?.messages)) return false;
  return body.messages.some((message: any) => toolResultTexts(message).some(hasRefKey));
}

/** Returns the number of tool messages rewritten. */
export function escapeToolResultRefs(body: any): number {
  if (!Array.isArray(body?.messages)) return 0;
  let messageCount = 0;

  for (const message of body.messages) {
    if (message?.role !== "tool") continue;
    const content = message.content;

    if (typeof content === "string") {
      const next = escapeRefKeys(content);
      if (next === content) continue;
      message.content = next;
      messageCount++;
      continue;
    }
    if (!Array.isArray(content)) continue;

    let changed = false;
    const next = content.map((part: any) => {
      if (part?.type !== "text" || typeof part.text !== "string") return part;
      const text = escapeRefKeys(part.text);
      if (text === part.text) return part;
      changed = true;
      return { ...part, text };
    });
    if (!changed) continue;
    message.content = next;
    messageCount++;
  }

  return messageCount;
}
