export function extractTextFromContent(content: any): string {
  if (!content) return "";
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((block: any) => {
        if (!block) return "";
        if (typeof block === "string") return block;
        if (block.type === "text" && typeof block.text === "string") {
          return block.text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  return "";
}

export function extractLastAssistantContent(messages: any[]): string | null {
  for (let i = messages.length - 2; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      const msg = messages[i];

      // For thinking models (qwen, deepseek, etc.), the client may send back
      // reasoning_content as a separate field. We only want `content` because
      // the streaming path only accumulates delta.content (not delta.reasoning_content).
      if (msg.content) {
        const textContent = extractTextFromContent(msg.content);
        if (textContent) return textContent;
        return typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
      } else if (msg.tool_calls && msg.tool_calls.length > 0) {
        return JSON.stringify(msg.tool_calls.map((tc: any) => ({
          id: tc.id,
          function: tc.function?.name
        })));
      }
      return null;
    }
  }
  return null;
}
