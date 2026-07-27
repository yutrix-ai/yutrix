import { Brain, CheckCircle2, Copy, GitBranch, Image as ImageIcon, Sparkles, Terminal, User, Wrench, XCircle, Archive } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { parseReasoning, parseAssistantResponse } from "@/utils/chatParser";

const clientThemes: Record<string, {

  border: string;
  bg: string;
  text: string;
  dot: string;
  glow: string;
}> = {
  "claude code": {
    border: "border-amber-500/20 dark:border-amber-400/20",
    bg: "bg-amber-500/10 dark:bg-amber-400/5",
    text: "text-amber-700 dark:text-amber-300",
    dot: "bg-amber-500",
    glow: "shadow-[0_0_8px_rgba(245,158,11,0.1)] dark:shadow-[0_0_8px_rgba(245,158,11,0.05)]",
  },
  "cursor": {
    border: "border-indigo-500/20 dark:border-indigo-400/20",
    bg: "bg-indigo-500/10 dark:bg-indigo-400/5",
    text: "text-indigo-700 dark:text-indigo-300",
    dot: "bg-indigo-500",
    glow: "shadow-[0_0_8px_rgba(99,102,241,0.1)] dark:shadow-[0_0_8px_rgba(99,102,241,0.05)]",
  },
  "xcode": {
    border: "border-blue-500/20 dark:border-blue-400/20",
    bg: "bg-blue-500/10 dark:bg-blue-400/5",
    text: "text-blue-700 dark:text-blue-300",
    dot: "bg-blue-500",
    glow: "shadow-[0_0_8px_rgba(59,130,246,0.1)] dark:shadow-[0_0_8px_rgba(59,130,246,0.05)]",
  },
  "opencode": {
    border: "border-emerald-500/20 dark:border-emerald-400/20",
    bg: "bg-emerald-500/10 dark:bg-emerald-400/5",
    text: "text-emerald-700 dark:text-emerald-300",
    dot: "bg-emerald-500",
    glow: "shadow-[0_0_8px_rgba(16,185,129,0.1)] dark:shadow-[0_0_8px_rgba(16,185,129,0.05)]",
  },
  "augment": {
    border: "border-pink-500/20 dark:border-pink-400/20",
    bg: "bg-pink-500/10 dark:bg-pink-400/5",
    text: "text-pink-700 dark:text-pink-300",
    dot: "bg-pink-500",
    glow: "shadow-[0_0_8px_rgba(236,72,153,0.1)] dark:shadow-[0_0_8px_rgba(236,72,153,0.05)]",
  },
  "vscode": {
    border: "border-sky-500/20 dark:border-sky-400/20",
    bg: "bg-sky-500/10 dark:bg-sky-400/5",
    text: "text-sky-700 dark:text-sky-300",
    dot: "bg-sky-500",
    glow: "shadow-[0_0_8px_rgba(14,165,233,0.1)] dark:shadow-[0_0_8px_rgba(14,165,233,0.05)]",
  },
  "jetbrains": {
    border: "border-rose-500/20 dark:border-rose-400/20",
    bg: "bg-rose-500/10 dark:bg-rose-400/5",
    text: "text-rose-700 dark:text-rose-300",
    dot: "bg-rose-500",
    glow: "shadow-[0_0_8px_rgba(244,63,94,0.1)] dark:shadow-[0_0_8px_rgba(244,63,94,0.05)]",
  },
  "default": {
    border: "border-violet-500/20 dark:border-violet-400/20",
    bg: "bg-violet-500/10 dark:bg-violet-400/5",
    text: "text-violet-700 dark:text-violet-300",
    dot: "bg-violet-500",
    glow: "shadow-[0_0_8px_rgba(139,92,246,0.1)] dark:shadow-[0_0_8px_rgba(139,92,246,0.05)]",
  }
};

export const renderClientBadge = (clientName: string | null, size: "sm" | "md" = "sm") => {
  if (!clientName) return null;
  
  const nameLower = clientName.toLowerCase();
  let theme = clientThemes.default;
  
  if (nameLower.includes("claude code") || nameLower === "claude-code") {
    theme = clientThemes["claude code"];
  } else if (nameLower.includes("cursor")) {
    theme = clientThemes.cursor;
  } else if (nameLower.includes("xcode")) {
    theme = clientThemes.xcode;
  } else if (nameLower.includes("opencode")) {
    theme = clientThemes.opencode;
  } else if (nameLower.includes("augment")) {
    theme = clientThemes.augment;
  } else if (nameLower.includes("vscode") || nameLower.includes("vs code")) {
    theme = clientThemes.vscode;
  } else if (nameLower.includes("jetbrains") || nameLower.includes("idea") || nameLower.includes("clion") || nameLower.includes("webstorm")) {
    theme = clientThemes.jetbrains;
  }
  
  const isSm = size === "sm";
  
  return (
    <span 
      className={cn(
        "inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full font-medium border backdrop-blur-sm transition-all duration-300 shrink-0",
        isSm ? "text-[8px] tracking-wider py-[1px]" : "text-[10px] tracking-widest",
        theme.bg,
        theme.border,
        theme.text,
        theme.glow
      )}
      title={clientName}
    >
      <span className={cn("w-1.5 h-1.5 rounded-full animate-pulse shrink-0", theme.dot)} />
      <span className="uppercase">{clientName}</span>
    </span>
  );
};

type ChatMessageLike = {
  role?: string;
  content?: any;
  name?: string;
  tool_call_id?: string;
  tool_calls?: any;
};

function isContentBlock(value: any) {
  return value && typeof value === "object" && typeof value.type === "string" && !("role" in value);
}

function isMessageLike(value: any) {
  return value && typeof value === "object" && ("role" in value || "content" in value || "tool_calls" in value);
}

export function normalizeInputMessages(inputText: string | null): ChatMessageLike[] {
  if (!inputText) return [];

  try {
    const data = JSON.parse(inputText);
    if (Array.isArray(data)) {
      if (data.every(isContentBlock)) return [{ role: "user", content: data }];
      if (data.every(isMessageLike)) return data;
      return [{ role: "user", content: data }];
    } else if (data.messages && Array.isArray(data.messages)) {
      return data.messages;
    } else if (isMessageLike(data)) {
      return [data];
    } else if (data.prompt) {
      return [{ role: "user", content: data.prompt }];
    } else if (data.input) {
      return [{ role: "user", content: data.input }];
    }
    return [{ role: "user", content: data }];
  } catch (e) {
    return [{ role: "user", content: inputText }];
  }
}

export function getContentText(content: any): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (block?.type === "text" || block?.type === "input_text") return block.text;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function renderMessageContent(content: any) {
  if (content === null || content === undefined) {
    return <span className="text-muted-foreground">Empty</span>;
  }

  if (typeof content === "string") {
    return <div className="whitespace-pre-wrap break-words">{content}</div>;
  }

  if (Array.isArray(content)) {
    return (
      <div className="flex flex-col gap-2">
        {content.map((block: any, j: number) => {
          if (typeof block === "string") return <div key={j} className="whitespace-pre-wrap break-words">{block}</div>;
          if (block.type === "text" || block.type === "input_text") return <div key={j} className="whitespace-pre-wrap break-words">{block.text}</div>;
          if (block.type === "image_url") {
            const src = typeof block.image_url === "string" ? block.image_url : block.image_url?.url;
            return src ? (
              <img key={j} src={src} alt="Image content" className="max-h-[360px] max-w-full rounded-lg border object-contain" />
            ) : null;
          }
          if (block.type === "image" && block.source) {
            const src = block.source.data ? `data:${block.source.media_type};base64,${block.source.data}` : block.source.url;
            return src ? (
              <img key={j} src={src} alt="Image content" className="max-h-[360px] max-w-full rounded-lg border object-contain" />
            ) : null;
          }
          if (block.type === "tool_use") {
            return (
              <div key={j} className="flex flex-col gap-1.5 rounded-md border border-indigo-200 dark:border-indigo-900 bg-indigo-50/50 dark:bg-indigo-950/20 p-3">
                <div className="flex items-center gap-2 text-xs font-semibold text-indigo-700 dark:text-indigo-400">
                  <Wrench className="h-3.5 w-3.5" />
                  Tool Use: {block.name || "unknown"}
                </div>
                {block.input && (
                  <pre className="max-h-[260px] overflow-auto rounded bg-background/80 p-2 text-[11px] text-muted-foreground whitespace-pre-wrap break-all font-mono">
                    {typeof block.input === "string" 
                      ? block.input.replace(/\\n/g, '\n').replace(/\\"/g, '"') 
                      : JSON.stringify(block.input, null, 2)}
                  </pre>
                )}
              </div>
            );
          }
          if (block.type === "tool_result") {
            return (
              <div key={j} className={`flex flex-col gap-1.5 rounded-md border p-3 ${block.is_error ? 'border-red-200 dark:border-red-900 bg-red-50/50 dark:bg-red-950/20' : 'border-teal-200 dark:border-teal-900 bg-teal-50/50 dark:bg-teal-950/20'}`}>
                <div className={`flex items-center gap-2 text-xs font-semibold ${block.is_error ? 'text-red-700 dark:text-red-400' : 'text-teal-700 dark:text-teal-400'}`}>
                  {block.is_error ? <XCircle className="h-3.5 w-3.5" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                  Tool Result {block.tool_use_id ? `(${block.tool_use_id.split('_').pop()})` : ""}
                </div>
                {block.content && (
                  <pre className="max-h-[360px] overflow-auto rounded bg-background/80 p-2 text-[11px] text-muted-foreground whitespace-pre-wrap break-all font-mono">
                    {typeof block.content === "string" 
                      ? block.content.replace(/\\n/g, '\n').replace(/\\"/g, '"')
                      : (Array.isArray(block.content) 
                          ? block.content.map((c: any) => typeof c === 'string' ? c.replace(/\\n/g, '\n').replace(/\\"/g, '"') : c.text ? c.text.replace(/\\n/g, '\n').replace(/\\"/g, '"') : JSON.stringify(c)).join('\n')
                          : JSON.stringify(block.content, null, 2))}
                  </pre>
                )}
              </div>
            );
          }
          return (
            <div key={j} className="flex items-center gap-2 rounded-md border bg-background/60 px-3 py-2 text-xs text-muted-foreground">
              <ImageIcon className="h-3.5 w-3.5" />
              {block.type || "unknown"}
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <pre className="max-h-[300px] overflow-auto rounded-md border bg-background/70 p-3 text-xs text-muted-foreground">
      {JSON.stringify(cleanRawJsonForDisplay(content), null, 2)}
    </pre>
  );
}

interface MarkdownBlock {
  type: 'code' | 'paragraph' | 'list';
  content: string;
  language?: string;
  items?: string[];
}

function parseMarkdown(text: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const lines = text.split('\n');
  
  let inCodeBlock = false;
  let codeLines: string[] = [];
  let codeLang = '';
  
  let listItems: string[] = [];
  
  const flushList = () => {
    if (listItems.length > 0) {
      blocks.push({ type: 'list', items: listItems, content: '' });
      listItems = [];
    }
  };
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Check code block
    if (line.trim().startsWith('```')) {
      if (inCodeBlock) {
        // End of code block
        blocks.push({
          type: 'code',
          language: codeLang,
          content: codeLines.join('\n')
        });
        codeLines = [];
        codeLang = '';
        inCodeBlock = false;
      } else {
        // Start of code block
        flushList();
        inCodeBlock = true;
        codeLang = line.trim().slice(3).trim();
      }
      continue;
    }
    
    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }
    
    // Check list item
    const listMatch = line.match(/^([-*]|\d+\.)\s+(.*)/);
    if (listMatch) {
      listItems.push(line);
      continue;
    } else {
      flushList();
    }
    
    // Regular paragraph
    if (line.trim() === '') {
      if (blocks.length > 0 && blocks[blocks.length - 1].type === 'paragraph' && blocks[blocks.length - 1].content === '') {
        // skip duplicate empty
      } else {
        blocks.push({ type: 'paragraph', content: '' });
      }
    } else {
      if (blocks.length > 0 && blocks[blocks.length - 1].type === 'paragraph' && blocks[blocks.length - 1].content !== '') {
        blocks[blocks.length - 1].content += '\n' + line;
      } else {
        blocks.push({ type: 'paragraph', content: line });
      }
    }
  }
  
  flushList();
  if (inCodeBlock && codeLines.length > 0) {
    blocks.push({
      type: 'code',
      language: codeLang,
      content: codeLines.join('\n')
    });
  }
  
  return blocks;
}

function RenderInlineText({ text }: { text: string }) {
  const parts = text.split(/(\*\*.*?\*\*|`.*?`)/g);
  return (
    <>
      {parts.map((part, j) => {
        if (part.startsWith('**') && part.endsWith('**') && part.length >= 4) {
          return <strong key={j} className="font-semibold text-foreground">{part.slice(2, -2)}</strong>;
        }
        if (part.startsWith('`') && part.endsWith('`') && part.length >= 2) {
          return <code key={j} className="bg-muted px-1.5 py-0.5 rounded font-mono text-[0.9em] border border-muted-foreground/10">{part.slice(1, -1)}</code>;
        }
        return <span key={j}>{part}</span>;
      })}
    </>
  );
}

function RenderListBlock({ items }: { items: string[] }) {
  return (
    <ul className="list-disc pl-5 my-2 space-y-1">
      {items.map((item, index) => {
        const content = item.replace(/^([-*]|\d+\.)\s+/, '');
        return (
          <li key={index} className="text-sm leading-relaxed text-foreground/90">
            <RenderInlineText text={content} />
          </li>
        );
      })}
    </ul>
  );
}

function RenderCodeBlock({ language, content }: { language?: string; content: string }) {
  const handleCopy = () => {
    navigator.clipboard.writeText(content);
    toast.success("已复制到剪贴板");
  };

  return (
    <div className="my-3 overflow-hidden rounded-lg border border-border bg-slate-950 text-slate-100 dark:bg-zinc-900/50 shadow-md">
      <div className="flex items-center justify-between bg-slate-900 px-4 py-1.5 text-xs font-mono text-slate-400 border-b border-slate-800">
        <span>{language || 'code'}</span>
        <button 
          onClick={handleCopy} 
          className="flex items-center gap-1 hover:text-slate-100 transition-colors py-0.5 px-1.5 rounded hover:bg-slate-800"
        >
          <Copy className="h-3 w-3" />
          <span>Copy</span>
        </button>
      </div>
      <pre className="p-4 overflow-x-auto font-mono text-xs leading-relaxed max-h-[400px] custom-scrollbar">
        <code>{content}</code>
      </pre>
    </div>
  );
}

function RenderMarkdownLite({ text }: { text: string }) {
  const blocks = parseMarkdown(text);
  
  return (
    <div className="flex flex-col gap-2">
      {blocks.map((block, i) => {
        if (block.type === 'code') {
          return <RenderCodeBlock key={i} language={block.language} content={block.content} />;
        }
        if (block.type === 'list' && block.items) {
          return <RenderListBlock key={i} items={block.items} />;
        }
        if (block.type === 'paragraph') {
          if (block.content === '') {
            return <div key={i} className="h-2" />;
          }
          return (
            <p key={i} className="text-sm leading-relaxed text-foreground/90 whitespace-pre-wrap break-words">
              <RenderInlineText text={block.content} />
            </p>
          );
        }
        return null;
      })}
    </div>
  );
}

export function renderContentBlocks(inputText: string | null, usernameStr?: string) {
  const messages = normalizeInputMessages(inputText);
  if (messages.length === 0) return null;

  return (
    <div className="flex flex-col gap-4">
      {messages.map((msg, i) => {
        const isUser = msg.role === "user";
        const isAssistant = msg.role === "assistant";
        const isSystem = msg.role === "system";
        const isTool = msg.role === "tool" || !!msg.tool_call_id;
        
        let roleName = msg.role || "input";
        if (isUser && usernameStr) {
          roleName = usernameStr;
        }

        return (
          <div key={i} className={cn("flex max-w-[85%] min-w-0 flex-col gap-1.5", isUser ? "self-end items-end" : "self-start items-start")}>
            <div className="flex items-center gap-1.5 px-1 text-[11px] font-semibold text-muted-foreground/80">
              {isUser ? (
                <>
                  <User className="h-3 w-3 text-blue-500" />
                  <span>{roleName}</span>
                </>
              ) : isAssistant ? (
                <>
                  <Sparkles className="h-3 w-3 text-violet-500 animate-pulse" />
                  <span>{roleName.toUpperCase()}</span>
                </>
              ) : isSystem ? (
                <>
                  <Terminal className="h-3 w-3 text-amber-500" />
                  <span>SYSTEM</span>
                </>
              ) : isTool ? (
                <>
                  <Wrench className="h-3 w-3 text-emerald-500" />
                  <span>TOOL{msg.name ? ` · ${msg.name}` : ""}</span>
                </>
              ) : (
                <>
                  <Terminal className="h-3 w-3 text-muted-foreground" />
                  <span>{roleName.toUpperCase()}</span>
                </>
              )}
            </div>
            <div
              className={cn(
                "rounded-2xl px-4 py-2.5 text-sm leading-relaxed shadow-sm font-sans border max-w-full",
                isUser
                  ? "rounded-tr-sm bg-blue-600 text-white border-blue-700/10 dark:bg-blue-600 dark:text-white dark:border-blue-500/20"
                  : isSystem
                    ? "rounded-tl-sm bg-amber-500/5 border-amber-500/20 text-amber-950 dark:bg-amber-950/20 dark:text-amber-100"
                    : isTool
                      ? "rounded-tl-sm bg-emerald-500/5 border-emerald-500/20 text-emerald-950 dark:bg-emerald-950/20 dark:text-emerald-100"
                      : isAssistant
                        ? "rounded-tl-sm bg-card text-foreground border-border"
                        : "rounded-tl-sm bg-muted text-foreground border-transparent"
              )}
            >
              {renderMessageContent(msg.content)}
            </div>
            {msg.tool_calls && (
              <div className="mt-1.5 w-full rounded-lg border border-border bg-slate-950 text-slate-100 dark:bg-zinc-900/50 shadow-md">
                <div className="flex items-center justify-between bg-slate-900 px-4 py-1.5 text-xs font-mono text-slate-400 border-b border-slate-800">
                  <div className="flex items-center gap-1.5 font-sans font-medium">
                    <Wrench className="h-3 w-3 text-emerald-400" />
                    <span>Tool Calls</span>
                  </div>
                  <button 
                    onClick={() => {
                      navigator.clipboard.writeText(JSON.stringify(msg.tool_calls, null, 2));
                      toast.success("已复制工具调用 JSON");
                    }} 
                    className="flex items-center gap-1 hover:text-slate-100 transition-colors py-0.5 px-1.5 rounded hover:bg-slate-800"
                  >
                    <Copy className="h-3 w-3" />
                    <span>Copy</span>
                  </button>
                </div>
                <pre className="p-4 overflow-x-auto font-mono text-xs leading-relaxed max-h-[260px] custom-scrollbar text-slate-300">
                  {JSON.stringify(cleanRawJsonForDisplay(msg.tool_calls), null, 2)}
                </pre>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function extractPromptSummary(inputText: string | null) {
  if (!inputText) return "No prompt";
  const messages = normalizeInputMessages(inputText);
  const lastUser = [...messages].reverse().find(m => m.role === "user") || messages[messages.length - 1];
  const text = getContentText(lastUser?.content);
  if (text) return text.substring(0, 50);
  if (Array.isArray(lastUser?.content)) return "[Multimodal Input]";
  return inputText.substring(0, 50);
}

export function formatRelativeTime(dateString: string, t: any) {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSecs < 10) return t("chatLogs.timeJustNow", "just now");
  if (diffSecs < 60) return t("chatLogs.timeSecondsAgo", { count: diffSecs, defaultValue: "{{count}}s ago" });
  if (diffMins < 60) return t("chatLogs.timeMinutesAgo", { count: diffMins, defaultValue: "{{count}}m ago" });
  if (diffHours < 24) return t("chatLogs.timeHoursAgo", { count: diffHours, defaultValue: "{{count}}h ago" });
  return t("chatLogs.timeDaysAgo", { count: diffDays, defaultValue: "{{count}}d ago" });
}

export function cleanRawJsonForDisplay(obj: any): any {
  if (Array.isArray(obj)) {
    return obj.map(cleanRawJsonForDisplay);
  } else if (obj !== null && typeof obj === 'object') {
    const cleaned: any = {};
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === 'string' && value.length > 200 && (value.startsWith('iVBORw0K') || value.startsWith('/9j/') || value.startsWith('UklGR') || value.startsWith('JVBERi'))) {
        cleaned[key] = `[Base64 Data Truncated, ${value.length} chars]`;
      } else if (key === 'data' && typeof value === 'string' && value.length > 100) {
        cleaned[key] = `[Base64 Data Truncated, ${value.length} chars]`;
      } else if (key === 'url' && typeof value === 'string' && value.startsWith('data:image')) {
        cleaned[key] = `[Data URI Truncated, ${value.length} chars]`;
      } else {
        cleaned[key] = cleanRawJsonForDisplay(value);
      }
    }
    return cleaned;
  }
  return obj;
}

export function renderAssistantContent(turn: any, t: any) {
  const parsed = parseAssistantResponse(turn?.outputText || "");

  return (
    <div className="flex max-w-[85%] min-w-0 flex-col gap-2 self-start">
      <div className="flex items-center gap-1.5 px-1 text-[11px] font-semibold text-muted-foreground/80">
        <Sparkles className="h-3 w-3 text-violet-500 animate-pulse" />
        <span>{t("chatLogs.assistantOutput", "Assistant Output")}</span>
        {turn?.model && (
          <span className="ml-1 bg-violet-100 dark:bg-violet-950/40 text-violet-700 dark:text-violet-300 px-1.5 py-0.5 rounded text-[10px] font-medium tracking-wide">
            {turn.model}
          </span>
        )}
      </div>

      {parsed.reasoning && (
        <details className="w-full overflow-hidden rounded-xl border border-violet-500/20 bg-violet-500/5 dark:bg-violet-950/20 shadow-sm group">
          <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-2.5 text-xs font-semibold text-violet-700 dark:text-violet-300 outline-none hover:bg-violet-500/10 dark:hover:bg-violet-950/40 select-none">
            <div className="flex items-center gap-2">
              <Brain className="h-3.5 w-3.5 text-violet-500 animate-pulse" />
              <span>{t("chatLogs.thoughtProcess", "Thought Process")}</span>
            </div>
            <span className="text-[10px] text-violet-400 group-open:rotate-180 transition-transform duration-200">▼</span>
          </summary>
          <div className="max-h-[300px] overflow-y-auto border-t border-violet-500/10 px-4 py-3 font-mono text-xs leading-relaxed text-muted-foreground custom-scrollbar bg-card/40 whitespace-pre-wrap">
            {parsed.reasoning}
          </div>
        </details>
      )}

      {(parsed.routingTrace.length > 0 || parsed.routingTraceText) && (
        <details className="w-full overflow-hidden rounded-xl border border-indigo-500/20 bg-indigo-500/5 dark:bg-indigo-950/20 shadow-sm group" open>
          <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-2.5 text-xs font-semibold text-indigo-700 dark:text-indigo-300 outline-none hover:bg-indigo-500/10 dark:hover:bg-indigo-950/40 select-none">
            <div className="flex items-center gap-2">
              <GitBranch className="h-3.5 w-3.5 text-indigo-500" />
              <span>{t("chatLogs.routingTrace", "LLM Handoff")}</span>
            </div>
            <span className="text-[10px] text-indigo-400 group-open:rotate-180 transition-transform duration-200">▼</span>
          </summary>
          <div className="border-t border-indigo-500/10 px-4 py-3 text-xs text-muted-foreground bg-card/40 space-y-2">
            {parsed.routingTrace.length > 0 ? (
              parsed.routingTrace.map((entry: any, index: number) => (
                <div key={`${entry.createdAt || index}-${entry.hop || index}`} className="rounded-md border border-indigo-500/10 bg-background/70 p-2">
                  <div className="font-medium text-foreground">
                    {entry.fromProviderName || entry.fromProviderId} / {entry.fromModelId}
                    <span className="mx-1 text-indigo-500">→</span>
                    {entry.toProviderName || entry.toProviderId} / {entry.toModelId}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                    <span>{t("chatLogs.routingHop", "Hop")}: {entry.hop || index + 1}</span>
                    <span>{t("chatLogs.latency", "Latency")}: {entry.latencyMs || 0}ms</span>
                    <span>{t("chatLogs.tokens", "Tokens")}: {(entry.inputTokens || 0) + (entry.outputTokens || 0)}</span>
                  </div>
                  {entry.reason && (
                    <div className="mt-1 whitespace-pre-wrap">
                      {t("chatLogs.reason", "Reason")}: {entry.reason}
                    </div>
                  )}
                </div>
              ))
            ) : (
              <pre className="whitespace-pre-wrap font-mono text-xs">{parsed.routingTraceText}</pre>
            )}
          </div>
        </details>
      )}

      {parsed.toolText && (
        <div className="w-full overflow-hidden rounded-xl border border-border bg-slate-950 text-slate-100 dark:bg-zinc-900/50 shadow-md">
          <div className="flex items-center justify-between bg-slate-900 px-4 py-1.5 text-xs font-mono text-slate-400 border-b border-slate-800">
            <div className="flex items-center gap-1.5 font-sans font-medium">
              <Wrench className="h-3 w-3 text-emerald-400" />
              <span>Tool Call / Response</span>
            </div>
            <button 
              onClick={() => {
                navigator.clipboard.writeText(parsed.toolText);
                toast.success("已复制工具调用 JSON");
              }} 
              className="flex items-center gap-1 hover:text-slate-100 transition-colors py-0.5 px-1.5 rounded hover:bg-slate-800"
            >
              <Copy className="h-3 w-3" />
              <span>Copy</span>
            </button>
          </div>
          <pre className="p-4 overflow-x-auto font-mono text-xs leading-relaxed max-h-[300px] custom-scrollbar text-slate-300 whitespace-pre-wrap">
            {parsed.toolText}
          </pre>
        </div>
      )}

      {parsed.text ? (
        <div className="rounded-2xl rounded-tl-sm border border-border bg-card px-5 py-4 text-sm leading-relaxed text-foreground shadow-sm break-words max-w-full">
          <RenderMarkdownLite text={parsed.text} />
        </div>
      ) : parsed.isRawJson && parsed.parsedJson && !parsed.toolText ? (
        <div className="w-full overflow-hidden rounded-xl border border-border bg-slate-950 text-slate-100 dark:bg-zinc-900/50 shadow-md">
          <div className="flex items-center justify-between bg-slate-900 px-4 py-1.5 text-xs font-mono text-slate-400 border-b border-slate-800">
            <span>Response JSON</span>
            <button 
              onClick={() => {
                navigator.clipboard.writeText(JSON.stringify(parsed.parsedJson, null, 2));
                toast.success("已复制 JSON 响应");
              }} 
              className="flex items-center gap-1 hover:text-slate-100 transition-colors py-0.5 px-1.5 rounded hover:bg-slate-800"
            >
              <Copy className="h-3 w-3" />
              <span>Copy</span>
            </button>
          </div>
          <pre className="p-4 overflow-x-auto font-mono text-xs leading-relaxed max-h-[400px] custom-scrollbar text-slate-300 whitespace-pre-wrap">
            {JSON.stringify(cleanRawJsonForDisplay(parsed.parsedJson), null, 2)}
          </pre>
        </div>
      ) : null}

      {turn?.status === "failed" && (
        <div className="rounded-2xl rounded-tl-sm border border-red-200 bg-red-500/5 px-4 py-3 text-sm text-red-600 dark:border-red-900/50 dark:bg-red-950/20 dark:text-red-400 whitespace-pre-wrap flex items-start gap-2">
          <XCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <div>{turn.error || t("chatLogs.unknownError", "Unknown execution error")}</div>
        </div>
      )}
    </div>
  );
}

export function renderConversationTurn(turn: any, index: number, t: any, availableUsers: any[], formatDateTime: any, isAdmin?: boolean, onCache?: (turn: any) => void) {
  const userObj = availableUsers?.find((u: any) => u.id === turn.userId);
  const usernameStr = userObj ? (userObj.username !== userObj.id ? userObj.username : turn.userId) : turn.userId;

  return (
    <section key={turn.id || index} className="relative flex flex-col gap-4 border-b pb-6 last:border-b-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-2.5 text-[11px] text-muted-foreground font-mono">
        <span className="rounded bg-muted px-2 py-0.5 font-semibold text-foreground">#{index + 1}</span>
        <span className="opacity-80">{turn.requestId ? `REQ ${String(turn.requestId).slice(0, 8)}` : turn.id ? `REQ ${String(turn.id).slice(0, 8)}` : ""}</span>
        <span className="opacity-85">{formatDateTime(turn.createdAt)}</span>
        <span className="bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 rounded text-foreground/80">{turn.latencyMs || 0}ms</span>
        <span className="bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 rounded text-foreground/80">{turn.inputTokens || 0}+{turn.outputTokens || 0} tok</span>
        {turn.status === "cached" && (
          <span className="inline-flex items-center rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
            {t("responseCache.cacheHit", "缓存命中")}
          </span>
        )}
        {isAdmin && onCache && turn.outputText && (
          <button
            onClick={(e) => { e.stopPropagation(); onCache(turn); }}
            title={t("responseCache.cacheThis", "缓存此回复")}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <Archive className="h-3 w-3" />
          </button>
        )}
      </div>
      <div className="flex flex-col gap-4 bg-slate-500/5 dark:bg-slate-400/5 p-4 rounded-2xl border border-dashed border-border/60">
        {renderContentBlocks(turn.inputText, usernameStr)}
        <div className="my-1 border-t border-dashed border-border/40"></div>
        {renderAssistantContent(turn, t)}
      </div>
    </section>
  );
}
