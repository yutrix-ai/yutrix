/**
 * Structured bug-intent analysis for strategy routing.
 *
 * Known product names are masked before inspecting standalone bug words, so a
 * brand such as "Bug Analyzer" cannot accidentally become a debug signal. Bug
 * actions and assertions are paired within clauses instead of by character
 * distance.
 */

import {
  EN_DIAGNOSTIC_ACTION_SOURCE,
  EN_META_WRITING_ACTION_SOURCE,
  EN_WRITING_ACTION_SOURCE,
  EN_WRITING_ARTIFACT_SOURCE,
} from "./strategyRouteTextSignals";

export interface BugTextSpan {
  start: number;
  end: number;
  text: string;
}

export type BugIntentReason =
  | "live_failure"
  | "actionable_bug"
  | "bug_assertion"
  | "bug_ticket"
  | "writing_about_bug"
  | "product_only"
  | "bug_topic"
  | "none";

export interface BugClauseAnalysis {
  text: string;
  hasBrand: boolean;
  hasTicket: boolean;
  hasBugWord: boolean;
  hasWritingFrame: boolean;
  hasContentMaintenance: boolean;
  hasNegatedBugAction: boolean;
  hasResolvedBug: boolean;
  hasLiveFailure: boolean;
  hasActionableBug: boolean;
  hasBugAssertion: boolean;
  hasSeverityBug: boolean;
}

export interface BugIntentAnalysis {
  normalizedText: string;
  brandMaskedText: string;
  hasBrand: boolean;
  hasTicket: boolean;
  isDebug: boolean;
  isProductOnly: boolean;
  reason: BugIntentReason;
  brandSpans: BugTextSpan[];
  ticketSpans: BugTextSpan[];
  clauses: BugClauseAnalysis[];
}

interface InternalSpan extends BugTextSpan {
  kind: "brand" | "ticket";
}

const ENGLISH_BUG_BRAND_RE =
  /\bbug(?:[-_]?(?:analyzer|locator|snag|tracker|bot|finder)|\s+(?:analyzer|locator|snag|tracker|bot|finder))\b/gi;
const CHINESE_BUG_BRAND_RE =
  /\bbug(?:定位分析|定位|分析)(?:助手|工具|系统)?|\bbug(?:助手|工具|系统)/gi;

// Delimiters are mandatory and the prefix is singular. This accepts BUG-123,
// BUG #123, BUG:123 and BUG/123 without treating "Bugs 101" as a ticket.
const BUG_TICKET_RE = /\bbug(?:\s*#\s*|\s*[-_:/\u2013\u2014]\s*)\d{1,10}\b/gi;

const WRITING_FRAME_RE = new RegExp(
  `\\b${EN_META_WRITING_ACTION_SOURCE}\\b|\\b${EN_WRITING_ACTION_SOURCE}\\b.{0,64}\\b${EN_WRITING_ARTIFACT_SOURCE}\\b|写作|撰写|起草|编写|更新|改写|重写|编辑|润色|翻译|总结|描述|说明|文档|文章|传记|报告|发布说明|更新说明`,
  "iu",
);

const ACTIVE_BUG_ACTION_RE = new RegExp(
  `\\b(?:${EN_DIAGNOSTIC_ACTION_SOURCE}|close|reopen)\\b|修复|排查|解决|调查|复现|处理`,
  "iu",
);

const PENDING_BUG_ACTION_RE =
  /\bbugs?\b.*\b(?:need(?:s)?|require(?:s)?|must|should|remain(?:s)?)\b.*\b(?:fix(?:ed|ing)|investigated|resolved|repaired|addressed)\b|\bbugs?\b.*\bare being\b.*\b(?:fixed|investigated|resolved|repaired)\b/iu;

const BUG_ASSERTION_RE =
  /\bthere\s+(?:is|are|was|were)\b|\b(?:has|have|had|contains?|contained|includes?|included|found|discovered|encountered|reports?|reported|shows?|showed)\b|\bfull\s+of\b|\briddled\s+with\b/iu;

const LIVE_FAILURE_RE =
  /\b(?:fails?|failed|failing|crash(?:es)?|crashed|crashing|panics?|panicked|timed out|times? out)\b|\b(?:is|are|was|were|keeps?|still)\s+(?:failing|broken|crashing|timing out)\b|\b(?:does not|doesn't|do not|don't)\s+work\b|\b(?:returns?|returned)\s+(?:a\s+)?5\d\d\b|\bhttp\s+5\d\d\b|\b(?:error|exception)\s+occurred\b|\b(?:reports|reported|shows|showed|has|have|had|encounters|encountered)\b.*\b(?:an?\s+)?(?:error|exception)s?\b|报错|崩溃|仍然失败|还是失败|失败了|不工作|不能用|不好使/iu;

const FEATURE_BEHAVIOR_RE =
  /\b(?:configure|implement|make|allow|set up|add)\b.*\bto\s+(?:report|show|return|fail)\b/iu;
const NEGATED_BUG_RE =
  /\b(?:no|zero)\s+(?:(?:known|remaining|ui|regression|critical|production|open)\s+){0,2}bugs?\b|\bwithout\s+(?:any\s+)?bugs?\b/iu;
const NEGATED_FAILURE_RE =
  /\b(?:reports?|shows?|has|have|had|found)\s+no\s+(?:errors?|exceptions?)\b|\bnever\s+(?:fails?|failed|failing|crashes?|crashed|times?\s+out)\b|\bno\s+longer\s+(?:fails?|failed|failing|crashes?|crashed|times?\s+out)\b|\b(?:does not|doesn't|did not|didn't|has not|hasn't|have not|haven't|is not|isn't)\s+(?:fail|failed|failing|broken|crash|crashed|crashing|time|timed|timing)\b/iu;

const BUG_SEVERITY_RE =
  /\b(?:production|critical|security|urgent|blocking|regression)\b|生产|线上|严重|紧急|阻断/iu;

function normalize(input: string): string {
  return (input || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function collectSpans(
  input: string,
  expression: RegExp,
  kind: InternalSpan["kind"],
): InternalSpan[] {
  const spans: InternalSpan[] = [];
  expression.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = expression.exec(input)) !== null) {
    spans.push({
      start: match.index,
      end: match.index + match[0].length,
      text: match[0],
      kind,
    });
    if (match[0].length === 0) expression.lastIndex++;
  }
  expression.lastIndex = 0;
  return spans;
}

function mergeNonOverlappingSpans(spans: InternalSpan[]): InternalSpan[] {
  const ordered = [...spans].sort(
    (a, b) => a.start - b.start || b.end - b.start - (a.end - a.start),
  );
  const result: InternalSpan[] = [];
  for (const span of ordered) {
    const previous = result[result.length - 1];
    if (!previous || span.start >= previous.end) {
      result.push(span);
    }
  }
  return result;
}

function replaceSpans(
  input: string,
  spans: InternalSpan[],
  replacement: (span: InternalSpan) => string,
): string {
  let cursor = 0;
  let output = "";
  for (const span of spans) {
    output += input.slice(cursor, span.start);
    output += replacement(span);
    cursor = span.end;
  }
  output += input.slice(cursor);
  return output.replace(/\s+/g, " ").trim();
}

function findBrandSpans(input: string): InternalSpan[] {
  return mergeNonOverlappingSpans([
    ...collectSpans(input, ENGLISH_BUG_BRAND_RE, "brand"),
    ...collectSpans(input, CHINESE_BUG_BRAND_RE, "brand"),
  ]);
}

function findTicketSpans(input: string): InternalSpan[] {
  return collectSpans(input, BUG_TICKET_RE, "ticket");
}

function splitClauses(input: string): string[] {
  const coordinatedDebugTask = new RegExp(
    `\\b(?:and\\s+then|and|then|also|next|while|before|after)\\s+(?=(?:please\\s+)?${EN_DIAGNOSTIC_ACTION_SOURCE}\\b)`,
    "giu",
  );
  return input
    .replace(coordinatedDebugTask, "; ")
    .split(
      /[,.!?;，。！？；]+|\b(?:but|however|yet|whereas|although)\b|(?:但是|但|然而|不过|却|以及|并且|而且)/iu,
    )
    .map((clause) => clause.trim())
    .filter(Boolean);
}

function hasContentMaintenanceTarget(text: string): boolean {
  const target = /\b(?:brandtoken|tickettoken)\b/iu.exec(text);
  if (!target) return false;

  const actionPrefix =
    /^\s*(?:(?:please|can\s+you|could\s+you|would\s+you|will\s+you|help\s+me)\s+)?(?:fix|repair|update|polish|rewrite)\b/iu;
  if (!actionPrefix.test(text)) return false;

  const artifact =
    /\b(?:docs?|readmes?|documentation|copy|titles?|articles?|guides?|release\s+notes?|changelogs?|descriptions?|summar(?:y|ies)|overviews?|memos?|notes?)\b/iu;
  const beforeTarget = text.slice(0, target.index);
  const afterTarget = text.slice(target.index + target[0].length);
  return (
    artifact.test(beforeTarget) ||
    /^\s*(?:'s\s+)?(?:docs?|readmes?|documentation|copy|titles?|articles?|guides?|release\s+notes?|changelogs?|descriptions?|summar(?:y|ies)|overviews?|memos?|notes?)\b/iu.test(
      afterTarget,
    )
  );
}

function analyzeClause(text: string): BugClauseAnalysis {
  const hasBrand = /\bbrandtoken\b/.test(text);
  const hasTicket = /\btickettoken\b/.test(text);
  const residualBugText = text.replace(
    new RegExp(NEGATED_BUG_RE.source, "giu"),
    " ",
  );
  const hasBugWord =
    /\bbugs?\b/iu.test(residualBugText) &&
    !/\bbugs?\s+bunny\b/iu.test(residualBugText);
  const hasWritingFrame = WRITING_FRAME_RE.test(text);
  const hasLiveFailure =
    LIVE_FAILURE_RE.test(text) &&
    !FEATURE_BEHAVIOR_RE.test(text) &&
    !NEGATED_FAILURE_RE.test(text);

  // "bug fix" in release-note prose is a noun, not an imperative action.
  const actionText = text.replace(/\bbugs?\s+fix(?:es)?\b/giu, " bugtopic ");
  const bugTargetSource = String.raw`(?:brandtoken|tickettoken|bugs?)`;
  const hasNegatedBugAction =
    new RegExp(
      `(?:\\b(?:do\\s+not|don't|never|without)\\b.{0,32}|\\bnot\\s+asking\\b.{0,40}\\bto\\s+)${EN_DIAGNOSTIC_ACTION_SOURCE}\\b.{0,64}\\b${bugTargetSource}\\b`,
      "iu",
    ).test(actionText) ||
    new RegExp(
      `(?:不要|别|无需|不需要|不用|禁止).{0,24}(?:修复|排查|解决|调查|复现|处理).{0,48}${bugTargetSource}|${bugTargetSource}.{0,32}(?:不需要|无需|不用).{0,16}(?:修复|排查|解决|调查|复现|处理)`,
      "iu",
    ).test(actionText);
  const hasResolvedBug =
    new RegExp(
      `\\b${bugTargetSource}\\b\\s+(?:(?:has|have|had)\\s+been|(?:is|are|was|were))\\s+(?:resolved|fixed|repaired|closed)\\b`,
      "iu",
    ).test(actionText) ||
    new RegExp(
      `${bugTargetSource}.{0,16}(?:已|已经)(?:修复|解决|关闭|处理完)`,
      "iu",
    ).test(actionText);
  const hasDebugAction =
    !hasNegatedBugAction &&
    !hasResolvedBug &&
    (ACTIVE_BUG_ACTION_RE.test(actionText) ||
      PENDING_BUG_ACTION_RE.test(actionText));
  const hasAnyBugTarget = hasBrand || hasTicket || hasBugWord;
  const isBrandContentMaintenance =
    hasBrand &&
    !hasTicket &&
    !hasBugWord &&
    hasContentMaintenanceTarget(text);
  const isTicketContentMaintenance =
    hasTicket && hasContentMaintenanceTarget(text);
  const hasContentMaintenance =
    isBrandContentMaintenance || isTicketContentMaintenance;
  const writingScopesBugAction =
    hasWritingFrame &&
    (new RegExp(
      `\\b${EN_META_WRITING_ACTION_SOURCE}\\b.{0,96}\\b${bugTargetSource}\\b`,
      "iu",
    ).test(text) ||
      new RegExp(
        `\\b${EN_WRITING_ACTION_SOURCE}\\b.{0,64}\\b${EN_WRITING_ARTIFACT_SOURCE}\\b.{0,96}\\b${bugTargetSource}\\b`,
        "iu",
      ).test(text) ||
      new RegExp(
        `\\b${EN_WRITING_ACTION_SOURCE}\\b.{0,64}\\b${bugTargetSource}\\b.{0,64}\\b${EN_WRITING_ARTIFACT_SOURCE}\\b`,
        "iu",
      ).test(text) ||
      /(?:撰写|起草|总结|记录|编写|写|更新|编辑|改写|重写|润色|翻译|说明|描述).{0,48}(?:brandtoken|tickettoken|bugs?).{0,48}(?:报告|文档|描述|说明|总结|记录|文章|发布说明|更新说明|修复情况)/iu.test(
        text,
      ) ||
      /(?:撰写|起草|总结|记录|编写|写|更新|编辑|改写|重写|润色|翻译).{0,32}(?:报告|文档|文章|说明|总结|记录).{0,16}(?:关于|说明|描述|总结|记录|介绍).{0,48}(?:brandtoken|tickettoken|bugs?)/iu.test(
        text,
      ));
  const hasActionableBug =
    hasDebugAction &&
    hasAnyBugTarget &&
    !isBrandContentMaintenance &&
    !isTicketContentMaintenance &&
    !writingScopesBugAction;

  // Writing frames suppress bug topics/assertions, but not an explicit live
  // failure or an actionable fix/investigation request.
  const hasBugAssertion =
    hasBugWord && BUG_ASSERTION_RE.test(text) && !hasWritingFrame;
  const hasSeverityBug =
    hasBugWord && BUG_SEVERITY_RE.test(text) && !hasWritingFrame;

  return {
    text,
    hasBrand,
    hasTicket,
    hasBugWord,
    hasWritingFrame,
    hasContentMaintenance,
    hasNegatedBugAction,
    hasResolvedBug,
    hasLiveFailure,
    hasActionableBug,
    hasBugAssertion,
    hasSeverityBug,
  };
}

export function analyzeBugIntent(input: string): BugIntentAnalysis {
  const normalizedText = normalize(input);
  const brandSpansInternal = findBrandSpans(normalizedText);
  const ticketSpansInternal = findTicketSpans(normalizedText);
  const allSpans = mergeNonOverlappingSpans([
    ...brandSpansInternal,
    ...ticketSpansInternal,
  ]);

  const brandMaskedText = replaceSpans(
    normalizedText,
    brandSpansInternal,
    () => " ",
  )
    .replace(new RegExp(NEGATED_BUG_RE.source, "giu"), " ")
    .replace(/\bbugs?\s+bunny\b/giu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const semanticText = replaceSpans(normalizedText, allSpans, (span) =>
    span.kind === "brand" ? " brandtoken " : " tickettoken ",
  );
  const clauses = splitClauses(semanticText).map(analyzeClause);

  const hasBrand = brandSpansInternal.length > 0;
  const hasTicket = ticketSpansInternal.length > 0;
  const hasLiveFailure = clauses.some(
    (clause) =>
      clause.hasLiveFailure &&
      (clause.hasBrand || clause.hasTicket || clause.hasBugWord),
  );
  const hasActionableBug = clauses.some((clause) => clause.hasActionableBug);
  const hasBugAssertion = clauses.some(
    (clause) => clause.hasBugAssertion || clause.hasSeverityBug,
  );
  const hasUnsuppressedTicket = clauses.some(
    (clause) =>
      clause.hasTicket &&
      !clause.hasWritingFrame &&
      !clause.hasContentMaintenance &&
      !clause.hasNegatedBugAction &&
      !clause.hasResolvedBug &&
      !clause.hasLiveFailure &&
      !clause.hasActionableBug,
  );
  const hasWritingTopic = clauses.some(
    (clause) =>
      clause.hasWritingFrame &&
      (clause.hasBrand || clause.hasTicket || clause.hasBugWord),
  );
  const hasResidualBugWord = clauses.some((clause) => clause.hasBugWord);

  let isDebug = false;
  let reason: BugIntentReason = "none";
  if (hasLiveFailure) {
    isDebug = true;
    reason = "live_failure";
  } else if (hasActionableBug) {
    isDebug = true;
    reason = "actionable_bug";
  } else if (hasBugAssertion) {
    isDebug = true;
    reason = "bug_assertion";
  } else if (hasUnsuppressedTicket) {
    isDebug = true;
    reason = "bug_ticket";
  } else if (hasWritingTopic) {
    reason = "writing_about_bug";
  }

  const isProductOnly =
    hasBrand && !isDebug && !hasTicket && !hasResidualBugWord;
  if (reason === "none" && isProductOnly) {
    reason = "product_only";
  } else if (reason === "none" && hasResidualBugWord) {
    reason = "bug_topic";
  }

  return {
    normalizedText,
    brandMaskedText,
    hasBrand,
    hasTicket,
    isDebug,
    isProductOnly,
    reason,
    brandSpans: brandSpansInternal.map(({ start, end, text }) => ({
      start,
      end,
      text,
    })),
    ticketSpans: ticketSpansInternal.map(({ start, end, text }) => ({
      start,
      end,
      text,
    })),
    clauses,
  };
}

/** Returns normalized text with all known Bug product-name spans removed. */
export function stripKnownBugBrands(input: string): string {
  return analyzeBugIntent(input).brandMaskedText;
}

/** Strict ticket syntax; notably rejects plural prose such as "Bugs 101". */
export function isExplicitBugTicket(input: string): boolean {
  return findTicketSpans(normalize(input)).length > 0;
}

/** Product mention without an independent residual bug/failure signal. */
export function isProductStyleBugMention(input: string): boolean {
  return analyzeBugIntent(input).isProductOnly;
}

/** Action, live assertion, or non-writing ticket that should route to debug. */
export function hasActionableBugSignal(input: string): boolean {
  return analyzeBugIntent(input).isDebug;
}
