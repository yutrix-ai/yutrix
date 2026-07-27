import { formatError } from "../../utils/gatewayError";
import type { AttemptState, BaseActionLog, GatewayRequestContext } from "./types";
import { applyInputTokenLimit, InputTokenLimitError } from "./inputTokenLimit";

type EnforceInputTokenLimitArgs = {
  ctx: GatewayRequestContext;
  modifiedBody: any;
  provider: any;
  currentAttempt: AttemptState;
  activeModelConfig: any;
  baseActionLog: BaseActionLog;
  logAction: (event: any) => void;
};

type EnforceInputTokenLimitResult =
  | { ok: true; truncatedBody?: any }
  | { ok: false; responseData: any };

export async function enforceInputTokenLimit({
  ctx,
  modifiedBody,
  provider,
  currentAttempt,
  activeModelConfig,
  baseActionLog,
  logAction,
}: EnforceInputTokenLimitArgs): Promise<EnforceInputTokenLimitResult> {
  if (ctx.inputTokenLimit.maxInputTokens <= 0) {
    return { ok: true };
  }

  const { incomingProtocol } = ctx.routing;

  try {
    const truncation = await applyInputTokenLimit(modifiedBody, {
      maxInputTokens: ctx.inputTokenLimit.maxInputTokens,
      modelId: currentAttempt.modelId,
      providerProtocol: currentAttempt.providerProtocol,
      tokenizerRepo: activeModelConfig?.tokenizerRepo || null,
      proxyUrl: provider.weightProxyUrl || null,
    });
    ctx.stream.estimatedPromptTokens = truncation.finalTokens;

    if (truncation.truncated) {
      logAction({
        ...baseActionLog,
        level: "WARN",
        code: "token.max_input.truncated",
        providerName: provider.name,
        modelId: currentAttempt.modelId,
        limitSource: ctx.inputTokenLimit.source,
        limitSourceLabel: ctx.inputTokenLimit.sourceLabel,
        maxInputTokens: truncation.maxInputTokens,
        budgetTokens: truncation.budgetTokens,
        originalTokens: truncation.originalTokens,
        finalTokens: truncation.finalTokens,
        droppedTurns: truncation.droppedTurns,
        textTruncated: truncation.textTruncated,
      });
    }

    return { ok: true, truncatedBody: truncation.body };
  } catch (error: any) {
    logAction({
      ...baseActionLog,
      level: "WARN",
      code: "token.max_input.rejected",
      providerName: provider?.name || "",
      modelId: currentAttempt.modelId,
      limitSource: ctx.inputTokenLimit.source,
      limitSourceLabel: ctx.inputTokenLimit.sourceLabel,
      maxInputTokens: ctx.inputTokenLimit.maxInputTokens,
      message: (error?.message || String(error)) + " (Bypassing limit and continuing)",
    });

    if (error instanceof InputTokenLimitError) {
      return { ok: true };
    }

    const statusCode = 400;
    const errorCode = "input_token_limit_error";
    const responseData = {
      status: statusCode,
      data: formatError(incomingProtocol, statusCode, error?.message || "输入 token 限制处理失败", errorCode),
      isStream: false,
    };

    return { ok: false, responseData };
  }
}
