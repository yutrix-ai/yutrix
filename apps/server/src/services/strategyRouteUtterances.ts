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
 * Match normalized user text against route utterances.
 * Prefer longer overlapping phrases. `general` only matches exact (avoids swallowing content).
 *
 * Reverse match (utterance contains user text) is **CJK-only**: English reverse-includes
 * misroute bare tokens like "for me" / "the page" / "an error" into writing/debug.
 * EN relies on exact match or user-text-contains-utterance (full phrase span).
 */
export function matchStrategyUtterance(normalizedInput: string): UtteranceMatch | null {
  const text = norm(normalizedInput);
  if (!text) return null;

  let best: UtteranceMatch | null = null;
  const allowReverse = isPrimarilyCjk(text);

  for (const taskType of TASK_ORDER) {
    const list = STRATEGY_ROUTE_UTTERANCES[taskType] || [];
    for (const utt of list) {
      if (!utt || utt.length < 2) continue;
      let score = 0;
      if (text === utt) {
        score = 1000 + utt.length;
      } else if (text.includes(utt) && utt.length >= 2) {
        // Latin short anchors need word-ish length to avoid "ok"/"api" noise;
        // CJK bigrams remain allowed (e.g. 修复).
        if (utt.length === 2 && !/[\u4e00-\u9fff]{2}/.test(utt)) continue;
        if (!isPrimarilyCjk(utt) && utt.length < 4) continue;
        // long_context: only allow contains-match for longer analyze/read anchors
        if (taskType === "long_context" && utt.length < 6) continue;
        // Prefer multi-word EN contains (single EN token is too greedy)
        if (!isPrimarilyCjk(utt) && !/\s/.test(utt) && utt.length < 12) {
          // allow solid multi-char tokens like "NullPointerException"
          if (!/^[a-z0-9.+_-]{8,}$/i.test(utt)) continue;
        }
        score = 100 + utt.length;
      } else if (
        allowReverse &&
        utt.includes(text) &&
        text.length >= 4 &&
        text.length <= 40
      ) {
        // CJK reverse only — EN reverse disabled (see function doc)
        if (taskType === "long_context" && text.length < 6) continue;
        score = 50 + text.length;
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

/**
 * Product/tool names like "bug-analyzer" or "bug定位分析" should not alone trigger debug via \bbug\b.
 * Returns true when the only bug tokens look like branding without failure language.
 */
export function isProductStyleBugMention(normalizedInput: string): boolean {
  const n = norm(normalizedInput);
  if (!n) return false;

  const hasFailureLanguage =
    /(报错|异常|崩溃|超时|失败|排查|修复|不生效|没生效|白屏|error|exception|crash|failed|failure|timeout|stack\s*trace|traceback|panic|throws|nullpointer)/.test(
      n,
    );

  if (hasFailureLanguage) return false;

  // Hyphen/underscore product ids: bug-analyzer, my-bug-bot; compound brands: buglocator
  const productToken =
    /\bbug[-_][a-z0-9]{2,}\b|\b[a-z0-9]{2,}[-_]bug\b|\bbug(?:analyzer|locator|snag|tracker|bot|finder)\b/.test(
      n,
    );
  // CJK product slogan glued after bug: bug定位分析 / bug助手
  const cjkBrand = /\bbug(?=定位|分析|助手|工具|系统)/.test(n);
  // Marketing-style description (ZH + EN) without a concrete failure
  const marketing =
    /(帮助快速|问题根源|定位分析|快速找到|root cause|helps you|tool for|for finding|problem locator)/.test(
      n,
    );

  if (productToken || cjkBrand || (marketing && (productToken || cjkBrand || /\bbug[a-z]{4,}\b/.test(n)))) {
    // After stripping product-style bug tokens, is there still a standalone bug intent?
    const stripped = n
      .replace(/\bbug[-_][a-z0-9]+\b/g, " ")
      .replace(/\b[a-z0-9]+[-_]bug\b/g, " ")
      .replace(/\bbug(?:analyzer|locator|snag|tracker|bot|finder)\b/g, " ")
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
 * Whether normalized text still has a debug-relevant "bug" token after product-name stripping.
 */
export function hasIntentBugToken(normalizedInput: string): boolean {
  const n = norm(normalizedInput);
  if (isProductStyleBugMention(n)) return false;
  const stripped = n
    .replace(/\bbug[-_][a-z0-9]+\b/g, " ")
    .replace(/\b[a-z0-9]+[-_]bug\b/g, " ")
    .replace(/\bbug(?:analyzer|locator|snag|tracker|bot|finder)\b/g, " ")
    .replace(/\bbug(?=定位|分析|助手|工具|系统)/g, " ");
  return /\bbug\b/.test(stripped);
}
