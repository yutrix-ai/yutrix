/**
 * Clause-aware failure analysis for strategy routing.
 *
 * Failure words are classified in their local clause so a design phrase does
 * not suppress an independent runtime failure elsewhere in the same request.
 * This module is deliberately pure and dependency-free.
 */

import {
  EN_DIAGNOSTIC_ACTION_SOURCE,
  EN_WRITING_ACTION_SOURCE,
  EN_WRITING_ARTIFACT_SOURCE,
  hasDiagnosticAction,
  hasDiagnosticQuestion,
} from "./strategyRouteTextSignals";

export type FailureKind = "runtime" | "layout" | "exception";

export interface FailureEvidence {
  kind: FailureKind;
  clause: string;
  match: string;
  start: number;
  end: number;
  reason: string;
}

export interface FailureAnalysis {
  live: FailureEvidence[];
  design: FailureEvidence[];
}

interface Clause {
  text: string;
  start: number;
}

interface Candidate {
  kind: FailureKind;
  match: string;
  start: number;
  end: number;
  reason: string;
}

type FailureRole = "live" | "design";

const EN_SPEC_ACTION =
  /\b(?:add|create|implement|write|test|document|describe|define|rename|map|convert|catch|handle|retry|mock|stub|assert|expect|declare|introduce|support|configure|update|set|display|show|report|return|send|monitor|alert|need|make|prevent|avoid|ensure|keep|use|change|apply|let)\b/i;
const ZH_SPEC_ACTION =
  /新增|增加|添加|加上|加一个|加|实现|开发|支持|配置|设置|展示|显示|提示|上报|告警|监控|处理|重试|捕获|映射|转换|记录|写|测试|文档|定义|放在|放到|确保|避免|防止|让/;
const EN_SPEC_OBJECT =
  /\b(?:handling|handler|support|retry|retries|behavior|message|prompt|banner|alert|monitoring|mapping|conversion|documentation|unit tests?|test case|fallback|policy|rule|logic|example)\b/i;
const ZH_SPEC_OBJECT =
  /功能|提示|展示|显示|上报|监控|告警|处理|重试|规则|逻辑|示例|布局|动画|效果|文档|测试|能力|机制|遮挡层/;
const LIVE_CUE =
  /\b(?:still|currently|now|again|already|keeps?|occurred|unexpectedly|in production|after deploy)\b|还是|仍|仍然|依然|依旧|继续|再次|又|目前|现在|已经|出现|发生|突然|线上|生产/;
const CODE_STRUCTURE =
  /^(?:export\s+)?(?:const|let|var)\s+[a-z_$][\w$]*\s*=|^(?:export\s+)?(?:class|interface)\s+[a-z_$][\w$]*(?:\s+(?:extends|implements)\b)?|^(?:export\s+)?(?:async\s+)?function\s+[a-z_$][\w$]*\s*\(|^catch\s*\(\s*[a-z_$][\w$]*\s*\)|^(?:@media[^{]{0,200}\{\s*)?[.#][^{]{0,200}\{[^}]*:|^(?:public|private|protected|static|final|\s)*(?:void|int|long|boolean|string|[a-z_$][\w$]*)\s+[a-z_$][\w$]*\s*\([^)]*\)\s+throws\s+[a-z_$][\w$]*exception\b|^(?:select\b.+\bfrom\b|insert\s+into\b|update\s+\S+\s+set\b|delete\s+from\b)|^\s*}?\s*[a-z_$][\w$]*(?:\.[a-z_$][\w$]*)+\s*=|\bnew\s+(?:error|[a-z_$][\w$]*exception)\s*\(|^\s*(?:throw|return)\s+(?:new\s+)?(?:error\b|[45]\d\d\b)/i;

function normalizeInput(input: string): string {
  return (input || "")
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/\r\n?/g, "\n");
}

function splitClauses(input: string): Clause[] {
  const clauses: Clause[] = [];
  // Punctuation inside a recognized source statement (for example, SQL
  // assignments) separates syntax rather than independent natural-language
  // claims. Preserve the statement so all of its failure literals retain the
  // source frame.
  const boundary = CODE_STRUCTURE.test(input.trim())
    ? /\n+|;+|\.(?=\s|$)|\b(?:but|yet|however|although|though)\b|但是|但|然而|可是|不过|却|(?:,|\band\b)\s+(?=(?:the|this|that|it|service|app|application|request|deployment|worker|page|endpoint)\b)|}\s+(?=(?:[a-z_$][\w$]*\s+)?(?:crash(?:es|ed|ing)?|panic(?:s|ked|king)?|fails?|failed|failing|times?\s+out|timed\s+out)\b)/gi
    : /\n+|[,;，；。！？!?]+|\.(?=\s|$)|\b(?:but|yet|however|although|though)\b|但是|但|然而|可是|不过|却/gi;
  let cursor = 0;

  const push = (from: number, to: number) => {
    const raw = input.slice(from, to);
    const leading = raw.length - raw.trimStart().length;
    const text = raw.trim();
    if (text) clauses.push({ text, start: from + leading });
  };

  for (const match of input.matchAll(boundary)) {
    const index = match.index ?? 0;
    push(cursor, index);
    cursor = index + match[0].length;
  }
  push(cursor, input.length);

  return clauses.length > 0 ? clauses : [{ text: input.trim(), start: 0 }];
}

function collectMatches(
  clause: Clause,
  kind: FailureKind,
  pattern: RegExp,
  reason: string,
): Candidate[] {
  const flags = pattern.flags.includes("g")
    ? pattern.flags
    : `${pattern.flags}g`;
  const re = new RegExp(pattern.source, flags);
  const result: Candidate[] = [];
  for (const match of clause.text.matchAll(re)) {
    const localStart = match.index ?? 0;
    result.push({
      kind,
      match: match[0],
      start: clause.start + localStart,
      end: clause.start + localStart + match[0].length,
      reason,
    });
  }
  return result;
}

function hasSpecAction(text: string): boolean {
  return EN_SPEC_ACTION.test(text) || ZH_SPEC_ACTION.test(text);
}

function hasAnyDiagnosticCue(text: string): boolean {
  return hasDiagnosticAction(text) || hasDiagnosticQuestion(text);
}

function localPosition(candidate: Candidate, clause: Clause): number {
  return Math.max(0, candidate.start - clause.start);
}

function hasCompletedSpecBoundaryBefore(
  clause: Clause,
  position: number,
): boolean {
  const prefix = clause.text.slice(0, position);
  if (
    /^\s*(?:after|(?:ever\s+)?since)\s+(?:(?:we|i|they)\s+)?(?:add(?:ed|ing)|implement(?:ed|ing)|configur(?:ed|ing)|introduc(?:ed|ing)|enabl(?:ed|ing)|chang(?:ed|ing)|updat(?:ed|ing)|deploy(?:ed|ing))\b/i.test(
      prefix,
    ) ||
    /^\s*(?:after|(?:ever\s+)?since)\s+(?:the\s+)?(?:addition|implementation|configuration|introduction|enablement|change|update|deployment)(?:\s+of)?\b/i.test(
      prefix,
    ) ||
    /^\s*(?:after|since|once)\b.{0,48}\b(?:was|were|had\s+been)\s+(?:added|implemented|configured|introduced|enabled|changed|updated|deployed)\b/i.test(
      prefix,
    ) ||
    /^\s*following\s+.{0,32}\b(?:addition|implementation|configuration|introduction|enablement|change|update|deployment)\b/i.test(
      prefix,
    )
  ) {
    return true;
  }
  let boundary = -1;
  for (const match of prefix.matchAll(/之后|以后|后(?!端)/g)) {
    boundary = match.index ?? boundary;
  }
  if (boundary < 0) return false;
  return hasSpecAction(prefix.slice(0, boundary));
}

function lastPatternIndex(text: string, pattern: RegExp): number {
  const flags = `${pattern.flags.replace(/g/g, "")}g`;
  let result = -1;
  for (const match of text.matchAll(new RegExp(pattern.source, flags))) {
    result = match.index ?? result;
  }
  return result;
}

function hasLiveCueAfterLastSpecAction(
  clause: Clause,
  position: number,
): boolean {
  const prefix = clause.text.slice(0, position);
  const liveIndex = lastPatternIndex(prefix, LIVE_CUE);
  if (liveIndex < 0) return false;
  const specIndex = Math.max(
    lastPatternIndex(prefix, EN_SPEC_ACTION),
    lastPatternIndex(prefix, ZH_SPEC_ACTION),
  );
  return liveIndex > specIndex;
}

function isCandidateNegated(clause: Clause, candidate: Candidate): boolean {
  const position = localPosition(candidate, clause);
  const before = clause.text.slice(Math.max(0, position - 40), position);
  const after = clause.text.slice(
    position + candidate.match.length,
    position + candidate.match.length + 40,
  );
  return (
    /\b(?:no|zero)(?:\s+(?:known|remaining))?\s*$/i.test(before) ||
    /\bnever\s*$/i.test(before) ||
    /\bno\s+longer\s*$/i.test(before) ||
    /\b(?:does not|doesn't|did not|didn't|has not|hasn't|have not|haven't|is not|isn't|are not|aren't|was not|wasn't|were not|weren't)\s*$/i.test(
      before,
    ) ||
    /\b(?:never|did not|didn't|has not|hasn't|have not|haven't)\s+(?:experience(?:d)?|encounter(?:ed)?|have|had|see|saw)\s+(?:an?|any)?\s*$/i.test(
      before,
    ) ||
    /(?:不再|从未|未曾|没有|未)(?:发生|出现|遇到|遭遇|经历)?\s*$/.test(
      before,
    ) ||
    /^\s+(?:did not|didn't|has not|hasn't|never)\s+(?:occur|occurred|happen|happened)\b/i.test(
      after,
    ) ||
    /^\s+(?:is|was|has been|had been)\s+(?:resolved|fixed|repaired)\b/i.test(
      after,
    ) ||
    /^\s*(?:已经?|已|得到)?(?:解决|修复|修好|恢复)/.test(after)
  );
}

function isConditionalSpec(
  clause: Clause,
  position: number,
  nextClause?: Clause,
): boolean {
  const before = clause.text.slice(0, position);
  const after = clause.text.slice(position);

  if (
    hasAnyDiagnosticCue(clause.text) ||
    (nextClause && hasAnyDiagnosticCue(nextClause.text))
  ) {
    return false;
  }

  const conditionBefore =
    /\b(?:when|if|whenever|unless)\b[^.;,]*$/i.test(before) ||
    /(?:当|如果|若|每当)[^，。；]*$/.test(before);
  if (
    conditionBefore &&
    (hasSpecAction(clause.text) ||
      !!(nextClause && hasSpecAction(nextClause.text)) ||
      /^(?:when|if|whenever|unless)\b|^(?:当|如果|若|每当)/i.test(clause.text))
  ) {
    return true;
  }

  if (
    /\b(?:add|create|implement|configure|show|display|report|return|send|monitor|alert|handle|retry)\b[^.;,]{0,48}\bafter\b[^.;,]*$/i.test(
      before,
    )
  ) {
    return true;
  }

  // 请求失败时自动重试 / error when invalid.
  if (
    /^(?:[^.;,]{0,30}\bwhen\b|[^。；，]{0,20}时)/i.test(after) &&
    (hasSpecAction(after) || !!(nextClause && hasSpecAction(nextClause.text)))
  ) {
    return true;
  }

  return false;
}

function hasLocalSpecFrame(clause: Clause, candidate: Candidate): boolean {
  const position = localPosition(candidate, clause);
  const before = clause.text.slice(Math.max(0, position - 100), position);
  const after = clause.text.slice(
    position + candidate.match.length,
    position + candidate.match.length + 80,
  );
  const local = `${before}${candidate.match}${after}`;
  const localBoundary = lastPatternIndex(
    before,
    /\b(?:and|then|so|after|once|following)\b|(?:并且|然后|所以|之后|以后|随后)/i,
  );
  const localBefore =
    localBoundary >= 0 ? before.slice(localBoundary) : before;
  const localSegment = `${localBefore}${candidate.match}${after}`;
  const writingBoundary = lastPatternIndex(
    before,
    /\b(?:and|then|so)\b|(?:并且|然后|所以|随后)/i,
  );
  const writingBefore =
    writingBoundary >= 0 ? before.slice(writingBoundary) : before;
  const writingSegment = `${writingBefore}${candidate.match}${after}`;

  if (CODE_STRUCTURE.test(clause.text)) return true;

  if (/失败重试/.test(local)) return true;

  if (
    /^(?:show|display|report|return|throw|send)\b/i.test(
      candidate.match.trim(),
    ) &&
    (/^(?:(?:please|then|and\s+then)\s*)?$/i.test(before.trim()) ||
      /\b(?:to|should|must|needs?\s+to|is\s+expected\s+to)\s*$/i.test(before))
  ) {
    return true;
  }

  if (
    /\b(?:should|must|needs?\s+to|is\s+expected\s+to)(?:\s+not)?\s*$/i.test(
      before,
    )
  ) {
    return true;
  }

  if (
    new RegExp(
      `\\b${EN_WRITING_ACTION_SOURCE}\\b.{0,48}\\b${EN_WRITING_ARTIFACT_SOURCE}\\b`,
      "i",
    ).test(writingSegment)
  ) {
    return true;
  }

  if (
    /\b(?:document|describe|summarize|explain)\b.{0,56}\b(?:errors?|exceptions?|failures?|crashes?|timeouts?|incidents?)\b/i.test(
      writingSegment,
    )
  ) {
    return true;
  }

  if (
    new RegExp(
      `\\b(?:implement|build|create|develop|add|write)\\b.{0,48}\\b(?:command|tool|parser|script|function|method|service|feature|module|handler)\\b.{0,36}\\bto\\s+${EN_DIAGNOSTIC_ACTION_SOURCE}\\b`,
      "i",
    ).test(before)
  ) {
    return true;
  }

  if (hasAnyDiagnosticCue(local)) return false;

  if (
    /^(?:http(?:\s+status)?\s+|status(?:\s+code)?\s*[:=]?\s*|(?:returns?|returned|responds?|responded).{0,16})?(?:4\d\d|5\d\d)$/i.test(
      candidate.match.trim(),
    ) &&
    /\b(?:map|return|test|expect|document|define)\b/i.test(before)
  ) {
    return true;
  }

  if (
    (EN_SPEC_ACTION.test(localBefore) || ZH_SPEC_ACTION.test(localBefore)) &&
    (candidate.kind === "layout" ||
      EN_SPEC_OBJECT.test(local) ||
      ZH_SPEC_OBJECT.test(local) ||
      /\b(?:when|if|for|on)\b/i.test(local) ||
      /(?:当|如果|若|时|用于|针对)/.test(local))
  ) {
    return true;
  }

  if (
    /\b(?:show|display|report|return|throw|handle|catch|map|convert|send|monitor|alert)\s+(?:an?\s+)?$/i.test(
      before,
    ) ||
    /(?:提示|展示|显示|上报|返回|处理|捕获|映射|转换).{0,8}$/.test(before)
  ) {
    return true;
  }

  if (
    (EN_SPEC_ACTION.test(localBefore) || ZH_SPEC_ACTION.test(localBefore)) &&
    (/\b(?:handling|support|behavior|test|documentation)\b/i.test(after) ||
      /处理|支持|行为|测试|文档|功能|提示|展示|监控|告警|上报/.test(after))
  ) {
    return true;
  }

  if (
    (candidate.reason !== "diagnostic_error_target" &&
      /^(?:\s+)?(?:handling|support|behavior|message|prompt|banner|alert|monitoring|mapping|conversion|retry|retries|documentation|tests?)\b/i.test(
        after,
      )) ||
    /^(?:处理|支持|提示|展示|监控|告警|上报|重试|功能)/.test(after)
  ) {
    return true;
  }

  return false;
}

function classifyException(
  clause: Clause,
  candidate: Candidate,
  nextClause?: Clause,
): FailureRole {
  const position = localPosition(candidate, clause);

  if (isCandidateNegated(clause, candidate)) return "design";
  if (isConditionalSpec(clause, position, nextClause)) return "design";
  if (hasCompletedSpecBoundaryBefore(clause, position)) return "live";

  const text = clause.text;
  if (
    /\bwith\s+(?:the\s+)?exception\s+of\b|\ban?\s+exception\s+to\b|\b(?:make|allow|grant)\s+an?\s+exception\b.{0,32}\b(?:for|policy|rule|user)\b/i.test(
      text,
    )
  ) {
    return "design";
  }
  const codeOrDevFrame =
    /\b(?:add|create|implement|write|test|document|describe|rename|map|convert|catch|handle|retry|mock|stub|assert|expect|declare|define|introduce|support)\b/i.test(
      text,
    ) ||
    /\b(?:should|must|can|to)\s+(?:be\s+)?(?:caught|handled|mapped|converted|retried|mocked|documented)\b/i.test(
      text,
    ) ||
    /\b(?:caught|handled|mapped|converted|retried)\b/i.test(text) ||
    /\bassertthrows\s*\(|\bcatch\s*\(|\.class\b|\bunit\s*tests?\b/i.test(
      text,
    ) ||
    /新增|增加|添加|实现|开发|测试|文档|捕获|处理|重试|映射|转换|展示|提示|功能/.test(
      text,
    );

  const runtimeHeader =
    /\b(?:unhandled|uncaught|occurred|raised|was thrown|caused by)\b/i.test(
      text,
    ) ||
    /\b(?:[a-z_$][\w$]*exception|exception|typeerror|referenceerror|syntaxerror|rangeerror|systemerror)\s*:|\bexception\b.{0,16}\bat\s+(?:line|\w+\.)/i.test(
      text,
    ) ||
    /\bcannot\s+read\s+properties?\s+of\s+(?:null|undefined)\b/i.test(text) ||
    /\b(?:stack\s*trace|stacktrace|traceback)\b/i.test(text);

  if (runtimeHeader) return "live";
  if (hasLiveCueAfterLastSpecAction(clause, position)) return "live";
  if (codeOrDevFrame || hasLocalSpecFrame(clause, candidate)) return "design";
  if (LIVE_CUE.test(text)) return "live";

  // Preserve the established contract: a bare exception class/header is debug.
  return "live";
}

function classifyLayout(
  clause: Clause,
  candidate: Candidate,
  nextClause?: Clause,
): FailureRole {
  const position = localPosition(candidate, clause);
  if (isConditionalSpec(clause, position, nextClause)) return "design";

  const text = clause.text;
  if (isCandidateNegated(clause, candidate)) return "design";
  if (hasCompletedSpecBoundaryBefore(clause, position)) return "live";
  if (hasLiveCueAfterLastSpecAction(clause, position)) return "live";
  const layoutSpec = hasLocalSpecFrame(clause, candidate);

  if (
    candidate.match === "滚动条" ||
    /\bscrollbars?\b/i.test(candidate.match)
  ) {
    const scrollbarFailure =
      /消失|不见|不显示|没显示|卡住|失效|异常|不能|无法|错位/.test(text) ||
      /\b(?:missing|gone|hidden|stuck|broken|not visible|does not appear|disappears?|disappeared)\b/i.test(
        text,
      );
    if (scrollbarFailure) return "live";
    return "design";
  }

  if (layoutSpec) return "design";
  const immediateBefore = text.slice(Math.max(0, position - 20), position);
  if (LIVE_CUE.test(immediateBefore)) return "live";
  return "live";
}

function classifyRuntime(
  clause: Clause,
  candidate: Candidate,
  nextClause?: Clause,
): FailureRole {
  const position = localPosition(candidate, clause);
  if (isCandidateNegated(clause, candidate)) return "design";
  if (isConditionalSpec(clause, position, nextClause)) return "design";
  if (hasCompletedSpecBoundaryBefore(clause, position)) return "live";
  if (hasLiveCueAfterLastSpecAction(clause, position)) return "live";
  if (hasLocalSpecFrame(clause, candidate)) return "design";
  if (hasDiagnosticAction(clause.text)) return "live";
  const immediateBefore = clause.text.slice(
    Math.max(0, position - 24),
    position,
  );
  if (LIVE_CUE.test(immediateBefore)) return "live";
  return "live";
}

function collectDiagnosticErrorCandidates(clause: Clause): Candidate[] {
  const inspectionActionSource =
    String.raw`(?:analy(?:ze[sd]?|zing)|analys(?:e[sd]?|ing)|inspect(?:s|ed|ing)?|review(?:s|ed|ing)?|check(?:s|ed|ing)?|examin(?:e[sd]?|ing))`;
  const directInspection = new RegExp(
    `\\b${inspectionActionSource}\\b.{0,12}\\b(?:this|that|the)\\s+errors?\\b`,
    "i",
  ).test(clause.text);
  const postposedDiagnosticAction = new RegExp(
    `\\berrors?\\b(?:\\s+(?:messages?|codes?|responses?|stacks?|details?|outputs?))?\\s+(?:(?:needs?|requires?)\\s+(?:(?:to\\s+be\\s+)?${EN_DIAGNOSTIC_ACTION_SOURCE}|investigation|diagnosis|repair)|(?:must|should|ought\\s+to|has\\s+to|have\\s+to)\\s+(?:be\\s+)?${EN_DIAGNOSTIC_ACTION_SOURCE}|(?:is|are)\\s+being\\s+${EN_DIAGNOSTIC_ACTION_SOURCE}|(?:is|are)\\s+under\\s+(?:investigation|diagnosis|repair))\\b`,
    "i",
  ).test(clause.text);
  if (
    !hasAnyDiagnosticCue(clause.text) &&
    !directInspection &&
    !postposedDiagnosticAction
  ) {
    return [];
  }

  const hasLogDiagnostic =
    hasDiagnosticAction(clause.text) &&
    /\b(?:logs?|log\s+files?|logging\s+output)\b|日志/i.test(clause.text);
  const actionImmediatelyBefore = new RegExp(
    `\\b(?:${EN_DIAGNOSTIC_ACTION_SOURCE}|${inspectionActionSource})\\b(?:\\s+(?:this|that|the|an?|current|production|runtime))?\\s*$`,
    "i",
  );
  const inspectionImmediatelyBefore = new RegExp(
    `\\b${inspectionActionSource}\\b(?:\\s+(?:this|that|the|an?|current|production|runtime))?\\s*$`,
    "i",
  );
  const diagnosticImmediatelyAfter = new RegExp(
    `^\\s+(?:messages?|codes?|responses?|stacks?|details?|outputs?)?\\s*(?:(?:needs?|requires?)\\s+(?:(?:to\\s+be\\s+)?${EN_DIAGNOSTIC_ACTION_SOURCE}|investigation|diagnosis|repair)|(?:must|should|ought\\s+to|has\\s+to|have\\s+to)\\s+(?:be\\s+)?${EN_DIAGNOSTIC_ACTION_SOURCE}|(?:is|are)\\s+being\\s+${EN_DIAGNOSTIC_ACTION_SOURCE}|(?:is|are)\\s+under\\s+(?:investigation|diagnosis|repair))\\b`,
    "i",
  );
  const runtimeInspectionTail =
    /^\s*(?:$|[,.!?;]|(?:messages?|codes?|responses?|stacks?|details?|outputs?)\b|(?:in|from|on|at)\s+(?:production|runtime|logs?|log\s+files?|server|service|app|application|endpoint|request|worker|deployment)\b|(?:that|which|reported|shown|thrown|occurred)\b)/i;
  const conceptualPrefix =
    /\b(?:standard|measurement|sampling|prediction|percentage|statistical|mean\s+squared|margin\s+of)\s*$/i;
  const conceptualSuffix =
    /^\s+(?:logs?|log\s+files?|rate|term|metric|function|distribution|correction|margin|percentage|measurement|prediction|analysis|method|theory)\b/i;

  return collectMatches(
    clause,
    "runtime",
    /\berrors?\b/gi,
    "diagnostic_error_target",
  ).filter((candidate) => {
    const position = localPosition(candidate, clause);
    const before = clause.text.slice(Math.max(0, position - 64), position);
    const after = clause.text.slice(
      position + candidate.match.length,
      position + candidate.match.length + 32,
    );
    if (conceptualPrefix.test(before)) return false;
    if (conceptualSuffix.test(after)) return false;
    if (
      inspectionImmediatelyBefore.test(before) &&
      !runtimeInspectionTail.test(after)
    ) {
      return false;
    }
    if (hasLogDiagnostic) return true;
    if (diagnosticImmediatelyAfter.test(after)) return true;
    if (actionImmediatelyBefore.test(before)) return true;
    return (
      hasDiagnosticQuestion(clause.text) &&
      /\b(?:this|that|the|current|production|runtime)\s*$/i.test(before)
    );
  });
}

function collectClauseCandidates(clause: Clause): Candidate[] {
  const hasEnglishLayoutContext =
    /\b(?:ui|ux|css|html|layout|screen|viewport|page|text|button|elements?|modal|dialog|card|label|input|content|sidebar|header|footer|image|icon|menu|panel|container|box|component|form|tooltip|dropdown|table|column|row|scrollbars?|dashboard|chart|canvas|popover|drawer|badge|avatar|navbar|fab)\b|\.(?:vue|svelte|tsx?|jsx?|html|css|scss|sass|less)\b/i.test(
      clause.text,
    );
  const candidates = [
    ...collectMatches(
      clause,
      "layout",
      /滚动条|错位|溢出|重叠|遮挡|盖住/gi,
      "layout_term",
    ),
    ...(hasEnglishLayoutContext
      ? collectMatches(
          clause,
          "layout",
          /\b(?:scrollbars?|misalign(?:s|ed|ing|ment)?|overflow(?:s|ed|ing)?|overlap(?:s|ped|ping)?|obscur(?:e[sd]?|ing))\b/gi,
          "layout_term",
        )
      : []),
    ...collectMatches(
      clause,
      "exception",
      /\b(?:[a-z_$][a-z0-9_$]*exception|exception|typeerror|referenceerror|syntaxerror|rangeerror|systemerror)\b|异常/gi,
      "exception_term",
    ),
    ...collectMatches(
      clause,
      "runtime",
      /\b(?:stack\s*trace|stacktrace|traceback|panic(?:s|ked|king)?|crash(?:es|ed|ing)?|not working|doesn't work|does not work|isn't working|is broken|stopped working|won't start|will not start|keeps?\s+failing|is failing|are failing|fails?|failed|failing|failure|keeps?\s+timing out|timing out|timed out|times out|time out|timeouts?|(?:returns?|returned|responds?|responded)(?:\s+with|\s+status(?:\s+code)?|\s+a)?\s+(?:4(?:00|01|03|04|08|09|22|29)|5\d\d)|http(?:\s+status)?\s+(?:4(?:00|01|03|04|08|09|22|29)|5\d\d)|status(?:\s+code)?\s*(?:(?:is|was)\s+|[:=]\s*)?(?:4(?:00|01|03|04|08|09|22|29)|5\d\d)|(?:got|gets?|getting)\s+(?:an?\s+)?(?:4(?:00|01|03|04|08|09|22|29)|5\d\d)|(?:4(?:00|01|03|04|08|09|22|29)|5\d\d)\s+from\s+\w+|(?:shows?|has|throws?)\s+(?:an?\s+)?errors?|errors?\s+(?:occurred|thrown)|not found)\b/gi,
      "runtime_term",
    ),
    ...collectMatches(
      clause,
      "runtime",
      /报错|崩溃|白屏|失败|超时|错误|不生效|没生效|错乱|不好使|没展示|没显示|没有显示|没有展示|没改好|没改完|没效果|没作用|不能用|无法使用|不能(?:编辑|修改|点击|选择|保存|提交|获取|显示|展示)|无法(?:编辑|修改|点击|选择|保存|提交|获取|显示|展示)|点不了|点不开|打不开|用不了|不见了|不存在|无效|堆栈(?:信息)?|调用栈/gi,
      "runtime_term_zh",
    ),
    ...(/\b(?:text|button|element|modal|dialog|card|label|input|content|sidebar|header|footer|image|icon|menu|panel)\b/i.test(
      clause.text,
    )
      ? collectMatches(
          clause,
          "layout",
          /\b(?:is|are|was|were|gets?|got)\s+(?:cut off|covered)\b/gi,
          "layout_visibility_term",
        )
      : []),
    ...collectMatches(
      clause,
      "runtime",
      /\berrors?\b(?=\s+(?:is|was|has\s+been|had\s+been)\s+(?:resolved|fixed|repaired)\b)/gi,
      "resolved_error_term",
    ),
    ...collectDiagnosticErrorCandidates(clause),
  ];

  // Layout/exception evidence is more specific than overlapping generic terms.
  candidates.sort((a, b) => a.start - b.start || a.end - b.end);
  return candidates.filter((candidate, index) => {
    if (candidate.kind !== "runtime") return true;
    return !candidates.some(
      (other, otherIndex) =>
        otherIndex !== index &&
        (other.kind === "layout" || other.kind === "exception") &&
        other.start <= candidate.start &&
        other.end >= candidate.end,
    );
  });
}

function pushEvidence(
  analysis: FailureAnalysis,
  role: FailureRole,
  clause: Clause,
  candidate: Candidate,
): void {
  const evidence: FailureEvidence = {
    kind: candidate.kind,
    clause: clause.text,
    match: candidate.match,
    start: candidate.start,
    end: candidate.end,
    reason: candidate.reason,
  };
  const target = role === "live" ? analysis.live : analysis.design;
  if (
    !target.some(
      (item) =>
        item.kind === evidence.kind &&
        item.start === evidence.start &&
        item.end === evidence.end,
    )
  ) {
    target.push(evidence);
  }
}

export function analyzeFailureIntent(input: string): FailureAnalysis {
  const normalized = normalizeInput(input);
  const analysis: FailureAnalysis = { live: [], design: [] };
  if (!normalized.trim()) return analysis;

  const clauses = splitClauses(normalized);
  clauses.forEach((clause, index) => {
    const nextClause = clauses[index + 1];
    for (const candidate of collectClauseCandidates(clause)) {
      const role =
        candidate.kind === "exception"
          ? classifyException(clause, candidate, nextClause)
          : candidate.kind === "layout"
            ? classifyLayout(clause, candidate, nextClause)
            : classifyRuntime(clause, candidate, nextClause);
      pushEvidence(analysis, role, clause, candidate);
    }
  });

  return analysis;
}

export function hasLiveBreakageSignal(input: string): boolean {
  return analyzeFailureIntent(input).live.length > 0;
}

export function isDesignSpecFailureTheme(input: string): boolean {
  const analysis = analyzeFailureIntent(input);
  return analysis.design.length > 0 && analysis.live.length === 0;
}

export function hasExplicitFailureSignal(input: string): boolean {
  return analyzeFailureIntent(input).live.length > 0;
}
