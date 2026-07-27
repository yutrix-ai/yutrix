type CompatibilityLog = {
  code: string;
  message: string;
  [key: string]: any;
};

type CompatibilityOptions = {
  providerName?: string;
  baseUrl?: string;
  providerProtocol?: string;
  modelId?: string;
  logAction?: Function;
  baseActionLog?: any;
};

const GOOGLE_MAX_OUTPUT_TOKENS = Number.parseInt(
  process.env.GOOGLE_OPENAI_MAX_OUTPUT_TOKENS || "8192",
  10,
);

const GEMINI_SCHEMA_KEYS = new Set([
  "type",
  "format",
  "description",
  "nullable",
  "enum",
  "maxItems",
  "minItems",
  "properties",
  "required",
  "propertyOrdering",
  "items",
]);

export function isGoogleOpenAICompatibleProvider(options: CompatibilityOptions): boolean {
  if (options.providerProtocol && options.providerProtocol !== "openai") return false;
  const providerName = String(options.providerName || "").toLowerCase();
  const baseUrl = String(options.baseUrl || "").toLowerCase();
  return (
    providerName.includes("google") ||
    providerName.includes("gemini") ||
    providerName.includes("ai studio") ||
    baseUrl.includes("generativelanguage.googleapis.com") ||
    baseUrl.includes("googleapis.com")
  );
}

function normalizeSchemaType(value: any, out: Record<string, any>): void {
  if (Array.isArray(value)) {
    const nonNull = value.find((item) => item !== "null");
    if (nonNull) out.type = nonNull;
    if (value.includes("null")) out.nullable = true;
    return;
  }
  if (value !== undefined) out.type = value;
}

export function sanitizeGeminiSchema(schema: any): any {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;

  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "type") {
      normalizeSchemaType(value, out);
      continue;
    }

    if (!GEMINI_SCHEMA_KEYS.has(key)) continue;

    if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
      const properties: Record<string, any> = {};
      for (const [propName, propSchema] of Object.entries(value)) {
        properties[propName] = sanitizeGeminiSchema(propSchema);
      }
      out.properties = properties;
      continue;
    }

    if (key === "items") {
      out.items = sanitizeGeminiSchema(value);
      continue;
    }

    out[key] = value;
  }

  if (!out.type && out.properties) out.type = "object";
  return out;
}

function sanitizeGoogleTools(body: any): boolean {
  if (!Array.isArray(body?.tools)) return false;
  let changed = false;

  body.tools = body.tools.map((tool: any) => {
    if (tool?.type !== "function" || !tool.function) return tool;

    const nextFunction: Record<string, any> = {
      name: tool.function.name,
    };
    if (tool.function.description !== undefined) {
      nextFunction.description = tool.function.description;
    }
    if (tool.function.parameters !== undefined) {
      const before = JSON.stringify(tool.function.parameters);
      nextFunction.parameters = sanitizeGeminiSchema(tool.function.parameters);
      changed = changed || before !== JSON.stringify(nextFunction.parameters);
    }

    const nextTool = { type: "function", function: nextFunction };
    changed = changed || JSON.stringify(tool) !== JSON.stringify(nextTool);
    return nextTool;
  });

  return changed;
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

export function applyProviderCompatibility(body: any, options: CompatibilityOptions): string | null {
  if (!body || typeof body !== "object") return null;
  if (!isGoogleOpenAICompatibleProvider(options)) return null;

  const logs: CompatibilityLog[] = [];

  const streamOptionsLog = removeGoogleStreamOptions(body);
  if (streamOptionsLog) logs.push(streamOptionsLog);

  const maxTokensLog = clampGoogleMaxTokens(body);
  if (maxTokensLog) logs.push(maxTokensLog);

  if (sanitizeGoogleTools(body)) {
    logs.push({
      code: "tools_schema_sanitized",
      message: "Sanitized tool schemas for Google OpenAI-compatible upstream",
      toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
    });
  }

  if (logs.length === 0) return null;
  const summary = logs.map(l => {
    if (l.code === "max_tokens_clamped") return `max_tokens(${l.originalMaxTokens || "?"}->${l.clampedMaxTokens})`;
    if (l.code === "tools_schema_sanitized") return `tools_schema(${l.toolCount})`;
    return l.code;
  }).join(", ");

  if (options.logAction) {
    options.logAction({
      ...(options.baseActionLog || {}),
      level: "WARN",
      code: "request.provider_compatibility",
      providerName: options.providerName,
      modelId: options.modelId,
      message: summary,
    });
  }

  return summary;
}
