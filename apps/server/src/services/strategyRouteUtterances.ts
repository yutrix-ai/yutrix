/**
 * Aurelio-style short route utterances for strategy task classification.
 * Mined from full chat_logs (user/business-agnostic short phrases) + generic anchors.
 * Used as a signal layer before legacy regex/jieba; does not call external services.
 */
import utterancesJson from "./strategyRouteUtterances.json";

/** Keep local to avoid circular import with strategyRouting.ts */
export type UtteranceTaskType =
  | "vision"
  | "debug"
  | "code"
  | "long_context"
  | "writing"
  | "general";

const TASK_ORDER: UtteranceTaskType[] = [
  "debug",
  "code",
  "writing",
  "vision",
  "long_context",
  // general: exact-only, evaluated separately
];

type UtteranceMap = Record<string, string[]>;

const RAW = utterancesJson as UtteranceMap;

function norm(s: string): string {
  return (s || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Pre-normalized utterances per task for O(n) scan (lists are small). */
export const STRATEGY_ROUTE_UTTERANCES: Record<UtteranceTaskType, string[]> = {
  vision: (RAW.vision || []).map(norm).filter(Boolean),
  debug: (RAW.debug || []).map(norm).filter(Boolean),
  code: (RAW.code || []).map(norm).filter(Boolean),
  long_context: (RAW.long_context || []).map(norm).filter(Boolean),
  writing: (RAW.writing || []).map(norm).filter(Boolean),
  general: (RAW.general || []).map(norm).filter(Boolean),
};

export interface UtteranceMatch {
  taskType: UtteranceTaskType;
  utterance: string;
  score: number;
  reason: string;
}

function isPrimarilyCjk(s: string): boolean {
  const letters = s.replace(/\s+/g, "");
  if (!letters) return false;
  let cjk = 0;
  for (const ch of letters) {
    if (/[\u4e00-\u9fff]/.test(ch)) cjk++;
  }
  return cjk / letters.length >= 0.5;
}

/**
 * Explicit failure / breakage language (EN+ZH). Used so debug wins over non-debug utterances.
 */
export function hasExplicitFailureSignal(normalizedInput: string): boolean {
  const n = norm(normalizedInput);
  if (!n) return false;
  return (
    /\b(error|stack trace|stacktrace|traceback|timeout|timed? out|timing out|failed|failure|crash|panic|repair|exception)\b/.test(n) ||
    /\b(typeerror|referenceerror|syntaxerror|rangeerror|nullpointerexception|systemerror)\b/.test(n) ||
    /\b(not working|doesn't work|does not work|still not working|is not working|aren't working|is broken)\b/.test(n) ||
    /is not defined|undefined|is null|is empty|not found|not registered/.test(n) ||
    /报错|异常|超时|失败|崩溃|修复|排查|不生效|没生效|白屏|错乱|不好使|渲染层错误|不存在|无效/.test(n) ||

    /没展示|没显示|没有显示|没有展示|没改好|没改完|没效果|没作用/.test(n) ||
    /还是不|还是没|不行$|不能用|没有变化|没有出现|为什么没/.test(n) ||
    /怎么没|怎么不|点不了|用不了|不见了/.test(n) ||
    /没带过来|没传过来|不一致|都不对/.test(n) ||
    /逻辑是错|逻辑不对/.test(n) ||
    /滚动条|盖住|溢出|重叠|遮挡|错位/.test(n) ||
    /带不回数据|带不回|没有实现|对不齐/.test(n) ||
    /显示空白|还是空白/.test(n) ||
    /不能(?:编辑|修改|点击|选择|保存|提交|获取|显示|展示)|无法(?:编辑|修改|点击|选择|保存|提交|获取|显示|展示)|点不开|打不开/.test(n) ||
    hasIntentBugToken(n)
  );
}

/**
 * Match normalized user text against route utterances.
 * Prefer longer overlapping phrases. `general` only matches exact.
 *
 * No reverse match (utterance contains user text): short CJK/EN fragments like
 * `还原页面` / `for me` were misrouting when they were 4+ char substrings of anchors.
 * Matching is exact or user-text-contains-full-utterance only.
 */
export function matchStrategyUtterance(normalizedInput: string): UtteranceMatch | null {
  const text = norm(normalizedInput);
  if (!text) return null;

  let best: UtteranceMatch | null = null;

  for (const taskType of TASK_ORDER) {
    const list = STRATEGY_ROUTE_UTTERANCES[taskType] || [];
    for (const utt of list) {
      if (!utt || utt.length < 2) continue;
      let score = 0;
      if (text === utt) {
        score = 1000 + utt.length;
      } else if (text.includes(utt) && utt.length >= 2) {
        // Latin short anchors need word-ish length; CJK bigrams allowed (e.g. 修复).
        if (utt.length === 2 && !/[\u4e00-\u9fff]{2}/.test(utt)) continue;
        if (!isPrimarilyCjk(utt) && utt.length < 4) continue;
        if (taskType === "long_context" && utt.length < 6) continue;
        // Prefer multi-word EN contains (single short EN token is too greedy)
        if (!isPrimarilyCjk(utt) && !/\s/.test(utt) && utt.length < 12) {
          if (!/^[a-z0-9.+_-]{8,}$/i.test(utt)) continue;
        }
        score = 100 + utt.length;
      } else {
        continue;
      }
      if (!best || score > best.score) {
        best = {
          taskType,
          utterance: utt,
          score,
          reason: `utterance_${taskType}`,
        };
      }
    }
  }

  // general: exact match only
  for (const utt of STRATEGY_ROUTE_UTTERANCES.general || []) {
    if (text === utt) {
      const score = 1000 + utt.length;
      if (!best || score > best.score) {
        best = {
          taskType: "general",
          utterance: utt,
          score,
          reason: "utterance_general",
        };
      }
    }
  }

  if (!best) return null;
  if (best.score < 50) return null;
  return best;
}

/** Ticket ids like BUG-123 / bug-42 — real work items, not product brands. */
export function hasBugTicketToken(normalizedInput: string): boolean {
  return /\bbug[-_ ]?\d+\b/i.test(norm(normalizedInput));
}

/**
 * Product/tool names like "bug-analyzer" or "Bug Analyzer" without failure language.
 * Does not treat numeric tickets (BUG-123) as products.
 */
export function isProductStyleBugMention(normalizedInput: string): boolean {
  const n = norm(normalizedInput);
  if (!n) return false;

  // Real breakage always wins over product branding
  if (
    /(报错|异常|崩溃|超时|失败|排查|修复|不生效|没生效|白屏|error|exception|crash|failed|failure|timeout|stack\s*trace|traceback|panic|throws|nullpointer)/.test(
      n,
    ) ||
    /\b(not working|doesn't work|does not work|still not working|is not working|aren't working|is broken)\b/.test(n)
  ) {
    return false;
  }

  // Tickets are not product names
  if (hasBugTicketToken(n)) return false;

  // Hyphen product ids with letters (bug-analyzer), not digits (bug-42)
  const productToken =
    /\bbug[-_][a-z][a-z0-9]*\b|\b[a-z][a-z0-9]*[-_]bug\b|\bbug(?:analyzer|locator|snag|tracker|bot|finder)\b|\bbug\s+(?:analyzer|locator|snag|tracker|bot|finder)\b/.test(
      n,
    );
  // CJK product slogan glued after bug: bug定位分析 / bug助手
  const cjkBrand = /\bbug(?=定位|分析|助手|工具|系统)/.test(n);
  // Marketing-style description (ZH + EN)
  const marketing =
    /(帮助快速|问题根源|定位分析|快速找到|root cause|helps you|tool for|for finding|problem locator)/.test(
      n,
    );

  if (productToken || cjkBrand || (marketing && (productToken || cjkBrand || /\bbug[a-z]{4,}\b/.test(n)))) {
    const stripped = n
      .replace(/\bbug[-_][a-z][a-z0-9]*\b/g, " ")
      .replace(/\b[a-z][a-z0-9]*[-_]bug\b/g, " ")
      .replace(/\bbug(?:analyzer|locator|snag|tracker|bot|finder)\b/g, " ")
      .replace(/\bbug\s+(?:analyzer|locator|snag|tracker|bot|finder)\b/g, " ")
      .replace(/\bbug(?=定位|分析|助手|工具|系统)/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!/\bbug\b/.test(stripped)) {
      return true;
    }
  }
  return false;
}

/**
 * Whether normalized text has a debug-relevant "bug" token (tickets count; product brands without failure do not).
 */
export function hasIntentBugToken(normalizedInput: string): boolean {
  const n = norm(normalizedInput);
  if (hasBugTicketToken(n)) return true;
  if (isProductStyleBugMention(n)) return false;
  const stripped = n
    .replace(/\bbug[-_][a-z][a-z0-9]*\b/g, " ")
    .replace(/\b[a-z][a-z0-9]*[-_]bug\b/g, " ")
    .replace(/\bbug(?:analyzer|locator|snag|tracker|bot|finder)\b/g, " ")
    .replace(/\bbug\s+(?:analyzer|locator|snag|tracker|bot|finder)\b/g, " ")
    .replace(/\bbug(?=定位|分析|助手|工具|系统)/g, " ");
  return /\bbug\b/.test(stripped);
}

/** Controlled long-log / audit analyze intents (not add-logging instrumentation). */
export function hasLongContextLogAnalyzeSignal(normalizedInput: string): boolean {
  const n = norm(normalizedInput);
  if (!n) return false;
  // Bare instrumentation: add/print logging — not long_context
  if (
    /(?:add|增加|添加|加点).{0,12}(?:log(?:ging)?|日志|console\.log)/.test(n) ||
    /(?:console\.log|print(?:ln)?\s*\()/.test(n)
  ) {
    // still allow true analyze phrasing that also mentions adding? prefer not long_context
    if (!(/(?:analyze|read|summarize|inspect|review|分析|查看|阅读|梳理|总结|看一下).{0,16}(?:\blog\b|logs\b|日志|审计)/.test(n))) {
      return false;
    }
  }
  return (
    /\b(audit|transcript|migration)\b|审计|长文本|长日志/.test(n) ||
    /(?:analyze|read|summarize|inspect|review|分析|查看|阅读|梳理|总结|看一下).{0,20}(?:\blog\b|logs\b|日志|审计|长文本|transcript)/.test(n) ||
    /(?:\blog\b|logs\b|日志|审计).{0,16}(?:analyze|read|summarize|inspect|review|分析|查看|阅读|梳理|总结|线索)/.test(n) ||
    /数据库迁移|迁移脚本|migration\s+script/.test(n)
  );
}
