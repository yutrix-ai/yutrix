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
  | {
      ok: true;
      truncatedBody?: any;
    }
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
  if (ctx.overflowHopApplied || ctx.emptyOutputLayerHopApplied) {
    return { ok: true };
  }

  if (ctx.inputTokenLimit.maxInputTokens <= 0) {
    return { ok: true };
  }

  const { incomingProtocol } = ctx.routing;
  const limitConfig = {
    maxInputTokens: ctx.inputTokenLimit.maxInputTokens,
    modelId: currentAttempt.modelId,
    providerProtocol: currentAttempt.providerProtocol,
    tokenizerRepo: activeModelConfig?.tokenizerRepo || null,
    proxyUrl: provider.weightProxyUrl || null,
  };

  try {
    const truncation = await applyInputTokenLimit(modifiedBody, limitConfig);
    ctx.stream.estimatedPromptTokens = truncation.finalTokens;

    if (!truncation.truncated) {
      return { ok: true };
    }

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

/** Last-resort clip after overflow hop is unavailable or the hopped window is still too small. */
export async function applyForcedInputTokenLimit(args: {
  ctx: GatewayRequestContext;
  modifiedBody: any;
  provider: any;
  currentAttempt: AttemptState;
  activeModelConfig: any;
  baseActionLog: BaseActionLog;
  logAction: (event: any) => void;
  maxInputTokens: number;
  limitSource?: string;
  limitSourceLabel?: string;
}): Promise<any> {
  try {
    const truncation = await applyInputTokenLimit(args.modifiedBody, {
      maxInputTokens: args.maxInputTokens,
      modelId: args.currentAttempt.modelId,
      providerProtocol: args.currentAttempt.providerProtocol,
      tokenizerRepo: args.activeModelConfig?.tokenizerRepo || null,
      proxyUrl: args.provider?.weightProxyUrl || null,
    });
    args.ctx.stream.estimatedPromptTokens = truncation.finalTokens;
    if (truncation.truncated) {
      args.logAction({
        ...args.baseActionLog,
        level: "WARN",
        code: "token.max_input.truncated",
        providerName: args.provider?.name,
        modelId: args.currentAttempt.modelId,
        limitSource: args.limitSource || args.ctx.inputTokenLimit.source,
        limitSourceLabel: args.limitSourceLabel || args.ctx.inputTokenLimit.sourceLabel,
        maxInputTokens: truncation.maxInputTokens,
        budgetTokens: truncation.budgetTokens,
        originalTokens: truncation.originalTokens,
        finalTokens: truncation.finalTokens,
        droppedTurns: truncation.droppedTurns,
        textTruncated: truncation.textTruncated,
      });
    }
    return truncation.body;
  } catch (error: any) {
    args.logAction({
      ...args.baseActionLog,
      level: "WARN",
      code: "token.max_input.rejected",
      providerName: args.provider?.name || "",
      modelId: args.currentAttempt.modelId,
      limitSource: args.limitSource || args.ctx.inputTokenLimit.source,
      limitSourceLabel: args.limitSourceLabel || args.ctx.inputTokenLimit.sourceLabel,
      maxInputTokens: args.maxInputTokens,
      message: (error?.message || String(error)) + " (Bypassing limit and continuing)",
    });
    return args.modifiedBody;
  }
}
