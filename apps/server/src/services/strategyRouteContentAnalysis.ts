/**
 * Pure content-routing signal analysis.
 *
 * This module deliberately separates evidence collection from arbitration:
 * structured logs are positive long-context evidence, never a global veto for
 * explicit code work or source-code evidence.
 */

import {
  EN_LOG_ANALYSIS_ACTION_SOURCE,
  EN_META_WRITING_ACTION_SOURCE,
  EN_WRITING_ACTION_SOURCE,
  EN_WRITING_ARTIFACT_SOURCE,
} from "./strategyRouteTextSignals";

export type ContentRouteTaskType = "code" | "writing" | "long_context";

export type ContentUtteranceTaskType =
  | ContentRouteTaskType
  | "vision"
  | "debug"
  | "general";

export type ContentRouteReason =
  | "content_code_explicit"
  | "content_code_file_ref"
  | "content_writing_explicit"
  | "content_code_source_paste"
  | "content_log_analysis"
  | "content_structured_log_paste"
  | "content_utterance_code"
  | "content_utterance_writing"
  | "content_utterance_long_context"
  | "content_large_input";

export interface ContentRouteEvidence {
  code: {
    explicitTask: boolean;
    fileRef: boolean;
    sourcePaste: boolean;
    score: number;
    reasons: string[];
  };
  writing: {
    explicitTask: boolean;
    score: number;
    reasons: string[];
  };
  logs: {
    analysisTask: boolean;
    instrumentationTask: boolean;
    structuredPaste: boolean;
    score: number;
    reasons: string[];
  };
  oversized: boolean;
}

export interface ResolvedContentRoute {
  taskType: ContentRouteTaskType;
  reason: ContentRouteReason;
}

interface StructuredLogStats {
  nonBlankLines: number;
  structuredLines: number;
  hasStructuredLine: boolean;
}

const EN_LOG_ANALYSIS_VERB = String.raw`\b${EN_LOG_ANALYSIS_ACTION_SOURCE}\b`;
const EN_LOG_OBJECT = String.raw`(?:\b(?:(?:application|access|audit|server|nginx|docker|git|api|error)\s+)?(?:logs?|log\s+files?|logging\s+output)\b|\btranscripts?\b|\baudit\s+(?:logs?|trail)\b)`;
const ZH_LOG_ANALYSIS_VERB = String.raw`(?:分析|查看|检查|阅读|梳理|总结|定位|排查|检索|搜索)`;
const ZH_LOG_OBJECT = String.raw`(?:日志|审计日志|审计记录|长日志|长文本|对话记录)`;

const CODE_FILE_REFERENCE =
  /(?:^|[\s("'`])(?:src|lib|app|apps|packages|components|pages|views|server|client)[/\\][^\s"'`]+|\.(?:tsx?|jsx?|vue|svelte|java|py|go|rs|sql|cpp|cc|cxx|c|h|hpp|cs|rb|php|kt|kts|swift|scala|sh|bash|zsh|html|css|scss|sass|less|xml|json|ya?ml)\b/i;

const WRITING_ACTION_TARGET = new RegExp(
  `\\b${EN_WRITING_ACTION_SOURCE}\\b.{0,64}\\b${EN_WRITING_ARTIFACT_SOURCE}\\b|\\b${EN_WRITING_ARTIFACT_SOURCE}\\b.{0,40}\\b${EN_WRITING_ACTION_SOURCE}\\b|\\b${EN_META_WRITING_ACTION_SOURCE}\\b.{0,64}\\b(?:bug\\s*(?:#\\s*|[-_:/\\u2013\\u2014]\\s*)\\d{1,10}|bugs?)\\b`,
  "i",
);
const FAILURE_DOCUMENTATION_TARGET = new RegExp(
  `\\b${EN_META_WRITING_ACTION_SOURCE}\\b.{0,64}\\b(?:errors?|exceptions?|failures?|crashes?|timeouts?|incidents?)\\b`,
  "i",
);
const LOGGING_DOCUMENTATION_TARGET =
  /\b(?:document(?:s|ed|ing)?|describ(?:e[sd]?|ing)|explain(?:s|ed|ing)?)\b.{0,64}\b(?:how|why|ways?\s+to|guidance\s+for)?\s*(?:logs?|logging)\b/i;
const WRITING_SCOPED_LOGGING_TARGET = new RegExp(
  `\\b${EN_WRITING_ACTION_SOURCE}\\b.{0,48}\\b${EN_WRITING_ARTIFACT_SOURCE}\\b.{0,32}\\b(?:about|on|for|covering|explaining|describing)\\b.{0,40}\\b(?:logs?|logging)\\b`,
  "i",
);

const HIGH_CONFIDENCE_TECH_TARGET =
  /\b(?:code|api|endpoint|parser|function|method|component|handler|schema|struct|enum|cli|sdk|authentication|authorization|oauth|cache|caching|rate\s+limit(?:ing)?|pagination|validation|webhook|middleware|database|sql\s+query|query|regex|script|command|worker|controller|repository|serializer|deserializer|logger|logging|plugin|unit\s+tests?|test\s+suite|tests?|exception|stack\s*trace|retry\s+logic|errors?|timeouts?|failures?|crashes?|status\s+code|error\s+handling|timeout\s+handling|failure\s+handling|exception\s+handling|mapping|monitor(?:ing)?|alerts?)\b/i;

const AMBIGUOUS_TECH_TARGET =
  /\b(?:service|class|interface|migration|module|package)\b/i;
const TECH_QUALIFIER =
  /\b(?:code|source|backend|frontend|database|software|typescript|javascript|python|java|kotlin|rust|golang|go|sql|spring|react|vue|node|microservice)\b/i;

function normalize(text: string): string {
  return (text || "")
    .replace(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g, " [image] ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}

function countMatches(text: string, pattern: RegExp): number {
  return (text.match(pattern) || []).length;
}

function looksLikeAccessLogLine(value: string): boolean {
  const firstSpace = value.indexOf(" ");
  if (firstSpace <= 0) return false;
  const address = value.slice(0, firstSpace);
  if (
    !/^(?:(?:\d{1,3}\.){3}\d{1,3}|\[?[0-9a-f]*:[0-9a-f:]+\]?)$/i.test(
      address,
    )
  ) {
    return false;
  }

  const requestStart = value.indexOf('"', firstSpace);
  if (requestStart < 0) return false;
  const requestEnd = value.indexOf('"', requestStart + 1);
  if (requestEnd < 0) return false;
  if (
    !/^(?:GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s+\S+/i.test(
      value.slice(requestStart + 1, requestEnd),
    )
  ) {
    return false;
  }
  return /^\s+\d{3}\b/.test(value.slice(requestEnd + 1));
}

function isStructuredLogLine(line: string): boolean {
  const value = line.trim();
  if (!value) return false;
  if (/^<\/?[A-Za-z][^>]*>/.test(value)) return false;

  const hasTimestamp =
    /^\[?\d{4}[-/]\d{2}[-/]\d{2}[T\s]\d{2}:\d{2}:\d{2}/.test(value) ||
    /^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\b/i.test(
      value,
    ) ||
    /^\[\d{2}\/[A-Za-z]{3}\/\d{4}:\d{2}:\d{2}:\d{2}/.test(value);
  const hasLevel =
    /(?:^|[\s[(])(?:trace|debug|info|warn|warning|error|fatal|critical)(?:[\s\]):]|$)/i.test(
      value,
    );
  const syslog =
    /^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\S+\s+[\w./-]+(?:\[\d+\])?:\s+/i.test(
      value,
    );
  const levelFirstTimestamp =
    /^(?:trace|debug|info|warn|warning|error|fatal|critical)\s+\[?\d{4}[-/]\d{2}[-/]\d{2}[T\s]\d{2}:\d{2}:\d{2}/i.test(
      value,
    );
  const containerRuntime =
    /^\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}(?:\.\d+)?z\s+(?:stdout|stderr)\s+[fp]\s+\S+/i.test(
      value,
    );
  if (
    looksLikeAccessLogLine(value) ||
    syslog ||
    levelFirstTimestamp ||
    containerRuntime
  )
    return true;

  const jsonKeys =
    value.startsWith("{") || value.startsWith("[")
      ? countMatches(
          value,
          /"(?:timestamp|time|datetime|level|severity|msg|message|log|stream|logger|request_id|trace_id|status|duration|method|path|host|pid|thread)"\s*:/gi,
        )
      : 0;
  if (
    jsonKeys >= 2 &&
    (hasTimestamp ||
      hasLevel ||
      /"(?:level|message|msg|log|timestamp|time)"\s*:/.test(value))
  ) {
    return true;
  }

  const logKeyValues = countMatches(
    value,
    /\b(?:timestamp|time|datetime|level|severity|msg|message|logger|request_id|trace_id|status|duration|method|path|host|pid|thread)\s*=/gi,
  );
  const weakKeyValues = countMatches(
    value,
    /\b(?:function|class|return)\s*=/gi,
  );
  if ((hasTimestamp || hasLevel) && logKeyValues + weakKeyValues >= 1)
    return true;
  if (logKeyValues >= 2 || (logKeyValues >= 1 && weakKeyValues >= 2))
    return true;
  if (hasTimestamp && hasLevel) return true;
  return false;
}

function structuredLogStats(rawText: string): StructuredLogStats {
  const lines = (rawText || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const structuredLines = lines.reduce(
    (count, line) => count + (isStructuredLogLine(line) ? 1 : 0),
    0,
  );
  return {
    nonBlankLines: lines.length,
    structuredLines,
    hasStructuredLine: structuredLines > 0,
  };
}

/**
 * Detects a structured log paste from line structure and density.
 * It intentionally does not classify arbitrary repeated key=value source code
 * or HTML attributes as logs.
 */
export function looksLikeStructuredLogPaste(rawText: string): boolean {
  const stats = structuredLogStats(rawText);
  if (stats.nonBlankLines === 0) return false;
  const ratio = stats.structuredLines / stats.nonBlankLines;
  return (
    (stats.structuredLines >= 3 && ratio >= 0.5) ||
    (stats.structuredLines >= 2 && stats.nonBlankLines <= 4 && ratio >= 0.66)
  );
}

function hasLogAnalysisTask(normalized: string): boolean {
  if (!normalized) return false;
  const enForward = new RegExp(
    `${EN_LOG_ANALYSIS_VERB}.{0,64}${EN_LOG_OBJECT}`,
    "i",
  );
  const enReverse = new RegExp(
    `${EN_LOG_OBJECT}.{0,40}${EN_LOG_ANALYSIS_VERB}`,
    "i",
  );
  const zhForward = new RegExp(
    `${ZH_LOG_ANALYSIS_VERB}.{0,40}${ZH_LOG_OBJECT}`,
  );
  const zhReverse = new RegExp(
    `${ZH_LOG_OBJECT}.{0,24}${ZH_LOG_ANALYSIS_VERB}`,
  );
  return (
    enForward.test(normalized) ||
    enReverse.test(normalized) ||
    zhForward.test(normalized) ||
    zhReverse.test(normalized)
  );
}

function hasLogInstrumentationTask(normalized: string): boolean {
  const configuredLogging = new RegExp(
    `\\b(?:add|enable|configure|set\\s*up|setup|emit|inject|instrument|create)\\b(?:(?!\\b${EN_WRITING_ARTIFACT_SOURCE}\\b).){0,40}\\b(?:audit\\s+)?(?:logs?|logging)\\b`,
    "i",
  );
  return (
    configuredLogging.test(normalized) ||
    /\b(?:write|print)\s+(?:the\s+|some\s+|audit\s+)?logs?\b/i.test(
      normalized,
    ) ||
    /(?:增加|添加|开启|启用|配置|注入|埋点|输出|写入).{0,20}(?:日志|审计日志)/.test(
      normalized,
    )
  );
}

function hasWritingTask(normalized: string): boolean {
  return (
    WRITING_ACTION_TARGET.test(normalized) ||
    FAILURE_DOCUMENTATION_TARGET.test(normalized) ||
    LOGGING_DOCUMENTATION_TARGET.test(normalized) ||
    /\b(?:only|just)\s+(?:explain|summarize|describe|document|translate)\s+(?:it|that|this)\b/i.test(
      normalized,
    ) ||
    /(?:写|撰写|起草|编写|更新|改写|重写|润色|编辑|校对|翻译|总结|描述|说明).{0,32}(?:文章|邮件|故事|文案|博客|传记|发布说明|更新说明|变更日志|文档|提案|报告|描述|总结|说明|记录|修复情况)/.test(
      normalized,
    )
  );
}

function hasCodeActionTarget(normalized: string): boolean {
  const strongAction =
    /\b(?:implement|build|create|develop|add|write|refactor|fix|modify|update|generate|support|configure|retry|show|display|send|monitor|define|declare)\b/i;
  const forward = new RegExp(
    `${strongAction.source}(?:(?!\\b${EN_WRITING_ARTIFACT_SOURCE}\\b).){0,56}${HIGH_CONFIDENCE_TECH_TARGET.source}`,
    "i",
  );
  const reverse = new RegExp(
    `${HIGH_CONFIDENCE_TECH_TARGET.source}.{0,40}${strongAction.source}`,
    "i",
  );
  const writeCode =
    /\bwrite\s+(?:a|an|the)?\s*(?:(?:python|javascript|typescript|java|kotlin|rust|go|golang|sql|shell|bash)\s+)?(?:parser|query|regex|script|function|method|component|handler|module|cli|test|program)\b/i;
  const codeTransformation =
    /\b(?:rewrite|edit|translate|review)\b.{0,40}\b(?:source\s+code|code|functions?|methods?|components?|scripts?|queries|regex|classes|interfaces|modules?|tests?)\b/i;
  const ambiguous =
    (new RegExp(
      `${strongAction.source}.{0,48}${AMBIGUOUS_TECH_TARGET.source}`,
      "i",
    ).test(normalized) ||
      new RegExp(
        `${AMBIGUOUS_TECH_TARGET.source}.{0,32}${strongAction.source}`,
        "i",
      ).test(normalized)) &&
    TECH_QUALIFIER.test(normalized);
  const chinese =
    /(?:实现|开发|新增|添加|重构|修改|修复|编写|写一个).{0,32}(?:代码|接口|端点|解析器|函数|方法|组件|处理器|中间件|数据库|脚本|命令行|认证|鉴权|缓存|分页|校验|日志模块)/.test(
      normalized,
    ) ||
    /(?:实现|开发|新增|增加|添加|加|支持|配置).{0,32}(?:报错|异常|崩溃|白屏|失败|超时|堆栈).{0,24}(?:提示|展示|处理|重试|监控|告警|上报|功能)/.test(
      normalized,
    ) ||
    /(?:实现|开发|新增|增加|添加|加|支持|配置).{0,24}(?:重试|监控|告警|上报)(?:机制|逻辑|功能)/.test(
      normalized,
    );
  const exceptionStructure =
    /\b[a-z_$][\w$]*exception\b.{0,40}\b(?:(?:should|must)(?:\s+be)?|to\s+be)\s+(?:caught|handled|mapped|converted|retried)\b/i.test(
      normalized,
    ) ||
    /\bassertthrows\s*\(|\bcatch\s*\(\s*[a-z_$][\w$]*exception\b/i.test(
      normalized,
    );
  const exceptionTask =
    /\b(?:add|create|implement|write|test|map|convert|catch|handle|retry|support)\b.{0,48}\b[a-z_$][\w$]*exception\b|\b[a-z_$][\w$]*exception\b.{0,40}\b(?:handling|handler|mapping|conversion|retry|test|support)\b/i.test(
      normalized,
    );
  const conditionalRetry =
    /\bretry\b.{0,48}\b(?:request|operation|call|job|task)\b.{0,24}\b(?:times?\s+out|timeouts?|fails?|failure)\b/i.test(
      normalized,
    );
  const behaviorSpec =
    /\b(?:api|endpoint|function|method|handler|service|ui|application|app)\b.{0,40}\b(?:should|must|needs?\s+to|is\s+expected\s+to)\b.{0,16}\b(?:return|throw|show|display|report|send|emit)\b/i.test(
      normalized,
    );

  if (
    /\b(?:workplace policy|customer service policy|class schedule|employee migration plan|organizational migration plan|recommendations? in (?:this|the) report|public interface design standard|api governance report)\b/i.test(
      normalized,
    )
  ) {
    return false;
  }
  return (
    forward.test(normalized) ||
    reverse.test(normalized) ||
    writeCode.test(normalized) ||
    codeTransformation.test(normalized) ||
    ambiguous ||
    chinese ||
    exceptionStructure ||
    exceptionTask ||
    conditionalRetry ||
    behaviorSpec
  );
}

export function isCompletedResolvedFailureStatement(
  normalized: string,
): boolean {
  return (
    /^(?:after|(?:ever\s+)?since|once)\s+(?:(?:we|i|they)\s+)?(?:add(?:ed|ing)|implement(?:ed|ing)|configur(?:ed|ing)|introduc(?:ed|ing)|enabl(?:ed|ing)|chang(?:ed|ing)|updat(?:ed|ing)|deploy(?:ed|ing))\b.{0,96}\b(?:no\s+longer|does\s+not|doesn't|did\s+not|didn't|never)\s+(?:fail|fails|crash|crashes|time\s+out|times?\s+out)\s*[.!]?$/i.test(
      normalized,
    ) ||
    /^following\b.{0,48}\b(?:addition|implementation|configuration|introduction|enablement|change|update|deployment)\b.{0,64}\b(?:no\s+longer|does\s+not|doesn't|did\s+not|didn't|never)\s+(?:fail|fails|crash|crashes|time\s+out|times?\s+out)\s*[.!]?$/i.test(
      normalized,
    ) ||
    /^(?:新增|增加|添加|实现|配置|部署)(?:了)?.{0,32}(?:重试|监控|告警|上报|功能)(?:功能)?(?:后|之后|以后).{0,48}(?:不再|没有|未)(?:报错|失败|崩溃|超时)\s*[。！.]?$/.test(
      normalized,
    )
  );
}

function looksLikeCssRule(value: string): boolean {
  const open = value.indexOf("{");
  if (open <= 0 || open > 256) return false;
  const colon = value.indexOf(":", open + 1);
  if (colon < 0) return false;
  const close = value.indexOf("}", colon + 1);
  if (close < 0) return false;
  return /^[.#]?[A-Za-z][\w.#:[\]="'" -]*$/.test(
    value.slice(0, open).trim(),
  );
}

function looksLikeSqlStatement(value: string): boolean {
  const identifier = String.raw`[A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)?`;
  const selectItem = String.raw`(?:${identifier}|[A-Za-z_][\w$]*\s*\([^)]*\)|\*)`;
  return (
    new RegExp(
      `^select\\s+${selectItem}(?:\\s*,\\s*${selectItem})*(?:\\s+as\\s+${identifier})?\\s+from\\s+${identifier}(?:\\s+(?:where|join|left\\s+join|right\\s+join|inner\\s+join|group\\s+by|order\\s+by|limit)\\b.*)?\\s*;?$`,
      "i",
    ).test(value) ||
    new RegExp(
      `^insert\\s+into\\s+${identifier}(?:\\s*\\([^)]*\\))?\\s+(?:values\\b|select\\b).+;?$`,
      "i",
    ).test(value) ||
    new RegExp(
      `^update\\s+${identifier}\\s+set\\s+${identifier}\\s*=.+(?:\\s+where\\b.+)?;?$`,
      "i",
    ).test(value) ||
    new RegExp(
      `^delete\\s+from\\s+${identifier}(?:\\s+where\\b.+)?\\s*;?$`,
      "i",
    ).test(value) ||
    new RegExp(
      `^(?:create\\s+(?:table|index|view|schema)|alter\\s+table|drop\\s+(?:table|index|view|schema))\\s+${identifier}\\b.*;?$`,
      "i",
    ).test(value) ||
    new RegExp(`^with\\s+${identifier}\\s+as\\s*\\(`, "i").test(value)
  );
}

function looksLikeImportStatement(value: string): boolean {
  const moduleName = String.raw`[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*`;
  const importedName = String.raw`[A-Za-z_$][\w$]*`;
  return (
    new RegExp(
      `^import\\s+${moduleName}(?:\\s+as\\s+${importedName})?(?:\\s*,\\s*${moduleName}(?:\\s+as\\s+${importedName})?)*\\s*;?$`,
    ).test(value) ||
    new RegExp(
      `^from\\s+${moduleName}\\s+import\\s+(?:\\*|${importedName}(?:\\s+as\\s+${importedName})?(?:\\s*,\\s*${importedName}(?:\\s+as\\s+${importedName})?)*)\\s*;?$`,
    ).test(value) ||
    /^import\s+(?:["'][^"']+["']|(?:[\w$*{},\s]+)\s+from\s+["'][^"']+["'])\s*;?$/.test(
      value,
    )
  );
}

function sourceLineScore(line: string): number {
  const value = line.trim();
  if (!value) return 0;

  // SQL assignments often use log-like column names (status/level/message).
  // Recognize the statement before applying the structured-log exclusion.
  if (looksLikeSqlStatement(value)) return 3;
  if (isStructuredLogLine(value)) return 0;

  if (
    /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function(?:\s+[A-Za-z_$][\w$]*)?\s*\(/.test(
      value,
    ) ||
    /^(?:export\s+)?(?:default\s+)?class\s+(?:[A-Z_$][\w$]*|[A-Za-z_$][\w$]*\s+(?:extends|implements)\b)/.test(
      value,
    ) ||
    /^(?:export\s+)?interface\s+(?:[A-Z_$][\w$]*\b|[a-z_$][\w$]*\s+(?:extends\b[^{]+)?\{)/.test(
      value,
    ) ||
    /^(?:export\s+)?type\s+[A-Za-z_$][\w$]*\s*=/.test(value) ||
    /^(?:export\s+)?enum\s+[A-Za-z_$][\w$]*\s*\{/.test(value) ||
    /^(?:export\s+)?(?:const|let|var)\s+[A-Za-z_$][\w$]*(?:\s*[:=])/.test(
      value,
    ) ||
    /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*(?::=|=(?!=))\s*(?:["'`[{(]|\d|true\b|false\b|null\b|undefined\b|new\b|[A-Za-z_$][\w$]*\s*[.([])/.test(
      value,
    ) ||
    /^(?:return\s+(?!to\b)(?:[45]\d\d\b|new\s+(?:error\b|[A-Za-z_$][\w$]*exception\b)|["'[{(]|(?:true|false|null|undefined)\b|[A-Za-z_$][\w$]*(?:\s*[.([]|\s*;))|throw\s+(?:new\s+)?(?:error\b|[A-Za-z_$][\w$]*exception\b)).*;?$/i.test(
      value,
    ) ||
    looksLikeImportStatement(value) ||
    /^(?:def\s+\w+\s*\(|class\s+\w+.*:)/.test(value) ||
    /^(?:pub\s+)?(?:async\s+)?fn\s+\w+\s*\(|^(?:pub\s+)?(?:struct|enum|impl|trait)\b/.test(
      value,
    ) ||
    /^package\s+[A-Za-z_][\w]*\s*;?$/.test(value) ||
    /^func\s+[A-Za-z_][\w]*\s*\(/.test(value) ||
    /^type\s+[A-Za-z_][\w]*\s+struct\b/.test(value) ||
    /^(?:package|import|public|private|protected|static|final)\b.*(?:class|interface|void|String|int|long|boolean)\b/.test(
      value,
    ) ||
    /^fun\s+[A-Za-z_][\w]*\s*\(/.test(value) ||
    /^(?:val|var)\s+[A-Za-z_][\w]*\s*(?::|=)/.test(value) ||
    /^(?:data\s+class|sealed\s+class)\s+[A-Za-z_][\w]*/.test(value) ||
    /^object\s+(?:[A-Z_][\w]*\b|[a-z_][\w]*\s*\{)/.test(value) ||
    /^#\s*!\/(?:usr\/)?bin\/(?:env\s+)?(?:ba)?sh\b/.test(value) ||
    /^<[A-Za-z][^>]*>/.test(value) ||
    /^(?:template\s*)?<[^>]+>|^<\/[A-Za-z][^>]*>/.test(value) ||
    looksLikeCssRule(value) ||
    /^(?:unsigned\s+|signed\s+)?(?:void|int|char|float|double|long|short|bool|auto)\s+\w+\s*\([^;]*\)\s*\{?/.test(
      value,
    ) ||
    /^(?:(?:public|private|protected|static|final)\s+)*(?:void|int|long|boolean|String|[A-Za-z_$][\w$]*)\s+[A-Za-z_$][\w$]*\s*\([^)]*\)\s+throws\s+[A-Za-z_$][\w$]*Exception\b/.test(
      value,
    )
  ) {
    return 3;
  }

  if (
    /(?:=>|::|:=|\breturn\b|\bawait\b|\byield\b)/.test(value) ||
    /^(?:echo|printf|mkdir|touch|chmod|cp|mv|rm|curl|wget|grep|sed|awk|export|source|cd)\s+\S+/.test(
      value,
    ) ||
    /^(?:for|while|case|if)\b.*(?:;|\||\$|\bdo\b|\bthen\b)/.test(value) ||
    /^[\w.-]+\s*:\s*(?:\d|true\b|false\b|null\b|["'[{])/.test(value) ||
    /^(?:padding|margin|display|color|background|grid|flex|font-size|border)\s*:/.test(
      value,
    )
  ) {
    return 1;
  }
  return 0;
}

function sourceSyntaxStats(raw: string): { score: number; strongLines: number } {
  const lines = raw.split(/\r?\n/).filter((line) => line.trim());
  let score = 0;
  let strongLines = 0;
  for (const line of lines) {
    const lineScore = sourceLineScore(line);
    score += lineScore;
    if (lineScore >= 3) strongLines++;
  }
  return { score, strongLines };
}

function hasSourcePaste(rawText: string): boolean {
  const raw = rawText || "";
  const fences = [
    ...raw.matchAll(/```([a-z0-9_+#.-]*)[^\S\r\n]*\r?\n([\s\S]*?)```/gi),
  ];
  if (fences.length > 0) {
    const codeFenceLanguage =
      /^(?:js|jsx|ts|tsx|javascript|typescript|python|py|rust|rs|go|golang|sql|kotlin|kt|java|c|cpp|c\+\+|csharp|cs|shell|sh|bash|zsh|html|xml|css|scss|sass|less|vue|svelte|php|ruby|rb|swift|scala|json|ya?ml)$/i;
    for (const fence of fences) {
      const language = fence[1] || "";
      const body = fence[2] || "";
      if (looksLikeStructuredLogPaste(body)) continue;
      if (codeFenceLanguage.test(language)) return true;
      const stats = sourceSyntaxStats(body);
      if (stats.strongLines >= 1 || stats.score >= 6) return true;
    }
    return false;
  }

  const { score, strongLines } = sourceSyntaxStats(raw);
  if (strongLines >= 1 || score >= 6) return true;
  if (raw.includes("\n")) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed !== null && typeof parsed === "object") return true;
    } catch {
      // Not a single JSON document.
    }
  }
  return false;
}

/**
 * Replaces fenced source with spaces while preserving newlines and offsets.
 * This keeps source literals out of failure analysis without hiding prose
 * before or after the fence.
 */
export function maskFencedSourceForFailureAnalysis(rawText: string): string {
  return (rawText || "").replace(
    /```([a-z0-9_+#.-]*)[^\S\r\n]*\r?\n([\s\S]*?)```/gi,
    (full, language: string, body: string) => {
      const codeFenceLanguage =
        /^(?:js|jsx|ts|tsx|javascript|typescript|python|py|rust|rs|go|golang|sql|kotlin|kt|java|c|cpp|c\+\+|csharp|cs|shell|sh|bash|zsh|html|xml|css|scss|sass|less|vue|svelte|php|ruby|rb|swift|scala|json|ya?ml)$/i;
      const stats = sourceSyntaxStats(body);
      const isSource =
        codeFenceLanguage.test(language) ||
        (!looksLikeStructuredLogPaste(body) &&
          (stats.strongLines >= 1 || stats.score >= 6));
      return isSource ? full.replace(/[^\r\n]/g, " ") : full;
    },
  );
}

export function collectContentRouteEvidence(
  rawText: string,
): ContentRouteEvidence {
  const raw = rawText || "";
  const normalized = normalize(raw);
  const reasons = {
    code: [] as string[],
    writing: [] as string[],
    logs: [] as string[],
  };

  const fileRef = CODE_FILE_REFERENCE.test(raw);
  const sourcePaste = hasSourcePaste(raw);
  const writingTask = hasWritingTask(normalized);
  const analysisTask = hasLogAnalysisTask(normalized);
  const instrumentationTask = hasLogInstrumentationTask(normalized);
  const stats = structuredLogStats(raw);
  const structuredPaste =
    looksLikeStructuredLogPaste(raw) ||
    (analysisTask && stats.hasStructuredLine);
  let explicitCode = hasCodeActionTarget(normalized);
  if (isCompletedResolvedFailureStatement(normalized)) explicitCode = false;
  const writingScopedLogging =
    writingTask &&
    instrumentationTask &&
    (WRITING_SCOPED_LOGGING_TARGET.test(normalized) ||
      LOGGING_DOCUMENTATION_TARGET.test(normalized));
  if (writingScopedLogging) explicitCode = false;

  // Configuration/instrumentation remains code work even if a later clause
  // asks to inspect the resulting logs. Merely printing existing logs does not.
  const configuresInstrumentation =
    new RegExp(
      `\\b(?:add|enable|configure|set\\s*up|setup|emit|inject|instrument|create)\\b(?:(?!\\b${EN_WRITING_ARTIFACT_SOURCE}\\b).){0,40}\\b(?:audit\\s+)?(?:logs?|logging)\\b`,
      "i",
    ).test(normalized) ||
    /(?:增加|添加|开启|启用|配置|注入|埋点|输出|写入).{0,20}(?:日志|审计日志)/.test(
      normalized,
    );
  if (
    instrumentationTask &&
    !writingScopedLogging &&
    (!analysisTask || configuresInstrumentation)
  ) {
    explicitCode = true;
  }

  if (fileRef) reasons.code.push("code_file_reference");
  if (explicitCode) reasons.code.push("code_action_target");
  if (sourcePaste) reasons.code.push("code_source_syntax");
  if (instrumentationTask) reasons.logs.push("log_instrumentation_action");
  if (analysisTask) reasons.logs.push("log_analysis_action");
  if (structuredPaste) reasons.logs.push("structured_log_paste");
  if (writingTask) reasons.writing.push("writing_action_target");

  return {
    code: {
      explicitTask: explicitCode,
      fileRef,
      sourcePaste,
      score: (explicitCode ? 4 : 0) + (fileRef ? 5 : 0) + (sourcePaste ? 3 : 0),
      reasons: unique(reasons.code),
    },
    writing: {
      explicitTask: writingTask,
      score: writingTask ? 4 : 0,
      reasons: unique(reasons.writing),
    },
    logs: {
      analysisTask,
      instrumentationTask,
      structuredPaste,
      score: (analysisTask ? 4 : 0) + (structuredPaste ? 3 : 0),
      reasons: unique(reasons.logs),
    },
    oversized: raw.length > 4000,
  };
}

/**
 * Deterministic arbitration after vision/debug/agentic guards.
 * Explicit specialized work wins over payload shape; input length is fallback.
 */
export function resolveContentRoute(
  evidence: ContentRouteEvidence,
  utteranceTaskType?: ContentUtteranceTaskType | null,
): ResolvedContentRoute | null {
  if (evidence.code.explicitTask) {
    return { taskType: "code", reason: "content_code_explicit" };
  }
  if (evidence.code.fileRef) {
    return { taskType: "code", reason: "content_code_file_ref" };
  }
  if (evidence.writing.explicitTask) {
    return { taskType: "writing", reason: "content_writing_explicit" };
  }
  if (evidence.code.sourcePaste) {
    return { taskType: "code", reason: "content_code_source_paste" };
  }
  if (evidence.logs.analysisTask) {
    return { taskType: "long_context", reason: "content_log_analysis" };
  }
  if (evidence.logs.structuredPaste) {
    return { taskType: "long_context", reason: "content_structured_log_paste" };
  }
  if (utteranceTaskType === "code") {
    return { taskType: "code", reason: "content_utterance_code" };
  }
  if (utteranceTaskType === "writing") {
    return { taskType: "writing", reason: "content_utterance_writing" };
  }
  if (utteranceTaskType === "long_context") {
    return {
      taskType: "long_context",
      reason: "content_utterance_long_context",
    };
  }
  if (evidence.oversized) {
    return { taskType: "long_context", reason: "content_large_input" };
  }
  return null;
}
