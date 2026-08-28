/**
 * Upstream parameter-constraint recovery.
 *
 * When a provider returns 400/422 with a message that names a concrete
 * request-parameter conflict (e.g. strict tool_choice under thinking mode),
 * plan a reversible body rewrite and retry the same provider/model once.
 *
 * Strategies are driven by **error text + body shape**, never by model name
 * or provider brand hardcodes.
 */

export type ConstraintMutator = (body: any) => void;

export interface ConstraintRewritePlan {
  /** Stable id used for de-dupe per target (provider:model). */
  code: string;
  /** Human-readable summary for action logs. */
  summary: string;
  mutate: ConstraintMutator;
}

export interface PlanConstraintRecoveryInput {
  statusCode?: number;
  errorMessage?: string;
  errorCode?: string;
  /** Body that was (or will be) sent upstream — OpenAI-compatible shape. */
  body: any;
  /** Codes already applied for this target; prevents rewrite loops. */
  alreadyApplied: ReadonlySet<string>;
}

function normalizeMessage(message: string | undefined): string {
  return String(message || "").toLowerCase();
}

export function isStrictToolChoice(toolChoice: any): boolean {
  if (toolChoice === "required") return true;
  if (!toolChoice || typeof toolChoice !== "object") return false;
  // OpenAI object form: { type: "function", function: { name } }
  if (toolChoice.type === "function") return true;
  if (toolChoice.function?.name) return true;
  // Anthropic-style leftovers should not appear on OpenAI wire, but be defensive
  if (toolChoice.type === "tool" || toolChoice.type === "any") return true;
  return false;
}

function mentionsToolChoice(msg: string): boolean {
  return /tool[_\s-]?choice/.test(msg);
}

function mentionsThinking(msg: string): boolean {
  return /\bthinking\b/.test(msg) || /enable_thinking/.test(msg);
}

/**
 * True only when the upstream is rejecting *strict* tool_choice values
 * (required / named-tool object), not when it demands tool_choice be set.
 *
 * Must NOT match phrasing like "tool_choice is required when tools are present".
 */
function forbidsStrictToolChoice(msg: string): boolean {
  if (!mentionsToolChoice(msg)) return false;

  // "does not support being set to required or object"
  // "tool_choice ... not supported ... required"
  if (
    /(?:does\s+not\s+support|not\s+support(?:ed)?|unsupported).{0,100}(?:\brequired\b|\bobject\b)/.test(msg) ||
    /(?:\brequired\b|\bobject\b).{0,100}(?:does\s+not\s+support|not\s+support(?:ed)?|unsupported)/.test(msg)
  ) {
    return true;
  }

  // "required or object in thinking mode" (DashScope / Qwen class errors)
  if (
    mentionsThinking(msg) &&
    /\brequired\b/.test(msg) &&
    /\bobject\b/.test(msg)
  ) {
    return true;
  }

  return false;
}

function relaxStrictToolChoice(body: any): void {
  if (!isStrictToolChoice(body?.tool_choice)) return;
  body.tool_choice = "auto";
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Thinking-off wire shapes. Append a mutator here when a new OpenAI-compat
 * stack documents another disable knob — do not branch on vendor/model.
 */
const THINKING_OFF_SHAPES: readonly ConstraintMutator[] = [
  (body) => {
    body.enable_thinking = false;
  },
  (body) => {
    if (isPlainObject(body.thinking)) {
      body.thinking = { ...body.thinking, type: "disabled" };
    } else {
      body.thinking = { type: "disabled" };
    }
  },
  (body) => {
    if (isPlainObject(body.reasoning)) {
      body.reasoning = { ...body.reasoning, effort: "none", exclude: true };
    }
  },
  (body) => {
    body.reasoning_effort = "none";
  },
];

function disableThinking(body: any): void {
  if (!isPlainObject(body)) return;
  for (const apply of THINKING_OFF_SHAPES) {
    apply(body);
  }
}

function thinkingOffShapesApplied(body: any): boolean {
  if (!isPlainObject(body)) return false;
  if (body.enable_thinking !== false) return false;
  return isPlainObject(body.thinking) && body.thinking.type === "disabled";
}

/**
 * Foreign CoT left on messages while thinking is disabled is an inconsistent
 * DeepSeek/Kimi state: 400 "reasoning_content must be passed back".
 * Cross-model funnel hops must strip, not echo another model's chain.
 */
function stripReasoningPassbackFields(body: any): void {
  if (!isPlainObject(body) || !Array.isArray(body.messages)) return;
  for (const message of body.messages) {
    if (!isPlainObject(message)) continue;
    delete message.reasoning_content;
    delete message.reasoning;
  }
}

function requiresReasoningContentPassback(msg: string): boolean {
  if (!/reasoning[_\s-]?content/.test(msg)) return false;
  return /pass(?:ed)?\s*back/.test(msg) || mentionsThinking(msg);
}

function rejectsThinkingMode(msg: string): boolean {
  return (
    mentionsThinking(msg) &&
    /enable_thinking|thinking mode|not support.*thinking|thinking.*not support/.test(msg)
  );
}

/**
 * Ordered recovery strategies. First match that has not been applied wins.
 * Callers should apply the mutator, record `code` in alreadyApplied, and retry.
 */
export function planConstraintRecovery(
  input: PlanConstraintRecoveryInput,
): ConstraintRewritePlan | null {
  const status = input.statusCode ?? 0;
  if (status !== 400 && status !== 422) return null;

  const body = input.body;
  if (!body || typeof body !== "object") return null;

  const msg = normalizeMessage(input.errorMessage);
  if (!msg) return null;

  const applied = input.alreadyApplied;

  // 1) Thinking mode + strict tool_choice conflict.
  // Prefer disabling thinking first so client intent of tool_choice=required
  // is preserved when the upstream honors enable_thinking=false.
  if (
    !applied.has("disable_thinking_for_strict_tool_choice") &&
    mentionsThinking(msg) &&
    forbidsStrictToolChoice(msg) &&
    isStrictToolChoice(body.tool_choice)
  ) {
    return {
      code: "disable_thinking_for_strict_tool_choice",
      summary: "thinking off (all shapes; strict tool_choice + thinking conflict)",
      mutate: disableThinking,
    };
  }

  // 2) Same class of error, or thinking disable ignored: relax tool_choice.
  if (
    !applied.has("relax_strict_tool_choice") &&
    forbidsStrictToolChoice(msg) &&
    isStrictToolChoice(body.tool_choice)
  ) {
    return {
      code: "relax_strict_tool_choice",
      summary: "tool_choice → auto (upstream rejects required/object)",
      mutate: relaxStrictToolChoice,
    };
  }

  // 3) Thinking-mode rejection or reasoning_content passback requirement.
  // Disable thinking and strip foreign CoT. Filling empty reasoning_content
  // while thinking is off is the inconsistent state DeepSeek rejects after
  // a funnel hop from a thinking model (GROK/Gemini) onto a default-on
  // thinking upstream (deepseek-v4-flash).
  const passbackRequired = requiresReasoningContentPassback(msg);
  if (
    !applied.has("disable_thinking") &&
    (passbackRequired || rejectsThinkingMode(msg))
  ) {
    const needsDisable = !thinkingOffShapesApplied(body);
    const needsStrip = passbackRequired && Array.isArray(body.messages);
    if (needsDisable || needsStrip) {
      return {
        code: "disable_thinking",
        summary: passbackRequired
          ? "thinking off (all shapes) + strip assistant reasoning_content"
          : "thinking off (all shapes; thinking rejected by upstream)",
        mutate: (nextBody) => {
          disableThinking(nextBody);
          if (passbackRequired) stripReasoningPassbackFields(nextBody);
        },
      };
    }
  }

  return null;
}

/** Apply previously planned mutators onto a freshly-built outbound body. */
export function applyConstraintMutators(body: any, mutators: readonly ConstraintMutator[] | undefined): void {
  if (!body || !mutators || mutators.length === 0) return;
  for (const mutate of mutators) {
    try {
      mutate(body);
    } catch {
      // best-effort; a single mutator failure must not break the request
    }
  }
}
