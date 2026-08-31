import { db } from "../../db";
import { promptPolicies, promptInjectionRecords } from "../../db/schema";
import { eq, and } from "drizzle-orm";
import crypto from "crypto";

/**
 * Result of transforming the raw request body for upstream dispatch.
 */
export interface TransformResult {
  modifiedBody: any;
  isStreaming: boolean;
}

export interface TransformRequestBodyOptions {
  /**
   * OPC agent mode: when the model has no maxOutputTokens ceiling, strip the
   * client's max_tokens / max_completion_tokens on OpenAI-compatible upstreams
   * so the provider default applies (e.g. xAI defaults to 128k). Never strip
   * for Anthropic upstreams — max_tokens is required there.
   */
  stripClientMaxTokensWhenUnset?: boolean;
}

/**
 * Deep-clone the incoming request body and apply model, token-limit,
 * and streaming normalizations.
 *
 * Extracted from gateway.ts lines 855-901.
 */
export function transformRequestBody(
  body: any,
  modelId: string,
  isAnthropicUpstream: boolean,
  maxOutputTokens: number | null,
  logAction: Function,
  baseActionLog: any,
  providerName: string,
  options?: TransformRequestBodyOptions,
): TransformResult {
  // Payload transformations
  let modifiedBody = JSON.parse(JSON.stringify(body));

  // Normalize array body (e.g. Claude Code content blocks) into standard Anthropic messages
  // object. Array bodies lose non-index properties (.tools, .system) on JSON.stringify.
  if (Array.isArray(modifiedBody)) {
    modifiedBody = {
      model: modelId,
      messages: [{ role: "user", content: modifiedBody }],
    };
  }

  modifiedBody.model = modelId;

  // Global max_tokens normalization & Truncation
  if (modifiedBody.max_tokens_to_sample) {
    if (modifiedBody.max_tokens === undefined) {
      modifiedBody.max_tokens = modifiedBody.max_tokens_to_sample;
    }
    delete modifiedBody.max_tokens_to_sample;
  }

  const hasConfiguredCeiling = !!(maxOutputTokens && maxOutputTokens > 0);

  // Only intervene when the model config sets maxOutputTokens AND the client
  // submitted a higher value. Never inject a gateway ceiling when the client
  // omitted max_tokens / max_completion_tokens — that is the provider's job.
  if (hasConfiguredCeiling) {
    let clipped = false;
    let originalTokens = 0;
    let finalTokens = 0;

    if (typeof modifiedBody.max_tokens === "number" && modifiedBody.max_tokens > maxOutputTokens!) {
       originalTokens = modifiedBody.max_tokens;
       modifiedBody.max_tokens = maxOutputTokens;
       finalTokens = modifiedBody.max_tokens;
       clipped = true;
    }
    if (typeof modifiedBody.max_completion_tokens === "number" && modifiedBody.max_completion_tokens > maxOutputTokens!) {
       originalTokens = modifiedBody.max_completion_tokens;
       modifiedBody.max_completion_tokens = maxOutputTokens;
       finalTokens = modifiedBody.max_completion_tokens;
       clipped = true;
    }

    if (clipped) {
      logAction({
        ...baseActionLog,
        level: "WARN",
        code: "token.max_output.clamped",
        providerName,
        modelId,
        originalValue: originalTokens,
        clampedValue: finalTokens
      });
    }
  } else if (
    options?.stripClientMaxTokensWhenUnset &&
    !isAnthropicUpstream
  ) {
    // OPC + unset model ceiling: do not forward a client's restrictive cap
    // (rakazo OPC defaults to 4096). Provider defaults apply instead.
    // Anthropic is excluded — max_tokens is required and a later outbound
    // normalizer would otherwise invent max_tokens=1.
    const strippedMaxTokens =
      typeof modifiedBody.max_tokens === "number" ? modifiedBody.max_tokens : undefined;
    const strippedMaxCompletion =
      typeof modifiedBody.max_completion_tokens === "number"
        ? modifiedBody.max_completion_tokens
        : undefined;
    if (strippedMaxTokens !== undefined || strippedMaxCompletion !== undefined) {
      delete modifiedBody.max_tokens;
      delete modifiedBody.max_completion_tokens;
      logAction({
        ...baseActionLog,
        level: "INFO",
        code: "token.max_output.stripped",
        providerName,
        modelId,
        originalMaxTokens: strippedMaxTokens,
        originalMaxCompletionTokens: strippedMaxCompletion,
      });
    }
  }

  let isStreaming = modifiedBody.stream === true;
  if (isStreaming && !isAnthropicUpstream) {
    modifiedBody.stream_options = { include_usage: true };
  }

  return { modifiedBody, isStreaming };
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt Policy Injection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Context needed to look up and deduplicate prompt injection records.
 */
export interface PromptPolicyContext {
  userId: string;
  apiKeyId: string;
  endpointId: string;
  subdomainId: string | null;
  /** HTTP request headers (lowercase keys). */
  headers: Record<string, string | string[] | undefined>;
}

/**
 * Early-return sentinel: the caller should respond with this error and
 * stop processing.  `null` means no error.
 */
export interface PromptPolicyError {
  status: number;
  data: any;
  isStream: false;
}

export interface PromptPolicyPlan {
  policy: any | null;
  shouldInject: boolean;
  contentHash?: string;
  conversationId?: string;
  error?: PromptPolicyError;
}

/**
 * Determine if and what prompt policy should be injected, without mutating body or db.
 */
export async function resolvePromptPolicyPlan(
  modifiedBody: any,
  promptPolicyId: string | null,
  reqPath: string,
  policyCtx: PromptPolicyContext,
  formatError: (protocol: string, status: number, message: string) => any,
  incomingProtocol: string,
): Promise<PromptPolicyPlan> {
  let policy: any = null;
  if (promptPolicyId) {
    const policyList = await db
      .select()
      .from(promptPolicies)
      .where(
        and(
          eq(promptPolicies.id, promptPolicyId),
          eq(promptPolicies.enabled, true),
        ),
      );
    if (policyList.length > 0) policy = policyList[0];
  } else {
    // v0 built-in fallback
    if (reqPath.startsWith("/v0/messages")) {
      const builtinList = await db
        .select()
        .from(promptPolicies)
        .where(eq(promptPolicies.id, "builtin-claude-code"));
      if (builtinList.length > 0) policy = builtinList[0];
    } else if (reqPath.startsWith("/v0/chat/completions")) {
      const builtinList = await db
        .select()
        .from(promptPolicies)
        .where(eq(promptPolicies.id, "builtin-codex-cli"));
      if (builtinList.length > 0) policy = builtinList[0];
    }
  }

  if (!policy) {
    return { policy: null, shouldInject: false };
  }

  let shouldInject = true;
  let conversationId = "unknown";
  let contentHash: string | undefined;

  if (policy.injectMode === "once_per_conversation") {
    if (policy.conversationKeySource === "header") {
      conversationId =
        (policyCtx.headers[
          policy.conversationKeyName.toLowerCase()
        ] as string) || "";
    } else if (policy.conversationKeySource === "body") {
      conversationId = modifiedBody[policy.conversationKeyName] || "";
    }

    if (!conversationId) {
      if (policy.fallbackMode === "error") {
        return {
          policy,
          shouldInject: false,
          error: {
            status: 400,
            data: formatError(incomingProtocol, 400, "Missing conversation ID for prompt injection"),
            isStream: false,
          },
        };
      } else if (policy.fallbackMode === "skip_injection") {
        shouldInject = false;
      }
    } else {
      contentHash = crypto
        .createHash("sha256")
        .update(policy.content)
        .digest("hex");
      const injectRecList = await db
        .select()
        .from(promptInjectionRecords)
        .where(
          and(
            eq(promptInjectionRecords.userId, policyCtx.userId),
            eq(promptInjectionRecords.apiKeyId, policyCtx.apiKeyId),
            eq(promptInjectionRecords.endpointId, policyCtx.endpointId),
            eq(
              promptInjectionRecords.subdomainId,
              policyCtx.subdomainId || "null",
            ),
            eq(promptInjectionRecords.promptPolicyId, policy.id),
            eq(promptInjectionRecords.conversationId, conversationId),
            eq(promptInjectionRecords.contentHash, contentHash),
          ),
        );

      if (injectRecList.length > 0) {
        shouldInject = false;
      }
    }
  }

  return { policy, shouldInject, contentHash, conversationId };
}

/**
 * Load the prompt policy from the database, enforce once_per_conversation
 * deduplication, and inject the policy content into `modifiedBody` in-place.
 *
 * Returns a PromptPolicyError when the caller must short-circuit the
 * request (e.g. missing conversation ID with fallbackMode === "error").
 *
 * Extracted from gateway.ts lines 903-1061.
 */
export async function applyPromptPolicy(
  modifiedBody: any,
  promptPolicyId: string | null,
  reqPath: string,
  isAnthropicUpstream: boolean,
  policyCtx: PromptPolicyContext,
  formatError: (protocol: string, status: number, message: string) => any,
  incomingProtocol: string,
): Promise<PromptPolicyError | null> {
  const plan = await resolvePromptPolicyPlan(
    modifiedBody,
    promptPolicyId,
    reqPath,
    policyCtx,
    formatError,
    incomingProtocol
  );

  if (plan.error) {
    return plan.error;
  }

  const { policy, shouldInject, contentHash, conversationId } = plan;

  if (shouldInject && policy) {
    if (policy.injectMode === "once_per_conversation" && contentHash && conversationId) {
      await db.insert(promptInjectionRecords).values({
        id: crypto.randomUUID(),
        userId: policyCtx.userId,
        apiKeyId: policyCtx.apiKeyId,
        endpointId: policyCtx.endpointId,
        subdomainId: policyCtx.subdomainId || "null",
        promptPolicyId: policy.id,
        conversationId,
        contentHash,
        createdAt: new Date(),
      });
    }

    if (shouldInject) {
      if (isAnthropicUpstream) {
        if (
          policy.injectPosition === "system" ||
          policy.injectPosition === "replace_system"
        ) {
          modifiedBody.system = policy.content;
        } else if (policy.injectPosition === "append_system") {
          if (modifiedBody.system) {
            if (Array.isArray(modifiedBody.system)) {
              modifiedBody.system.push({
                type: "text",
                text: policy.content,
              });
            } else {
              modifiedBody.system += "\n\n" + policy.content;
            }
          } else {
            modifiedBody.system = policy.content;
          }
        }
      } else {
        if (modifiedBody.messages && Array.isArray(modifiedBody.messages)) {
          if (
            policy.injectPosition === "messages_unshift" ||
            policy.injectPosition === "system"
          ) {
            let injectContent = policy.content;
            try {
              const parsedContent = JSON.parse(policy.content);
              if (parsedContent.messages)
                injectContent = parsedContent.messages;
            } catch (e) {}

            if (Array.isArray(injectContent)) {
              modifiedBody.messages.unshift(...injectContent);
            } else {
              modifiedBody.messages.unshift({
                role: "system",
                content: policy.content,
              });
            }
          } else if (policy.injectPosition === "append_system") {
            const sysMsg = modifiedBody.messages.find(
              (m: any) => m.role === "system",
            );
            if (sysMsg) {
              sysMsg.content += "\n\n" + policy.content;
            } else {
              modifiedBody.messages.unshift({
                role: "system",
                content: policy.content,
              });
            }
          } else if (policy.injectPosition === "replace_system") {
            modifiedBody.messages = modifiedBody.messages.filter(
              (m: any) => m.role !== "system",
            );
            modifiedBody.messages.unshift({
              role: "system",
              content: policy.content,
            });
          }
        }
      }
    }
  }

  return null;
}
