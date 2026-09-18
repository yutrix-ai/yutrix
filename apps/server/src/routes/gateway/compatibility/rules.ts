import { sanitizeGeminiSchema } from "./geminiSchema";
import type { CompatibilityLog, CompatibilityProfile, CompatibilityRule } from "./spec";

const GOOGLE_MAX_OUTPUT_TOKENS = Number.parseInt(
  process.env.GOOGLE_OPENAI_MAX_OUTPUT_TOKENS || "8192",
  10,
);

function safeJson(value: any): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function sanitizeOneTool(tool: any): { tool: any; changed: boolean } {
  if (tool?.type !== "function" || !tool.function || typeof tool.function !== "object") {
    return { tool, changed: false };
  }

  const nextFunction: Record<string, any> = {
    name: tool.function.name,
  };
  if (tool.function.description !== undefined) {
    nextFunction.description = tool.function.description;
  }
  if (tool.function.parameters !== undefined) {
    nextFunction.parameters = sanitizeGeminiSchema(tool.function.parameters);
  }

  const nextTool = { type: "function", function: nextFunction };
  return { tool: nextTool, changed: safeJson(tool) !== safeJson(nextTool) };
}

function sanitizeGoogleTools(body: any): CompatibilityLog | null {
  if (!Array.isArray(body?.tools)) return null;
  let changed = false;

  body.tools = body.tools.map((tool: any) => {
    try {
      const result = sanitizeOneTool(tool);
      changed = changed || result.changed;
      return result.tool;
    } catch {
      return tool;
    }
  });

  if (!changed) return null;
  return {
    code: "tools_schema_sanitized",
    message: "Sanitized tool schemas for Gemini function_declarations",
    toolCount: body.tools.length,
  };
}

function clampGoogleMaxTokens(body: any): CompatibilityLog | null {
  if (!Number.isFinite(GOOGLE_MAX_OUTPUT_TOKENS) || GOOGLE_MAX_OUTPUT_TOKENS <= 0) {
    return null;
  }

  const originalMaxTokens = body?.max_tokens;
  const originalMaxCompletionTokens = body?.max_completion_tokens;
  let changed = false;

  if (typeof body?.max_tokens === "number" && body.max_tokens > GOOGLE_MAX_OUTPUT_TOKENS) {
    body.max_tokens = GOOGLE_MAX_OUTPUT_TOKENS;
    changed = true;
  }
  if (
    typeof body?.max_completion_tokens === "number" &&
    body.max_completion_tokens > GOOGLE_MAX_OUTPUT_TOKENS
  ) {
    body.max_completion_tokens = GOOGLE_MAX_OUTPUT_TOKENS;
    changed = true;
  }

  if (!changed) return null;
  return {
    code: "max_tokens_clamped",
    message: `Google OpenAI-compatible max output tokens clamped to ${GOOGLE_MAX_OUTPUT_TOKENS}`,
    originalMaxTokens,
    originalMaxCompletionTokens,
    clampedMaxTokens: body.max_tokens,
    clampedMaxCompletionTokens: body.max_completion_tokens,
  };
}

function removeGoogleStreamOptions(body: any): CompatibilityLog | null {
  if (!body || body.stream_options === undefined) return null;
  const originalStreamOptions = body.stream_options;
  delete body.stream_options;
  return {
    code: "stream_options_removed",
    message: "Removed stream_options for Google OpenAI-compatible upstream",
    originalStreamOptions,
  };
}

const FIRST_PARTY: ReadonlySet<CompatibilityProfile> = new Set(["first_party_google_openai"]);
const GEMINI_SCHEMA: ReadonlySet<CompatibilityProfile> = new Set([
  "first_party_google_openai",
  "gemini_schema_proxy",
]);

/**
 * Closed apply() loop, open rule list. Add Gemini/Google transforms here.
 */
export const COMPATIBILITY_RULES: CompatibilityRule[] = [
  {
    id: "stream_options_removed",
    appliesTo: (profile) => FIRST_PARTY.has(profile),
    apply: (body) => removeGoogleStreamOptions(body),
  },
  {
    id: "max_tokens_clamped",
    appliesTo: (profile) => FIRST_PARTY.has(profile),
    apply: (body) => clampGoogleMaxTokens(body),
  },
  {
    id: "tools_schema_sanitized",
    appliesTo: (profile) => GEMINI_SCHEMA.has(profile),
    apply: (body) => sanitizeGoogleTools(body),
  },
];
