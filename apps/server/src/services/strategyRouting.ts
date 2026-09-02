import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { providerModels, providers } from "../db/schema";
import {
  getMessagesFromParsedRequest,
  looksLikeClientSidecarText,
  selectCurrentInputMessages,
  serializeContentForLog,
  serializeMessagesForLog,
} from "../utils/chatTurns";
import {
  classifyGatewayRequestClass,
  extractClientRequestedModel,
  isClientNamedSmallFastModel,
} from "./requestRoutingClass";
import {
  resolveRouteProviderProtocol,
  type RouteProtocol,
} from "../utils/routeProtocol";
import type {
  AttemptState,
  RoutingRequirements,
} from "../routes/gateway/types";
import {
  estimateMultimodalInputUsage,
  inspectOutboundCapabilities,
} from "../routes/gateway/inputTokenLimit";
import { resolveModelContextWindow } from "../routes/gateway/gatewayExecutorUtils";
import { hasImageInput, isImageNode } from "../utils/multimodal";
import {
  meetsLongContextSizeGate,
  shouldAttemptLongContextHop,
} from "../routes/gateway/degradePolicy";
import {
  resolveRouteRoutingMode,
  type RoutingMode,
} from "./opcAgentRouting";
export { hasImageInput };
export { LONG_CONTEXT_SIZE_GATE_TOKENS, meetsLongContextSizeGate, shouldAttemptLongContextHop } from "../routes/gateway/degradePolicy";
export {
  capacityTaskTypeForMode,
  resolveRouteRoutingMode,
  ROUTING_MODES,
  shouldBypassCapabilityRouting,
  strategyRoutingEnabledForLayer,
  type RoutingMode,
} from "./opcAgentRouting";

import { applyRoutingWeightOverlay } from "./distillation/routingWeightsBridge";

export { refreshRoutingWeightSnapshot } from "./distillation/routingWeightsBridge";

export const STRATEGY_TASK_TYPES = [
  "vision",
  "debug",
  "code",
  "long_context",
  "writing",
  "general",
] as const;

export type StrategyTaskType = (typeof STRATEGY_TASK_TYPES)[number];

/**
 * Union of task types across routing modes. "vision" and "general" are shared
 * on purpose: the vision capability override, the general fallback in
 * findStrategyRule, and the funnel degrade machinery all key off those two
 * names and keep working unchanged in OPC agent mode.
 */
export type RouteTaskType = StrategyTaskType;

/**
 * Floor for *classifying* a request as long_context from text (logs, documents).
 * Small "check the logs" utterances must not steal the long_context model.
 * Capacity hops (window overflow) do not use this floor.
 */
export const LONG_CONTEXT_STRATEGY_MIN_INPUT_TOKENS = 1_000_000;

export function meetsLongContextStrategyTokenFloor(
  estimatedInputTokens: number,
): boolean {
  return (
    Number.isFinite(estimatedInputTokens) &&
    estimatedInputTokens > LONG_CONTEXT_STRATEGY_MIN_INPUT_TOKENS
  );
}

/** Size/window long_context override. Vision never hops. Quota clip is not a hop. */
export function shouldAttemptLongContextOverride(options: {
  isContextExhausted: boolean;
  /** Ignored. Quota clipping is never a long_context hop. */
  overflowFromGroupClip?: boolean;
  estimatedTotalTokens?: number;
  hasImages?: boolean;
}): boolean {
  return shouldAttemptLongContextHop(options);
}

/**
 * If classification picked long_context but the request is not above the
 * 1M-token floor, demote to the next-best non-long_context task type.
 */
export function applyLongContextStrategyTokenGate(options: {
  taskType: StrategyTaskType;
  estimatedInputTokens: number;
  inputText: string;
}): { taskType: StrategyTaskType; reasons: string[] } {
  if (options.taskType !== "long_context") {
    return { taskType: options.taskType, reasons: [] };
  }
  if (meetsLongContextStrategyTokenFloor(options.estimatedInputTokens)) {
    return { taskType: "long_context", reasons: [] };
  }
  const reasons = [
    `long_context_below_min_tokens:total_${Math.floor(options.estimatedInputTokens)}<=${LONG_CONTEXT_STRATEGY_MIN_INPUT_TOKENS}`,
  ];
  const alt = classifyStrategyTask(options.inputText, false, {
    excludeLongContext: true,
  });
  const taskType =
    alt.taskType === "long_context" ? "general" : alt.taskType;
  return { taskType, reasons: [...reasons, ...alt.reasons] };
}

export interface StrategyRoutingRule {
  taskType: RouteTaskType;
  providerId: string;
  providerProtocol: RouteProtocol;
  modelId: string;
  enabled: boolean;
}

export interface StrategyTaskClassification {
  taskType: StrategyTaskType;
  reasons: string[];
  inputText: string;
  hasImageInput: boolean;
}

export interface StrategyRoutingDecision {
  applied: boolean;
  taskType: RouteTaskType;
  reasons: string[];
  rule: StrategyRoutingRule | null;
  newAttempt?: AttemptState;
  skipReason?: string;
}

const TASK_TYPE_SET = new Set<string>(STRATEGY_TASK_TYPES);

export function isStrategyTaskType(value: unknown): value is StrategyTaskType {
  return typeof value === "string" && TASK_TYPE_SET.has(value);
}

/** Accepts task types from either routing mode (rules are stored in one JSON shape). */
export function isRouteTaskType(value: unknown): value is RouteTaskType {
  return isStrategyTaskType(value);
}

export function extractCurrentUserInputForRouting(body: any): string {
  const messages = getMessagesFromParsedRequest(body);
  if (messages.length > 0) {
    const currentInput = selectCurrentInputMessages(messages);
    const serialized = serializeMessagesForLog(currentInput.messages);
    if (serialized?.trim()) return serialized.trim();
  }

  if (body && typeof body === "object" && !Array.isArray(body)) {
    if (body.prompt !== undefined) {
      return serializeContentForLog(body.prompt)?.trim() || "";
    }
    if (body.input !== undefined) {
      return serializeContentForLog(body.input)?.trim() || "";
    }
  }

  return "";
}

/**
 * Unwraps agentic protocol wrappers (JSON message arrays, system-reminder tags)
 * to extract the real user intent, then normalizes whitespace and casing.
 * Production data shows ~49% of inputs arrive wrapped in these structures.
 */
export function normalizeStrategyInput(text: string) {
  return (text || "")
    .replace(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g, " [image] ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

import { Jieba } from "@node-rs/jieba";
import { dict } from "@node-rs/jieba/dict";
import {
  hasLongContextLogAnalyzeSignal,
  isAgenticProtocolPayload,
  matchStrategyUtterance,
} from "./strategyRouteUtterances";
import { analyzeBugIntent } from "./strategyRouteBugAnalysis";
import {
  collectContentRouteEvidence,
  isCompletedResolvedFailureStatement,
  maskFencedSourceForFailureAnalysis,
  resolveContentRoute,
} from "./strategyRouteContentAnalysis";
import { analyzeFailureIntent } from "./strategyRouteFailureAnalysis";
import {
  hasDiagnosticAction,
  hasLogAnalysisAction,
} from "./strategyRouteTextSignals";

const jieba = Jieba.withDict(dict);

/**
 * Jieba-based supplementary weight dictionary.
 * These weights are only consulted when no primary regex guard fires,
 * providing a second chance to classify borderline inputs.
 * Weights were tuned against production data from chat_logs.
 *
 * IMPORTANT: Do NOT add ambiguous English words here (let, var, return, class, etc.)
 * — those are handled by the regex layer with proper \b word boundaries and
 * surrounding context. Jieba tokenizes English by whitespace, so single common
 * English words would cause massive false positives.
 */
export const ROUTING_WEIGHTS: Record<string, Record<string, number>> = {
  debug: {
    报错: 10,
    error: 10,
    bug: 8,
    失败: 5,
    异常: 8,
    exception: 10,
    崩溃: 8,
    排查: 8,
    无效: 10,
    crash: 8,
    failed: 5,
    failure: 5,
    timeout: 8,
    panic: 8,
    // Production data: negative user feedback (chat_logs analysis)
    不行: 5,
    不对: 5,
    不能: 3,
  },
  code: {
    代码: 10,
    组件: 8,
    接口: 8,
    函数: 8,
    前端: 5,
    后端: 5,
    页面: 5,
    样式: 5,
    数据库: 5,
    重构: 5,
    路由: 5,
    筛选: 5,
    分页: 5,
    跳转: 5,
    参数: 5,
    调用: 5,
    按钮: 5,
    排序功能: 5,
    配置: 3,
    修改: 3,
    // Production data: high-frequency dev terms from chat_logs
    列表: 5,
    返回: 3,
    状态: 3,
    数据: 3,
    格式: 3,
    菜单: 5,
    输入框: 5,
    内边距: 5,
    播放: 3,
    刷新: 5,
    功能: 3,
    居中: 5,
    传入: 3,
    字符串: 5,
    数组: 5,
    对象: 3,
    // Production data round 4
    驼峰: 5,
    负数: 5,
    下拉: 5,
    弹层: 5,
  },
  writing: {
    文章: 8,
    润色: 8,
    文案: 8,
    翻译: 8,
    总结: 8,
    邮件: 8,
    故事: 8,
    起草: 10,
    方案: 5,
    polish: 8,
    translate: 8,
    email: 8,
    rewrite: 8,
    article: 8,
    story: 8,
    changelog: 5,
    draft: 5,
    // Production data: content generation terms
    总结一下: 8,
    生成: 5,
    文档: 5,
  },
};

export interface ClassifyStrategyOptions {
  /** Skip vision keyword/image early return (intent path has no vision enum). */
  skipVision?: boolean;
  /** Skip agentic protocol → code (continuation turns keep previous model intent). */
  skipAgentic?: boolean;
  /**
   * Do not return long_context (used when reclassifying after the 1M-token
   * strategy floor rejects long_context routing).
   */
  excludeLongContext?: boolean;
  /**
   * Enable the debug `protocol_error` pre-check. Only the continuation path
   * may set this: harness wrappers (`<system-reminder>`, CLAUDE.md) on a
   * fresh user_intent must not be routed as debug because workspace docs
   * mention 失败/error.
   */
  allowProtocolError?: boolean;
}

function isLogAnalysisFailureTheme(evidence: {
  clause: string;
  match: string;
}): boolean {
  const clause = evidence.clause.toLowerCase();
  if (hasDiagnosticAction(clause)) {
    return false;
  }

  const matchIndex = clause.indexOf(evidence.match.toLowerCase());
  const logMatch = /\b(?:logs?|log\s+files?)\b|日志/.exec(clause);
  if (!logMatch || matchIndex < 0) return false;

  if (matchIndex < logMatch.index) {
    const beforeLog = clause.slice(0, logMatch.index);
    const between = clause.slice(
      matchIndex + evidence.match.length,
      logMatch.index,
    );
    return (
      hasLogAnalysisAction(beforeLog) &&
      /\b(?:in|from|within|across)\b/.test(between)
    );
  }

  const between = clause.slice(
    logMatch.index + logMatch[0].length,
    matchIndex,
  );
  return (
    /\b(?:for|with|where|containing|about|matching|that\s+(?:show|contain)|to\s+find)\b/.test(
      between,
    ) || /中(?:的)?|里(?:的)?|包含|关于/.test(between)
  );
}

export function classifyStrategyTask(
  text: string,
  hasCurrentImageInput: boolean,
  options?: ClassifyStrategyOptions,
): StrategyTaskClassification {
  const truncatedText = (text || "").slice(0, 8000);
  const normalized = normalizeStrategyInput(truncatedText);
  const reasons: string[] = [];
  const skipVision = !!options?.skipVision;
  const skipAgentic = !!options?.skipAgentic;
  const excludeLongContext = !!options?.excludeLongContext;

  // --- 1. Vision: actual image input first (misrouting crashes non-vision models) ---
  if (!skipVision && hasCurrentImageInput) {
    reasons.push("image_input");
    return {
      taskType: "vision",
      reasons,
      inputText: text,
      hasImageInput: true,
    };
  }

  // Client sidecar (safety classifier, permission gate, …): the embedded
  // transcript often contains stack traces, but the *task* is only to emit a
  // severity token. Markers can sit at the end of a huge payload, so scan the
  // full text — not the 8k classification window. Must beat vision *keywords*
  // in the transcript; real image parts already returned above.
  if (looksLikeClientSidecarText(text) || looksLikeClientSidecarText(truncatedText)) {
    reasons.push("client_sidecar");
    return {
      taskType: "general",
      reasons,
      inputText: text,
      hasImageInput: false,
    };
  }

  if (
    !skipVision &&
    (/\b(image|screenshot|vision|picture|photo|jpg|jpeg|png|webp|gif|ocr)\b|截图|图片|图像|视觉|照片|图中|图里|原图|大图|识别图|海报|头像|logo|二维码|attached media from tool result/.test(
        normalized,
      ) ||
      /"type"\s*:\s*"(?:image_url|image|input_image)"|"image_url"\s*:|"image"\s*:/i.test(
        truncatedText,
      ))
  ) {
    reasons.push("vision_keyword");
    return {
      taskType: "vision",
      reasons,
      inputText: text,
      hasImageInput: false,
    };
  }

  const agenticPayload = isAgenticProtocolPayload(normalized, truncatedText);

  // Continuation wrappers inherit the previous turn's intent. Their embedded
  // tool errors, tickets, or file paths must not create a new task type.
  if (skipAgentic && agenticPayload) {
    reasons.push("agentic_continuation");
    return {
      taskType: "general",
      reasons,
      inputText: text,
      hasImageInput: false,
    };
  }

  // --- 1b. Debug Protocol: Tool errors & System crash indicators (O(1) pre-check) ---
  // Continuation-only: user_intent with agent harness wrappers must not trip this.
  if (
    options?.allowProtocolError &&
    /tool_result|role["\s]*:["\s]*tool|system-reminder|system_reminder/.test(
      normalized,
    ) &&
    (/error|exception|fail|timeout|crash|panic|reject|invalid|undefined|not defined|is null|is empty|not found|not registered/.test(
      normalized,
    ) ||
      /zsh:.*not found|enoent:/.test(normalized) ||
      /报错|异常|超时|失败|崩溃|修复|排查|不生效|没生效|白屏|错乱/.test(
        normalized,
      ))
  ) {
    reasons.push("protocol_error");
    return {
      taskType: "debug",
      reasons,
      inputText: text,
      hasImageInput: false,
    };
  }

  // --- 1c. Code Protocol: agentic payloads on a fresh turn ---
  if (agenticPayload) {
    reasons.push("agentic_protocol_marker");
    return { taskType: "code", reasons, inputText: text, hasImageInput: false };
  }

  const utteranceHit = matchStrategyUtterance(normalized);
  if (!skipVision && utteranceHit?.taskType === "vision") {
    reasons.push(utteranceHit.reason);
    return {
      taskType: "vision",
      reasons,
      inputText: text,
      hasImageInput: false,
    };
  }

  const failureAnalysis = analyzeFailureIntent(
    maskFencedSourceForFailureAnalysis(truncatedText),
  );
  const bugAnalysis = analyzeBugIntent(normalized);
  const contentEvidence = collectContentRouteEvidence(truncatedText);
  const routingLiveFailures = failureAnalysis.live.filter(
    (evidence) =>
      !(
        contentEvidence.logs.analysisTask &&
        isLogAnalysisFailureTheme(evidence)
      ),
  );
  const designSpec =
    failureAnalysis.design.length > 0 && routingLiveFailures.length === 0;
  const bugRelevant =
    bugAnalysis.hasBrand ||
    bugAnalysis.hasTicket ||
    bugAnalysis.clauses.some((clause) => clause.hasBugWord);
  const deferBareTicketToContent =
    bugAnalysis.reason === "bug_ticket" &&
    (contentEvidence.writing.explicitTask ||
      contentEvidence.logs.analysisTask);

  // Live clauses and actionable bug clauses outrank code, writing, and long
  // payload shape. A design clause only suppresses its own failure mention.
  if (routingLiveFailures.length > 0) {
    reasons.push("debug_live_failure");
    return {
      taskType: "debug",
      reasons,
      inputText: text,
      hasImageInput: false,
    };
  }
  if (
    bugRelevant &&
    bugAnalysis.isDebug &&
    !deferBareTicketToContent
  ) {
    reasons.push(`debug_${bugAnalysis.reason}`);
    return {
      taskType: "debug",
      reasons,
      inputText: text,
      hasImageInput: false,
    };
  }

  // Exact/controlled debug aliases remain useful for stack-paste phrases, but
  // never override a feature specification, product name, or writing frame.
  if (
    utteranceHit?.taskType === "debug" &&
    !designSpec &&
    !bugAnalysis.isProductOnly &&
    bugAnalysis.reason !== "writing_about_bug" &&
    !deferBareTicketToContent &&
    (!contentEvidence.logs.analysisTask ||
      hasDiagnosticAction(normalized)) &&
    !contentEvidence.writing.explicitTask
  ) {
    reasons.push(utteranceHit.reason);
    return {
      taskType: "debug",
      reasons,
      inputText: text,
      hasImageInput: false,
    };
  }

  const contentRoute = resolveContentRoute(
    contentEvidence,
    utteranceHit?.taskType === "vision" && skipVision
      ? null
      : utteranceHit?.taskType,
  );
  if (
    contentRoute &&
    !(excludeLongContext && contentRoute.taskType === "long_context")
  ) {
    reasons.push(
      contentRoute.reason === "content_large_input"
        ? "large_input"
        : contentRoute.reason,
    );
    return {
      taskType: contentRoute.taskType,
      reasons,
      inputText: text,
      hasImageInput: false,
    };
  }

  if (
    designSpec &&
    isCompletedResolvedFailureStatement(normalized)
  ) {
    reasons.push("resolved_failure_state");
    return {
      taskType: "general",
      reasons,
      inputText: text,
      hasImageInput: false,
    };
  }

  if (
    designSpec &&
    (/^(?:the\s+)?(?:error|failure|crash|exception|layout issue)\s+(?:is|was|has been|had been)\s+(?:resolved|fixed|repaired)\s*[.!]?$/i.test(
      normalized,
    ) ||
      /^(?:页面)?(?:错位|崩溃|报错|错误|失败|异常)(?:已经?|已|得到)(?:解决|修复|修好|恢复)\s*[。！.]?$/.test(
        normalized,
      ))
  ) {
    reasons.push("resolved_failure_state");
    return {
      taskType: "general",
      reasons,
      inputText: text,
      hasImageInput: false,
    };
  }

  // Preserve the legacy migration/log vocabulary as a weak fallback. All
  // explicit code/writing/source evidence has already won above.
  if (!excludeLongContext && hasLongContextLogAnalyzeSignal(normalized)) {
    reasons.push("long_context_keyword");
    return {
      taskType: "long_context",
      reasons,
      inputText: text,
      hasImageInput: false,
    };
  }

  // --- 3. Code: programming keywords, file references, CSS properties, dev terminology ---
  const looksLikeCode =
    // File extensions
    /\.(tsx|ts|jsx|js|vue|java|py|go|rs|cpp|c|cs|php|rb|sql|swift|kt)\b/.test(
      normalized,
    ) ||
    // File path references (src/xxx or src\xxx, pages/, views/, components/)
    /\bsrc[/\\]|(?:^|[\s/\\])(?:pages|views|components|packages|package)[/\\]|\b[\w-]{1,50}packages\/[\w-]{1,50}\/|\b[\w-]{1,50}\/[\w-]{1,50}\/index\b/.test(
      normalized,
    ) ||
    // CSS property names and measurement units (extremely strong code signal)
    (/\b(?:padding|margin(?:-[a-z-]+)?|border-radius|opacity|font-size|background-color|z-index|gap|display|grid|flex)\s*:/i.test(
      normalized,
    ) ||
      /\.[a-z][\w-]*.{0,32}\b(?:padding|margin(?:-[a-z-]+)?|border-radius|opacity|font-size|background-color|z-index|gap|display|grid|flex)\b/i.test(
        normalized,
      ) ||
      /\b(?:css|scss|sass|less|styles?|stylesheet|layout|component|element)\b.{0,48}\b(?:padding|margin|border-radius|opacity|font-size|background-color|z-index|gap|display|grid|flex)\b/i.test(
        normalized,
      ) ||
      /(?:去掉|修改|设置|调整|改为).{0,20}\b(?:padding|margin(?:-[a-z-]+)?|border-radius|opacity|font-size|background-color|z-index|gap|display|grid|flex)\b/i.test(
        normalized,
      ) ||
      /\b(?:padding|margin(?:-[a-z-]+)?|border-radius|opacity|font-size|background-color|z-index|gap|display|grid|flex)\b.{0,20}(?:改为|设置为|调整为)/i.test(
        normalized,
      ) ||
      /\d+r?px\b/.test(normalized)) ||
    // Chinese dev terminology — UI elements and dev concepts
    /代码|接口|组件|函数|编译|重构|页面|样式|字段|参数|调用|分页|筛选|弹框|弹窗|跳转|路由|回显|排序|传参|分包|克隆|折线图/.test(
      normalized,
    ) ||
    // Production data: Java/Spring class naming — suffix match (toLowerCase breaks \b for PascalCase)
    /\b[a-z][a-z0-9_]{1,}(?:controller|service|repository|entity|mapper|dto)\b/.test(
      normalized,
    ) ||
    // Java type errors and generics
    /\btype mismatch|\bgeneric|\bmono<|\bflux<|\bmap<|\blist</.test(
      normalized,
    ) ||
    // Production data round 2: API path references and date/format specs
    /\/api\/|yyyy|hh:mm|格式化|从底部弹出|底部弹/.test(normalized) ||
    // Production data round 3: CSS selectors, code constructs
    /\.[a-z][\w-]*\[|\bwindow\.|\bconsole\.|\.then\(|\=\>/.test(
      truncatedText.replace(/\s+/g, " "),
    ) ||
    /清空功能|垂直居中|水平居中|靠上|靠下|靠左|靠右/.test(normalized) ||
    // Production data round 5 (MDP): UI styling terms (require dev-adjacent context to avoid false positives)
    /自动撑开|写死|边距/.test(normalized) ||
    /提交到远程仓库|新建.*md/.test(normalized) ||
    /\b(font-weight|redisson|commonjs|gradlew|redis|mysql|docker|nginx)\b/.test(
      normalized,
    ) ||
    // Production data round 6 (MDP review): git ops, HTML tags, hex colors, terminal commands
    /合并到.*(main|master|dev)|提交到|推送到/.test(normalized) ||
    /<script|<div|<span|<style|<link|<img|<form/.test(normalized) ||
    /#[0-9a-f]{6}\b/.test(normalized) ||
    /\b(nc|curl|wget|chmod|mkdir|npm|pnpm|yarn|pip|git|gradle)\b/.test(
      normalized,
    ) ||
    // Production data round 7: camelCase method names (strong code signal)
    /\b[a-z]+[A-Z]\w*\b/.test(truncatedText) ||
    // Chinese dev verbs with tech context
    /改为#|改为\d|改为0x|改为https?|引入|调试|部署/.test(normalized) ||
    // Production data round 8-10 (MDP review): file refs, dev tools, UI actions
    /\.tgz\b|\.png\b|\.jpg\b|\.svg\b|\.css\b|\.html\b|\.json\b|\.xml\b|\.yml\b|\.yaml\b|\.sh\b|\.md\b/.test(
      normalized,
    ) ||
    /\bskill\.md\b|\bworktree\b|\bmcp\b|\boss\b|\bcdn\b|\bapi\b/.test(
      normalized,
    ) ||
    /拖拽|滑动|虚化|卡片|弹屏|弧角|序号|导航|开关|显隐|注入|封装/.test(
      normalized,
    ) ||
    /安装|运行|启动|构建|打包/.test(normalized) ||
    // Production data round 11-15 (MDP review): UI layout, Java annotations, web search
    /展示|平齐|竖向|横向|换行|一行展示|左右对.|上下对.|按label对齐|复选框|全选|批量/.test(
      normalized,
    ) ||
    /\b@(?:post|get|put|delete|patch|request)mapping\b/.test(normalized) ||
    /perform a web search|\bweb search for the query\b/.test(normalized) ||
    /圆形|赋值|字符|数组|对象|列表|表头|表格|复用|返回上一|还原/.test(
      normalized,
    ) ||
    // Production data round 16-20 (MDP review): UI micro-interactions, dev ops
    /间距|去掉|增加.*间距|秒.*消失|消失|分支|映射|回调|充值|缴纳|退款|退住|打印/.test(
      normalized,
    ) ||
    /search the codebase|find all files/.test(normalized) ||
    /\{"[a-z]+":\s*[\d"\[{]/.test(normalized) ||
    /提示.*成功|提示.*失败|下边框|上边框/.test(normalized) ||
    // Production data round 20+ (MDP review): store/backend, placeholder, scanning
    /\b(?:redux|pinia|vuex|zustand|state)\s+stores?\b|\bstores?\.(?:dispatch|getstate|setstate|subscribe)\b|后端|占位图|扫码|二维码|校验|重名/.test(
      normalized,
    ) ||
    // Production data (MDP review 2): UI interaction and specific layouts
    /触底|加载更多|自适应|自提|json|cicd|openapi|坐标|地图|对齐/.test(
      normalized,
    );

  if (looksLikeCode) {
    reasons.push("code_signal");
    return { taskType: "code", reasons, inputText: text, hasImageInput: false };
  }

  // --- 5. Writing: content creation and editing ---
  if (
    /\b(write|rewrite|polish|story|copy|email|article|translate|release notes|changelog)\b|写作|润色|文案|文章|邮件|故事|翻译|发布说明|更新说明/.test(
      normalized,
    )
  ) {
    reasons.push("writing_keyword");
    return {
      taskType: "writing",
      reasons,
      inputText: text,
      hasImageInput: false,
    };
  }

  // --- 6. Jieba supplementary scoring (catches borderline cases that slip through regex) ---
  // Brand spans are removed before supplementary scoring. Design, writing, and
  // non-actionable bug topics must not regain debug intent through token weight.
  const words = jieba.cut(bugAnalysis.brandMaskedText, false);
  let debugScore = 0;
  let codeScore = 0;
  let writingScore = 0;
  const skipDebugTheme =
    bugAnalysis.isProductOnly ||
    bugAnalysis.reason === "writing_about_bug" ||
    bugAnalysis.reason === "bug_topic" ||
    designSpec ||
    /\b(?:(?:with|need)\s+)?(?:timeout|error|exception|failure)\s+handling\b/.test(
      normalized,
    ) ||
    /(?:新增|增加|添加|加|实现|开发|支持|配置).{0,16}(?:报错|异常|堆栈|崩溃|白屏|失败).{0,16}(?:提示|展示|功能|监控|告警|上报)/.test(
      normalized,
    ) ||
    /\b(?:measurement|mean\s+squared|standard|sampling|margin\s+of|human)\s+errors?\b|\berror\s+(?:rate|term|metric|function|distribution)\b/.test(
      normalized,
    ) ||
    /\b(article|biography|release notes|workplace policy|recommendations in this report)\b/.test(
      normalized,
    );

  for (const word of words) {
    const w = word.toLowerCase();
    const debugWeights = applyRoutingWeightOverlay("debug", ROUTING_WEIGHTS.debug);
    const codeWeights = applyRoutingWeightOverlay("code", ROUTING_WEIGHTS.code);
    const writingWeights = applyRoutingWeightOverlay("writing", ROUTING_WEIGHTS.writing);
    if (w in debugWeights) {
      if (
        (skipDebugTheme || routingLiveFailures.length === 0) &&
        (w === "bug" ||
          w === "error" ||
          w === "timeout" ||
          w === "fail" ||
          w === "failed" ||
          w === "failure" ||
          w === "exception" ||
          w === "crash" ||
          w === "panic" ||
          w === "报错" ||
          w === "异常" ||
          w === "崩溃" ||
          w === "失败" ||
          w === "超时")
      ) {
        // skip branding / design-spec / writing theme tokens
      } else {
        debugScore += debugWeights[w];
      }
    }
    if (w in codeWeights) codeScore += codeWeights[w];
    if (w in writingWeights)
      writingScore += writingWeights[w];
  }

  const THRESHOLD = 5;

  if (
    debugScore >= THRESHOLD &&
    debugScore >= codeScore &&
    debugScore >= writingScore
  ) {
    reasons.push(`jieba_debug_score_${debugScore}`);
    return {
      taskType: "debug",
      reasons,
      inputText: text,
      hasImageInput: false,
    };
  }
  if (
    codeScore >= THRESHOLD &&
    codeScore >= debugScore &&
    codeScore >= writingScore
  ) {
    reasons.push(`jieba_code_score_${codeScore}`);
    return { taskType: "code", reasons, inputText: text, hasImageInput: false };
  }
  if (
    writingScore >= THRESHOLD &&
    writingScore >= debugScore &&
    writingScore >= codeScore
  ) {
    reasons.push(`jieba_writing_score_${writingScore}`);
    return {
      taskType: "writing",
      reasons,
      inputText: text,
      hasImageInput: false,
    };
  }

  // --- 7. General utterance exact match (soft), then default ---
  if (utteranceHit?.taskType === "general") {
    reasons.push(utteranceHit.reason);
    return {
      taskType: "general",
      reasons,
      inputText: text,
      hasImageInput: false,
    };
  }

  reasons.push("default");
  return {
    taskType: "general",
    reasons,
    inputText: text,
    hasImageInput: false,
  };
}

/**
 * Intent path mirrors strategy classification (same failure priority, utterances, bug gates).
 * No vision enum here: skipVision. Continuations skip agentic protocol → code.
 */
export function classifyIntentTaskType(
  text: string,
  isContinuation?: boolean,
): "debug" | "code" | "long_context" | "writing" | "general" {
  const result = classifyStrategyTask(text, false, {
    skipVision: true,
    skipAgentic: !!isContinuation,
    allowProtocolError: !!isContinuation,
  });
  if (result.taskType === "vision") {
    // Defensive: skipVision should prevent this
    return "general";
  }
  return result.taskType;
}

export async function computeRoutingRequirements(
  body: any,
  activeModelConfig: any,
  isContinuation?: boolean,
  prevBody?: any,
): Promise<RoutingRequirements> {
  const tokenEst = await estimateMultimodalInputUsage({ body });
  const currentUserTurnHasImage = tokenEst.imageCount > 0;
  const outboundPayloadHasImage = tokenEst.imageCount > 0;
  const imageCount = tokenEst.imageCount;

  const sourceBody = prevBody || body;
  const inputText = extractCurrentUserInputForRouting(sourceBody);
  const intentTaskType = classifyIntentTaskType(
    inputText,
    isContinuation || !!prevBody,
  );

  let requiresLongContext = false;
  const contextBudget = resolveModelContextWindow(activeModelConfig);
  if (!outboundPayloadHasImage) {
    if (meetsLongContextSizeGate(tokenEst.totalTokens)) {
      requiresLongContext = true;
    } else if (contextBudget.limit > 0) {
      let requestedOutputTokens = 0;
      if (body?.max_tokens) requestedOutputTokens = body.max_tokens;
      else if (body?.max_completion_tokens)
        requestedOutputTokens = body.max_completion_tokens;
      else if (activeModelConfig?.maxOutputTokens)
        requestedOutputTokens = activeModelConfig.maxOutputTokens;

      const safetyMargin = 50;
      if (contextBudget.kind === "max_input") {
        requiresLongContext =
          tokenEst.totalTokens + safetyMargin > contextBudget.limit;
      } else {
        requiresLongContext =
          tokenEst.totalTokens + requestedOutputTokens + safetyMargin >
          contextBudget.limit;
      }
    }
  }
  return {
    intentTaskType,
    requiredCapabilities: {
      vision: outboundPayloadHasImage,
    },
    currentUserTurnHasImage,
    outboundPayloadHasImage,
    imageCount,
    requiresLongContext,
    estimatedTextTokens: tokenEst.textTokens,
    estimatedImageTokens: tokenEst.imageTokens,
    estimatedTotalTokens: tokenEst.totalTokens,
  };
}

export function getDeclaredVisionModels(route: any): Set<string> {
  const visionModels = new Set<string>();

  const collect = (rulesStr: any) => {
    if (!rulesStr) return;
    let rules: any[] = [];
    if (typeof rulesStr === "string") {
      try {
        rules = JSON.parse(rulesStr);
      } catch {
        return;
      }
    } else if (Array.isArray(rulesStr)) {
      rules = rulesStr;
    }
    for (const rule of rules) {
      if (
        rule &&
        typeof rule === "object" &&
        rule.taskType === "vision" &&
        rule.enabled !== false
      ) {
        if (rule.providerId && rule.modelId) {
          visionModels.add(`${rule.providerId}:${rule.modelId}`);
        }
      }
    }
  };

  collect(route.strategyRoutingRules);
  collect(route.fallbackStrategyRoutingRules);

  if (route.targets) {
    try {
      const parsed =
        typeof route.targets === "string"
          ? JSON.parse(route.targets)
          : route.targets;
      if (Array.isArray(parsed)) {
        for (const target of parsed) {
          collect(target.strategyRoutingRules);
        }
      }
    } catch {}
  }

  return visionModels;
}

export function parseStrategyRoutingRules(
  value: unknown,
): StrategyRoutingRule[] {
  let raw = value;
  if (typeof value === "string") {
    if (!value.trim()) return [];
    try {
      raw = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(raw)) return [];

  const rules: StrategyRoutingRule[] = [];
  const seen = new Set<RouteTaskType>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const candidate = item as Record<string, unknown>;
    if (!isRouteTaskType(candidate.taskType)) continue;
    if (seen.has(candidate.taskType)) continue;
    const providerId =
      typeof candidate.providerId === "string"
        ? candidate.providerId.trim()
        : "";
    const modelId =
      typeof candidate.modelId === "string" ? candidate.modelId.trim() : "";
    const providerProtocol =
      candidate.providerProtocol === "anthropic" ? "anthropic" : "openai";
    if (!providerId || !modelId) continue;
    seen.add(candidate.taskType);
    rules.push({
      taskType: candidate.taskType,
      providerId,
      providerProtocol,
      modelId,
      enabled: candidate.enabled !== false,
    });
  }
  return rules;
}

export function stringifyStrategyRoutingRules(rules: StrategyRoutingRule[]) {
  return JSON.stringify(
    rules.map((rule) => ({
      taskType: rule.taskType,
      providerId: rule.providerId,
      providerProtocol: rule.providerProtocol,
      modelId: rule.modelId,
      enabled: rule.enabled !== false,
    })),
  );
}

export function findStrategyRule(
  rules: StrategyRoutingRule[],
  taskType: RouteTaskType,
): StrategyRoutingRule | null {
  const direct = rules.find(
    (rule) => rule.enabled !== false && rule.taskType === taskType,
  );
  if (direct) return direct;
  return (
    rules.find(
      (rule) => rule.enabled !== false && rule.taskType === "general",
    ) || null
  );
}

export async function validateAndNormalizeStrategyRules(options: {
  enabled: boolean;
  incomingProtocol: string;
  rules: unknown;
}): Promise<
  { ok: true; rules: StrategyRoutingRule[] } | { ok: false; error: string }
> {
  if (!options.enabled)
    return { ok: true, rules: parseStrategyRoutingRules(options.rules) };

  const rules = parseStrategyRoutingRules(options.rules);
  if (rules.length === 0) {
    return { ok: false, error: "启用策略路由时必须至少配置一个任务类型规则" };
  }
  if (
    !rules.some((rule) => rule.enabled !== false && rule.taskType === "general")
  ) {
    return { ok: false, error: "策略路由必须配置 general 兜底规则" };
  }

  const normalized: StrategyRoutingRule[] = [];
  for (const rule of rules) {
    if (rule.enabled === false) {
      // Skip validation for disabled rules, just pass them through
      normalized.push({
        ...rule,
        providerProtocol: rule.providerProtocol || "openai", // fallback protocol if missing
      });
      continue;
    }

    const providerRows = await db
      .select()
      .from(providers)
      .where(eq(providers.id, rule.providerId))
      .limit(1);
    if (providerRows.length === 0 || !providerRows[0].enabled) {
      return {
        ok: false,
        error: `策略路由 ${rule.taskType} 的供应商不存在或已停用`,
      };
    }
    const modelRows = await db
      .select()
      .from(providerModels)
      .where(
        and(
          eq(providerModels.providerId, rule.providerId),
          eq(providerModels.modelId, rule.modelId),
          eq(providerModels.enabled, true),
          eq(providerModels.active, true),
        ),
      )
      .limit(1);
    if (modelRows.length === 0) {
      return {
        ok: false,
        error: `策略路由 ${rule.taskType} 的模型不存在、未启用或已失效`,
      };
    }
    const allProviderModels = await db
      .select()
      .from(providerModels)
      .where(eq(providerModels.providerId, rule.providerId));
    const protocol = resolveRouteProviderProtocol({
      incomingProtocol: options.incomingProtocol,
      provider: {
        hasOpenaiEndpoint: !!providerRows[0].openaiBaseUrl,
        hasAnthropicEndpoint: !!providerRows[0].anthropicBaseUrl,
      },
      models: allProviderModels,
      modelId: rule.modelId,
    });
    if (!protocol.ok) {
      return {
        ok: false,
        error: `策略路由 ${rule.taskType}: ${protocol.error}`,
      };
    }
    normalized.push({
      ...rule,
      providerProtocol: protocol.providerProtocol,
    });
  }

  return { ok: true, rules: normalized };
}

export async function validateOneStrategyRule(options: {
  incomingProtocol: string;
  rule: StrategyRoutingRule;
}): Promise<
  { ok: true; rule: StrategyRoutingRule } | { ok: false; error: string }
> {
  if (options.rule.enabled === false) {
    return { ok: false, error: `规则已被禁用` };
  }
  const providerRows = await db
    .select()
    .from(providers)
    .where(eq(providers.id, options.rule.providerId))
    .limit(1);
  if (providerRows.length === 0 || !providerRows[0].enabled) {
    return { ok: false, error: `供应商不存在或已停用` };
  }
  const modelRows = await db
    .select()
    .from(providerModels)
    .where(
      and(
        eq(providerModels.providerId, options.rule.providerId),
        eq(providerModels.modelId, options.rule.modelId),
        eq(providerModels.enabled, true),
        eq(providerModels.active, true),
      ),
    )
    .limit(1);
  if (modelRows.length === 0) {
    return { ok: false, error: `模型不存在、未启用或已失效` };
  }
  const allProviderModels = await db
    .select()
    .from(providerModels)
    .where(eq(providerModels.providerId, options.rule.providerId));
  const protocol = resolveRouteProviderProtocol({
    incomingProtocol: options.incomingProtocol,
    provider: {
      hasOpenaiEndpoint: !!providerRows[0].openaiBaseUrl,
      hasAnthropicEndpoint: !!providerRows[0].anthropicBaseUrl,
    },
    models: allProviderModels,
    modelId: options.rule.modelId,
  });
  if (!protocol.ok) {
    console.log(
      "PROTOCOL ERROR:",
      protocol.error,
      "models:",
      allProviderModels.map((m) => m.modelId),
      "target:",
      options.rule.modelId,
    );
    return { ok: false, error: protocol.error };
  }
  return {
    ok: true,
    rule: {
      ...options.rule,
      providerProtocol: protocol.providerProtocol,
    },
  };
}

export async function resolveStrategyRoutingDecision(options: {
  route: any;
  body: any;
  currentAttempt: AttemptState;
  incomingProtocol: string;
  previousModelId?: string | null;
  isContinuation?: boolean;
}): Promise<StrategyRoutingDecision | null> {
  let strategyRoutingEnabled = options.route?.strategyRoutingEnabled;
  let strategyRoutingRules = options.route?.strategyRoutingRules;

  if (options.route?.targets) {
    try {
      const parsedTargets =
        typeof options.route.targets === "string"
          ? JSON.parse(options.route.targets)
          : options.route.targets;
      const targetIndex = options.currentAttempt.targetIndex || 0;
      if (Array.isArray(parsedTargets) && parsedTargets.length > targetIndex) {
        strategyRoutingEnabled =
          parsedTargets[targetIndex].strategyRoutingEnabled;
        strategyRoutingRules = parsedTargets[targetIndex].strategyRoutingRules;
      }
    } catch (e) {}
  }

  if (!strategyRoutingEnabled) {
    return null;
  }
  if (options.currentAttempt.isFallback && !options.currentAttempt.reapplyLayerStrategy) {
    return null;
  }

  const routingMode = resolveRouteRoutingMode(options.route);

  const requestClass = classifyGatewayRequestClass(options.body);
  if (requestClass.requestClass === "client_sidecar") {
    return {
      applied: false,
      taskType: "general" as StrategyTaskType,
      reasons: requestClass.reasons,
      rule: null,
      skipReason: "client_sidecar",
    };
  }

  // Client placeholder model ids must never suppress routing.
  if (
    requestClass.requestClass === "user_intent" &&
    isClientNamedSmallFastModel(extractClientRequestedModel(options.body))
  ) {
    return {
      applied: false,
      taskType: "general" as StrategyTaskType,
      reasons: ["client_named_small_model"],
      rule: null,
      skipReason: "client_named_small_model",
    };
  }

  const parseRules = (rulesStr: any) => {
    if (!rulesStr) return [];
    if (typeof rulesStr === "string") {
      try {
        return JSON.parse(rulesStr);
      } catch {
        return [];
      }
    }
    return rulesStr;
  };

  const defaultModelConfigRows = await db
    .select()
    .from(providerModels)
    .where(
      and(
        eq(providerModels.providerId, options.currentAttempt.providerId),
        eq(providerModels.modelId, options.currentAttempt.modelId),
      ),
    )
    .limit(1);
  const activeModelConfig =
    defaultModelConfigRows.length > 0 ? defaultModelConfigRows[0] : null;
  const routingReq = await computeRoutingRequirements(
    options.body,
    activeModelConfig,
    options.isContinuation,
  );

  const parsedRules = parseRules(strategyRoutingRules);

  // If outbound payload contains image: selected target must be current layer vision rule!
  if (routingReq.requiredCapabilities.vision) {
    const rule = parsedRules.find(
      (r: any) => r.taskType === "vision" && r.enabled !== false,
    );
    if (!rule) {
      return {
        applied: false,
        taskType: "vision",
        reasons: ["required_capability_vision", "no_matching_vision_rule"],
        rule: null,
        skipReason: "no_matching_rule",
      };
    }
    const validation = await validateOneStrategyRule({
      incomingProtocol: options.incomingProtocol,
      rule,
    });
    if (!validation.ok) {
      return {
        applied: false,
        taskType: "vision",
        reasons: [
          "required_capability_vision",
          `Validation failed: ${validation.error}`,
        ],
        rule: null,
        skipReason: "validation_failed",
      };
    }
    if (
      options.currentAttempt.modelId === rule.modelId &&
      options.currentAttempt.providerId === rule.providerId
    ) {
      return {
        applied: false,
        taskType: "vision",
        reasons: [
          "required_capability_vision",
          `Already on vision model ${rule.modelId}`,
        ],
        rule: null,
        skipReason: "already_on_target",
      };
    }
    return {
      applied: true,
      taskType: "vision",
      reasons: [
        "required_capability_vision",
        `Switching to vision rule model ${rule.modelId}`,
      ],
      rule: {
        taskType: "vision" as StrategyTaskType,
        modelId: rule.modelId,
        providerId: rule.providerId,
        providerProtocol: validation.rule.providerProtocol,
        enabled: true,
      },
      newAttempt: {
        providerId: rule.providerId,
        providerProtocol: validation.rule.providerProtocol,
        modelId: rule.modelId,
        promptPolicyId: options.route.promptPolicyId || null,
        isFallback: false,
        fallbackReason: "",
        targetIndex: options.currentAttempt.targetIndex || 0,
      },
    };
  }

  if (options.currentAttempt.reapplyLayerStrategy) {
    const inherited = options.currentAttempt.strategyTaskType;
    const inheritedReapplicable =
      !!inherited &&
      inherited !== "long_context" &&
      inherited !== "vision" &&
      isStrategyTaskType(inherited);
    if (inherited && inheritedReapplicable && isRouteTaskType(inherited)) {
      const rules = parseRules(strategyRoutingRules);
      const rule = findStrategyRule(rules, inherited);
      if (rule) {
        const validation = await validateOneStrategyRule({
          incomingProtocol: options.incomingProtocol,
          rule,
        });
        if (validation.ok) {
          const normalizedRule = validation.rule;
          const sameTarget =
            normalizedRule.providerId === options.currentAttempt.providerId &&
            normalizedRule.providerProtocol === options.currentAttempt.providerProtocol &&
            normalizedRule.modelId === options.currentAttempt.modelId;
          if (sameTarget) {
            return {
              applied: false,
              taskType: inherited,
              reasons: ["availability_hop_reapply_layer_strategy"],
              rule: normalizedRule,
              skipReason: "already_on_target",
            };
          }
          return {
            applied: true,
            taskType: inherited,
            reasons: ["availability_hop_reapply_layer_strategy"],
            rule: normalizedRule,
            newAttempt: {
              providerId: normalizedRule.providerId,
              providerProtocol: normalizedRule.providerProtocol,
              modelId: normalizedRule.modelId,
              promptPolicyId: options.route.promptPolicyId || null,
              isFallback: options.currentAttempt.isFallback,
              fallbackReason: options.currentAttempt.fallbackReason || "",
              targetIndex: options.currentAttempt.targetIndex || 0,
            },
          };
        }
      }
    }
  }

  // Continuation requests: not a real user input → keep the current model when possible.
  if (
    options.isContinuation &&
    !options.currentAttempt.reapplyLayerStrategy
  ) {
    if (options.previousModelId) {
      // We know what model the previous turn used — inherit it
      if (options.previousModelId === options.currentAttempt.modelId) {
        return {
          applied: false,
          taskType: "general" as StrategyTaskType,
          reasons: [
            "continuation_request",
            `Already on ${options.previousModelId}`,
          ],
          rule: null,
          skipReason: "already_on_target",
        };
      }

      // Need to switch to the previous model — validate it's still available
      const rules = parseRules(strategyRoutingRules).filter(
        (r: any) => r.enabled !== false,
      );
      let targetProviderId: string | null = null;
      if (options.previousModelId === options.route.modelId) {
        targetProviderId = options.route.providerId;
      } else {
        const matchedRule = rules.find(
          (r: any) => r.modelId === options.previousModelId,
        );
        if (matchedRule) targetProviderId = matchedRule.providerId;
      }

      if (targetProviderId) {
        const providerRows = await db
          .select()
          .from(providers)
          .where(
            and(
              eq(providers.id, targetProviderId),
              eq(providers.enabled, true),
            ),
          )
          .limit(1);

        if (providerRows.length > 0) {
          const allModels = await db
            .select()
            .from(providerModels)
            .where(eq(providerModels.providerId, targetProviderId));
          const modelRow = allModels.find(
            (m) =>
              m.modelId === options.previousModelId && m.enabled && m.active,
          );

          if (modelRow) {
            const protocol = resolveRouteProviderProtocol({
              incomingProtocol: options.incomingProtocol,
              provider: {
                hasOpenaiEndpoint: !!providerRows[0].openaiBaseUrl,
                hasAnthropicEndpoint: !!providerRows[0].anthropicBaseUrl,
              },
              models: allModels,
              modelId: options.previousModelId!,
            });

            if (protocol.ok) {
              return {
                applied: true,
                taskType: "general" as StrategyTaskType,
                reasons: [
                  "continuation_request",
                  `Inheriting model ${options.previousModelId} from previous turn`,
                ],
                rule: {
                  taskType: "general" as StrategyTaskType,
                  modelId: options.previousModelId!,
                  providerId: targetProviderId,
                  providerProtocol: protocol.providerProtocol,
                  enabled: true,
                },
                newAttempt: {
                  providerId: targetProviderId,
                  providerProtocol: protocol.providerProtocol,
                  modelId: options.previousModelId!,
                  promptPolicyId: options.route.promptPolicyId || null,
                  isFallback: false,
                  fallbackReason: "",
                  targetIndex: options.currentAttempt.targetIndex || 0,
                },
              };
            }
          }
        }
      }
    }

    // Continuation but couldn't find previous model — just keep the current model, don't re-classify
    return {
      applied: false,
      taskType: "general" as StrategyTaskType,
      reasons: [
        "continuation_request",
        "No previous model found, keeping current",
      ],
      rule: null,
      skipReason: "already_on_target",
    };
  }

  // ── Fresh classification ──
  // Strategy mode: real user input (blue bubble) — classify the intent text.
  // OPC agent mode: every turn is classified by agent-loop phase. Tool
  // continuations and mid-task user follow-ups (history already has tool
  // activity) stick to the action column; only a fresh goal lands on thinking.
  const tokenEst = await estimateMultimodalInputUsage({ body: options.body });
  const isVision = tokenEst.imageCount > 0;

  const inputText = extractCurrentUserInputForRouting(options.body);
  const classification = classifyStrategyTask(inputText, isVision);

  let selectedTaskType: RouteTaskType = classification.taskType;
  let reasons: string[] = [...classification.reasons];
  if (isVision) {
    selectedTaskType = "vision";
    reasons = ["required_capability_vision"];
  } else if (selectedTaskType === "long_context") {
    const gated = applyLongContextStrategyTokenGate({
      taskType: "long_context",
      estimatedInputTokens: tokenEst.totalTokens,
      inputText,
    });
    selectedTaskType = gated.taskType;
    reasons = [...reasons, ...gated.reasons];
  }

  const rules = parseRules(strategyRoutingRules);
  const rule = findStrategyRule(rules, selectedTaskType);

  if (!rule) {
    return {
      applied: false,
      taskType: selectedTaskType,
      reasons: reasons,
      rule: null,
      skipReason: "no_matching_rule",
    };
  }

  const validation = await validateOneStrategyRule({
    incomingProtocol: options.incomingProtocol,
    rule,
  });
  if (!validation.ok) {
    return {
      applied: false,
      taskType: selectedTaskType,
      reasons: reasons,
      rule,
      skipReason: validation.error,
    };
  }

  const normalizedRule = validation.rule;
  const sameTarget =
    normalizedRule.providerId === options.currentAttempt.providerId &&
    normalizedRule.providerProtocol ===
      options.currentAttempt.providerProtocol &&
    normalizedRule.modelId === options.currentAttempt.modelId;

  if (sameTarget) {
    return {
      applied: false,
      taskType: selectedTaskType,
      reasons: reasons,
      rule: normalizedRule,
      skipReason: "already_on_target",
    };
  }

  return {
    applied: true,
    taskType: selectedTaskType,
    reasons: reasons,
    rule: normalizedRule,
    newAttempt: {
      providerId: normalizedRule.providerId,
      providerProtocol: normalizedRule.providerProtocol,
      modelId: normalizedRule.modelId,
      promptPolicyId: options.route.promptPolicyId || null,
      isFallback: false,
      fallbackReason: "",
      targetIndex: options.currentAttempt.targetIndex || 0,
    },
  };
}

export async function resolveFallbackStrategyRoutingDecision(options: {
  route: any;
  body: any;
  currentFallbackModelId: string;
  incomingProtocol: string;
  currentStrategyTaskType?: string;
  failedProviderId?: string;
  failedModelId?: string;
}): Promise<StrategyRoutingDecision | null> {
  if (!options.route?.fallbackStrategyRoutingEnabled) {
    return null;
  }

  const routingMode = resolveRouteRoutingMode(options.route);
  const tokenEst = await estimateMultimodalInputUsage({ body: options.body });
  const isVision = tokenEst.imageCount > 0;
  const inputText = extractCurrentUserInputForRouting(options.body);

  let taskType = options.currentStrategyTaskType;
  let reasons: string[] = ["Inherited from current attempt"];

  if (isVision) {
    taskType = "vision";
    reasons = ["required_capability_vision"];
  } else if (!taskType) {
    const classification = classifyStrategyTask(inputText, isVision);
    taskType = classification.taskType;
    reasons = classification.reasons;
  }

  if (taskType === "long_context") {
    const gated = applyLongContextStrategyTokenGate({
      taskType: "long_context",
      estimatedInputTokens: tokenEst.totalTokens,
      inputText,
    });
    if (gated.taskType !== "long_context") {
      taskType = gated.taskType;
      reasons = [...reasons, ...gated.reasons];
    }
  }

  const rules = parseStrategyRoutingRules(
    options.route.fallbackStrategyRoutingRules,
  );
  const rule = findStrategyRule(rules, taskType as RouteTaskType);
  if (!rule) {
    return {
      applied: false,
      taskType: taskType as RouteTaskType,
      reasons,
      rule: null,
      skipReason: "no_matching_rule",
    };
  }

  const validation = await validateOneStrategyRule({
    incomingProtocol: options.incomingProtocol,
    rule,
  });
  if (!validation.ok) {
    return {
      applied: false,
      taskType: taskType as RouteTaskType,
      reasons,
      rule,
      skipReason: validation.error,
    };
  }

  const normalizedRule = validation.rule;
  const sameTarget = normalizedRule.modelId === options.currentFallbackModelId;

  if (sameTarget) {
    return {
      applied: false,
      taskType: taskType as RouteTaskType,
      reasons,
      rule: normalizedRule,
      skipReason: "already_on_target",
    };
  }

  if (
    options.failedProviderId &&
    options.failedModelId &&
    normalizedRule.providerId === options.failedProviderId &&
    normalizedRule.modelId === options.failedModelId
  ) {
    return {
      applied: false,
      taskType: taskType as RouteTaskType,
      reasons: [
        ...reasons,
        `策略规则指向了已失败的提供商/模型 (${options.failedProviderId}/${options.failedModelId})，忽略该规则并使用降级目标默认值`,
      ],
      rule: normalizedRule,
      skipReason: "points_to_failed_target",
    };
  }

  return {
    applied: true,
    taskType: taskType as RouteTaskType,
    reasons,
    rule: normalizedRule,
  };
}

export function getStrategyRuleForLayer(
  route: any,
  targetIndex: number,
  taskType: string,
): any | null {
  if (!route) return null;
  let strategyRoutingRules = route.strategyRoutingRules;
  if (route.targets) {
    try {
      const parsedTargets =
        typeof route.targets === "string"
          ? JSON.parse(route.targets)
          : route.targets;
      if (Array.isArray(parsedTargets) && parsedTargets.length > targetIndex) {
        strategyRoutingRules =
          parsedTargets[targetIndex].strategyRoutingRules ??
          strategyRoutingRules;
      }
    } catch (e) {}
  }
  if (!strategyRoutingRules) return null;
  const rules = parseStrategyRoutingRules(strategyRoutingRules);
  const matched = rules.find(
    (r: any) => r.taskType === taskType && r.enabled !== false,
  );
  return matched || null;
}
