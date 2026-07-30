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

/** Known product/tool brands — not arbitrary bug-* hyphens. */
const KNOWN_BUG_BRAND =
  /\bbug[-_]?(?:analyzer|locator|snag|tracker|bot|finder)\b|\bbug\s+(?:analyzer|locator|snag|tracker|bot|finder)\b/;

/** Live breakage (not design-spec themes like timeout handling / bug fix notes). */
export function hasLiveBreakageSignal(normalizedInput: string): boolean {
  const n = norm(normalizedInput);
  if (!n) return false;

  // Exception classes (IOException, CustomException) — baseline exception\b semantics
  if (/\b[a-z][a-z0-9_]*exception\b/.test(n) || /\bexception\b/.test(n)) return true;

  // Explicit runtime / ops breakage
  if (
    /\b(stack\s*trace|stacktrace|traceback|panic|crashed|crashing|throws?)\b/.test(n) ||
    /\b(typeerror|referenceerror|syntaxerror|rangeerror|nullpointerexception|systemerror)\b/.test(n) ||
    /\b(not working|doesn't work|does not work|still not working|is not working|aren't working|is broken|stopped working|won't start|will not start)\b/.test(n) ||
    // Do NOT match bare "timeout" (design: timeout handling)
    /\b(keeps? timing out|timing out|timed out)\b/.test(n) ||
    /\breturns?\s*(?:a\s+)?(?:5\d\d|500|502|503|504)\b|\bhttp\s*5\d\d\b/.test(n) ||
    /\b(failed to|failure to|build failed|execution failed|applicationcontext failed)\b/.test(n) ||
    /\bcode["\s:=]+404\b|\b"code"\s*:\s*404\b/.test(n)
  ) {
    return true;
  }

  // ZH live breakage
  if (
    /报错|崩溃|排查|不生效|没生效|白屏|错乱|不好使|渲染层错误/.test(n) ||
    /没展示|没显示|没有显示|没有展示|没改好|没改完|没效果|没作用/.test(n) ||
    /还是不|还是没|不行$|不能用|没有变化|没有出现|为什么没/.test(n) ||
    /怎么没|怎么不|点不了|用不了|不见了/.test(n) ||
    /没带过来|没传过来|不一致|都不对|逻辑是错|逻辑不对/.test(n) ||
    /显示空白|还是空白|点不开|打不开/.test(n) ||
    /不能(?:编辑|修改|点击|选择|保存|提交|获取|显示|展示)|无法(?:编辑|修改|点击|选择|保存|提交|获取|显示|展示)/.test(n) ||
    // Existence errors in messages (JSON/API), not "when not found" design specs
    (/(不存在|无效)/.test(n) && !/当.+不存在|若不存在|is not found/.test(n))
  ) {
    return true;
  }

  // UI layout failures (including path + 溢出 style production reports)
  if (/滚动条|盖住|溢出|重叠|遮挡|错位/.test(n)) {
    return true;
  }

  return false;
}

/** Design / feature-spec prose that mentions failure themes without live breakage. */
export function isDesignSpecFailureTheme(normalizedInput: string): boolean {
  const n = norm(normalizedInput);
  if (!n) return false;
  if (hasLiveBreakageSignal(n)) return false;
  return (
    /\bwith timeout handling\b|\btimeout handling\b|\berror handling\b|\bbug\s*fix\b|\bfix notes\b|\brelease notes\b/.test(n) ||
    /\breturn\s+\d{3}\s+when\b|\bwhen the .+ is not found\b|\bif .+ not found\b/.test(n) ||
    /超时处理|错误处理|异常处理|失败重试|返回\s*\d{3}|当.+不存在|若不存在/.test(n) ||
    /\bimplement\b.+\b(timeout|error|failure)\b.+\b(handling|support|retry)\b/.test(n) ||
    /实现.+(超时|错误|失败).*(处理|支持|重试)/.test(n)
  );
}

/**
 * Explicit failure / breakage language (EN+ZH). Used so debug wins over non-debug utterances.
 * Softened: design-spec themes alone are not enough.
 */
export function hasExplicitFailureSignal(normalizedInput: string): boolean {
  const n = norm(normalizedInput);
  if (!n) return false;
  if (isDesignSpecFailureTheme(n)) return false;
  if (hasLiveBreakageSignal(n)) return true;

  // Strong ZH failure nouns that almost always mean live issues when not design-spec
  if (/报错|异常|崩溃|失败|无效/.test(n) && !/异常处理|失败重试|失败主题/.test(n)) {
    // Avoid pure "失败" in "失败主题" already excluded; bare 失败 in short reports
    if (/报错|崩溃|异常堆栈|请求失败|上传失败|编译失败|连接失败/.test(n) || /失败了|失败了|失败：|失败:/.test(n)) {
      return true;
    }
  }

  // Real bug work tokens (tickets, fix security-bug, etc.) — not marketing brands
  if (hasIntentBugToken(n)) return true;

  return false;
}

/**
 * Match normalized user text against route utterances.
 * Prefer longer overlapping phrases. `general` only matches exact.
 * No reverse match (utterance contains user text).
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
        if (utt.length === 2 && !/[\u4e00-\u9fff]{2}/.test(utt)) continue;
        if (!isPrimarilyCjk(utt) && utt.length < 4) continue;
        if (taskType === "long_context" && utt.length < 6) continue;
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
 * Product/tool marketing intros only (known brands + marketing context).
 * Does not treat arbitrary hyphenated bug-* work items as products.
 */
export function isProductStyleBugMention(normalizedInput: string): boolean {
  const n = norm(normalizedInput);
  if (!n) return false;

  // Live breakage / fix-investigate always wins
  if (hasLiveBreakageSignal(n)) return false;
  if (/\b(fix|investigate|resolve|repair|debug)\b/.test(n) && (KNOWN_BUG_BRAND.test(n) || /\bbug\b/.test(n))) {
    return false;
  }
  if (hasBugTicketToken(n)) return false;

  const knownBrand = KNOWN_BUG_BRAND.test(n) || /\bbug(?=定位|分析|助手|工具|系统)/.test(n);
  const marketing =
    /(帮助快速|问题根源|定位分析|快速找到|root cause|helps you|tool for|for finding|problem locator|is a tool|工具介绍|定位工具)/.test(
      n,
    );

  // Known brand + marketing intro only (not arbitrary bug-* hyphens)
  if (knownBrand && marketing) return true;
  return false;
}

/**
 * Whether normalized text has a debug-relevant bug token.
 * Tickets and hyphenated bug-work count; marketing-only known brands do not.
 */
export function hasIntentBugToken(normalizedInput: string): boolean {
  const n = norm(normalizedInput);
  if (hasBugTicketToken(n)) return true;

  // Explicit debug work on any bug-* / *-bug token
  if (
    /\b(fix|investigate|resolve|repair|debug)\b.{0,24}\bbug\b|\bbug\b.{0,24}\b(fix|investigate|resolve|repair)\b/.test(
      n,
    )
  ) {
    return true;
  }
  if (/\b(?:security|critical|production|urgent)[-_]?bug\b|\bbug[-_]?(?:report|fix|hunt)\b/.test(n)) {
    return true;
  }

  if (isProductStyleBugMention(n)) return false;

  // Strip only known product brands, then look for remaining standalone bug
  const stripped = n
    .replace(KNOWN_BUG_BRAND, " ")
    .replace(/\bbug(?=定位|分析|助手|工具|系统)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return /\bbug\b/.test(stripped);
}

/**
 * Controlled long-log / audit analyze intents.
 * - Full word bounds on log/logs (not catalogs/backlogs/dialogs)
 * - Hard-exclude add/enable logging instrumentation
 */
export function hasLongContextLogAnalyzeSignal(normalizedInput: string): boolean {
  const n = norm(normalizedInput);
  if (!n) return false;

  // Instrumentation / enable logging — never long_context
  if (
    /\b(add|enable|print|write|inject)\b.{0,24}\b(?:log(?:ging)?|logs)\b/.test(n) ||
    /\b(?:log(?:ging)?|logs)\b.{0,16}\b(add|enable|print)\b/.test(n) ||
    /(?:增加|添加|加点|开启|启用|写入).{0,12}(?:日志|logging)/.test(n) ||
    /console\.log|print(?:ln)?\s*\(/.test(n) ||
    /\breview and add\b.{0,12}\blogs?\b/.test(n)
  ) {
    return false;
  }

  // Analyze/read verbs with true log/logs word bounds (both sides — avoid catalogs/backlogs)
  const logWord = String.raw`(?:\blog\b|\blogs\b|日志|审计日志|长日志|长文本|\baudit(?:\s+log|\s*记录)?\b|\btranscript\b)`;
  const analyzeVerb =
    String.raw`(?:analyze|read|summarize|inspect|review|解析|分析|查看|阅读|梳理|总结|看一下|看下|定位)`;

  if (new RegExp(`${analyzeVerb}.{0,24}${logWord}`).test(n)) return true;
  if (new RegExp(`${logWord}.{0,16}(?:${analyzeVerb}|线索|问题)`).test(n)) return true;
  if (/\b(audit\s+log|transcript|migration)\b|审计日志|长文本|长日志|迁移脚本|数据库迁移/.test(n)) {
    return true;
  }
  if (/数据库迁移|迁移脚本|migration\s+script/.test(n)) return true;
  // "分析一下这份 audit 记录" — analyze + audit without requiring "log"
  if (new RegExp(`${analyzeVerb}.{0,20}\\baudit\\b`).test(n)) return true;

  // Tech logs: analyze nginx/docker/git/api logs
  if (
    new RegExp(
      `${analyzeVerb}.{0,20}\\b(?:nginx|docker|git|api|server|application|access|error)\\b.{0,12}${logWord}`,
    ).test(n) ||
    new RegExp(
      `\\b(?:nginx|docker|git|api|server|application|access|error)\\b.{0,8}${logWord}`,
    ).test(n) &&
      new RegExp(analyzeVerb).test(n)
  ) {
    return true;
  }

  return false;
}

/** Pure agentic protocol dumps (for skipAgentic so broad code signals don't fire). */
export function isAgenticProtocolPayload(text: string, truncatedRaw: string): boolean {
  const n = norm(text + " " + (truncatedRaw || "").slice(0, 2000));
  return (
    /tool_result|tool_use|role["\s]*:["\s]*tool|system-reminder|system_reminder|qqrrrrqqquuuuqqq|vvxxxxvvvddddvvv/.test(
      n,
    ) ||
    /\[\{"role":"tool"/.test(truncatedRaw || "") ||
    /"type"\s*:\s*"tool_result"/.test(truncatedRaw || "") ||
    /<path>.*<\/path>/.test(n)
  );
}
