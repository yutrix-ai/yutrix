/**
 * Aurelio-style short route utterances for strategy task classification.
 * Signal helpers are pure and shared by strategy + intent paths.
 */
import utterancesJson from "./strategyRouteUtterances.json";

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
];

type UtteranceMap = Record<string, string[]>;
const RAW = utterancesJson as UtteranceMap;

function norm(s: string): string {
  return (s || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

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

/** Known product/tool brands (global replace-safe). */
export const KNOWN_BUG_BRAND =
  /\bbug[-_]?(?:analyzer|locator|snag|tracker|bot|finder)\b|\bbug\s+(?:analyzer|locator|snag|tracker|bot|finder)\b/gi;

function stripKnownBugBrands(n: string): string {
  return n
    .replace(KNOWN_BUG_BRAND, " ")
    .replace(/\bbug(?=定位|分析|助手|工具|系统)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasKnownBugBrand(n: string): boolean {
  KNOWN_BUG_BRAND.lastIndex = 0;
  return KNOWN_BUG_BRAND.test(n) || /\bbug(?=定位|分析|助手|工具|系统)/.test(n);
}

/** Strip design handling phrases so live clauses can still be detected. */
export function stripDesignHandlingPhrases(normalizedInput: string): string {
  return norm(normalizedInput)
    .replace(/\b(with\s+)?(timeout|error|exception|failure)\s+handling\b/g, " ")
    .replace(/\bneed\s+(timeout|error|exception|failure)\s+handling\b/g, " ")
    .replace(/\bbug\s*fix(?:es|ing)?\b/g, " ")
    .replace(/\brelease notes\b/g, " ")
    .replace(/超时处理|错误处理|异常处理|失败重试/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Strong code-development intent (file paths, implement, dense source).
 * Used so long_context does not steal code tasks.
 */
export function hasStrongCodeDevIntent(normalizedInput: string, rawText?: string): boolean {
  const n = norm(normalizedInput);
  const raw = rawText || n;
  if (!n) return false;
  if (/\bsrc[/\\]|\.(tsx?|jsx?|vue|java|py|go|rs)\b/.test(n)) return true;
  if (/\b(implement|refactor|write a (?:unit )?test|add a (?:method|function|component))\b/.test(n)) {
    return true;
  }
  if (/实现|重构|写一个|新增.*功能|封装/.test(n) && /接口|组件|函数|样式|页面|api|css/.test(n)) {
    return true;
  }
  // Dense TS/JS source paste
  const codeTokens = (raw.match(/\b(const|function|class|import|export|return|=>)\b/g) || []).length;
  if (codeTokens >= 8 || (raw.length > 2000 && codeTokens >= 3)) return true;
  if (/\blog handling\b|\bmigration in\b|\bstorage api\b/.test(n) && /\b(src[/\\]|implement|fix)\b/.test(n)) {
    return true;
  }
  return false;
}

/** Live breakage (runtime / ops), not design-spec themes alone. */
export function hasLiveBreakageSignal(normalizedInput: string): boolean {
  const n = norm(normalizedInput);
  if (!n) return false;

  // Exception classes: XException, IOException (one+ prefix chars). Not bare "exception".
  const exceptionClass = /\b[a-z0-9_]+exception\b/.test(n);
  const exceptionLivePhrase =
    /\b(throws?|throwing|unhandled|uncaught)\b.{0,16}\bexception\b/.test(n) ||
    /\bexception\b.{0,10}(at\s|:\s*\d|thrown|raised)/.test(n);
  const exceptionDevFraming =
    /\b(write|document|unit\s*tests?|test for|mock|stub|catch\s*\(|handle)\b.{0,48}\b[a-z0-9_]*exception\b/.test(
      n,
    ) ||
    /\b[a-z0-9_]*exception\b.{0,24}\b(behavior|unit\s*test|documentation)\b/.test(n);

  if ((exceptionClass || exceptionLivePhrase) && !exceptionDevFraming) return true;

  if (
    /\b(stack\s*trace|stacktrace|traceback|panic|crashes?|crashed|crashing)\b/.test(n) ||
    /\b(typeerror|referenceerror|syntaxerror|rangeerror|nullpointerexception|systemerror)\b/.test(n) ||
    /\b(not working|doesn't work|does not work|still not working|is not working|aren't working|is broken|stopped working|won't start|will not start)\b/.test(
      n,
    ) ||
    /\b(keeps? timing out|timing out|timed out|times out)\b/.test(n) ||
    /\breturns?\s*(?:a\s+)?(?:5\d\d|500|502|503|504)\b|\bhttp\s*5\d\d\b/.test(n) ||
    /\b(failed to|failure to|build failed|execution failed|applicationcontext failed)\b/.test(n) ||
    /\bcode["\s:=]+404\b|\b"code"\s*:\s*404\b/.test(n) ||
    /\bthrows?\s+(an?\s+)?error\b|\berror\s+(was\s+)?thrown\b/.test(n) ||
    /\breport(s|ed|ing)?\s+(an?\s+)?error\b|\berror\s+occurred\b/.test(n)
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
    /不能(?:编辑|修改|点击|选择|保存|提交|获取|显示|展示)|无法(?:编辑|修改|点击|选择|保存|提交|获取|显示|展示)/.test(
      n,
    ) ||
    (/(不存在|无效)/.test(n) && !/当.+不存在|若不存在|is not found|when .+ not found/.test(n))
  ) {
    return true;
  }

  // UI layout: only with fault tone, not "add scrollbar / support overlap / CSS overflow example"
  if (/滚动条|盖住|溢出|重叠|遮挡|错位/.test(n)) {
    if (/(加|添加|支持|写|实现|示例|布局).{0,10}(滚动条|溢出|重叠|遮挡|错位)/.test(n)) {
      return false;
    }
    if (/(还是|出现|盖住|错误|问题|bug|报|不|没|了)/.test(n)) return true;
    // production path + layout fault token
    if (/\.(vue|tsx?|jsx?)\b/.test(n)) return true;
    return false;
  }

  return false;
}

/** Design / feature-spec prose that mentions failure themes without an independent live clause. */
export function isDesignSpecFailureTheme(normalizedInput: string): boolean {
  const n = norm(normalizedInput);
  if (!n) return false;
  const remainder = stripDesignHandlingPhrases(n);
  // Independent live clause after stripping handling → not pure design-spec
  if (hasLiveBreakageSignal(remainder) || hasIntentBugToken(remainder)) return false;

  return (
    /\b(with\s+)?(timeout|error|exception|failure)\s+handling\b/.test(n) ||
    /\bneed\s+(timeout|error|exception|failure)\s+handling\b/.test(n) ||
    /\bbug\s*fix\b|\bfix notes\b|\brelease notes\b/.test(n) ||
    /\breturn\s+\d{3}\s+when\b|\bwhen the .+ is not found\b|\bif .+ not found\b/.test(n) ||
    /超时处理|错误处理|异常处理|失败重试|返回\s*\d{3}|当.+不存在|若不存在/.test(n) ||
    /\bimplement\b.+\b(timeout|error|failure|exception)\b.+\b(handling|support|retry)\b/.test(n) ||
    /实现.+(超时|错误|失败|异常).*(处理|支持|重试)/.test(n) ||
    /\b(write|document|unit\s*tests?|test for)\b.{0,40}\b[a-z0-9_]*exception\b/.test(n)
  );
}

/**
 * Explicit failure for routing. Design-spec spans do not mask independent live clauses.
 */
export function hasExplicitFailureSignal(normalizedInput: string): boolean {
  const n = norm(normalizedInput);
  if (!n) return false;

  const remainder = stripDesignHandlingPhrases(n);
  if (hasLiveBreakageSignal(remainder) || hasIntentBugToken(remainder)) return true;
  // Full-text live breakage only when not pure design-spec
  if (hasLiveBreakageSignal(n) && !isDesignSpecFailureTheme(n)) return true;
  if (hasIntentBugToken(n) && !isDesignSpecFailureTheme(n)) return true;

  if (/报错|崩溃|异常堆栈|请求失败|上传失败|编译失败|连接失败/.test(n) || /失败了|失败：|失败:/.test(n)) {
    if (!/异常处理|失败重试/.test(n) || hasLiveBreakageSignal(remainder)) return true;
  }

  return false;
}

/** Narrow Chinese short-phrase aliases (not unrestricted contains). */
export function matchShortCnTaskAlias(normalizedInput: string): UtteranceMatch | null {
  const n = norm(normalizedInput);
  if (!n) return null;

  // Vision: natural short look-at-image phrases
  if (
    /^(看一下|看下|看看)?这[张幅]图$/.test(n) ||
    /^(看一下|看下|看看)这[张幅]图[吗么]?$/.test(n) ||
    /^你能看到图片吗$/.test(n)
  ) {
    return { taskType: "vision", utterance: n, score: 900, reason: "alias_vision_short" };
  }

  // Debug: bare stack phrases only (not "新增堆栈信息展示功能")
  if (/^(堆栈信息|异常堆栈|堆栈如下)$/.test(n)) {
    return { taskType: "debug", utterance: n, score: 900, reason: "alias_debug_short" };
  }

  // Long context: short log-locate phrases
  if (/^从日志里定位问题$|^从日志中定位问题$|^看一下服务日志$/.test(n)) {
    return { taskType: "long_context", utterance: n, score: 900, reason: "alias_long_context_short" };
  }

  return null;
}

/**
 * Match utterances: exact, or forward contains for longer anchors.
 * Short CJK anchors (len<=6) are exact-only; use matchShortCnTaskAlias for variants.
 */
export function matchStrategyUtterance(normalizedInput: string): UtteranceMatch | null {
  const text = norm(normalizedInput);
  if (!text) return null;

  const shortAlias = matchShortCnTaskAlias(text);
  if (shortAlias) return shortAlias;

  let best: UtteranceMatch | null = null;

  for (const taskType of TASK_ORDER) {
    const list = STRATEGY_ROUTE_UTTERANCES[taskType] || [];
    for (const utt of list) {
      if (!utt || utt.length < 2) continue;
      let score = 0;
      if (text === utt) {
        score = 1000 + utt.length;
      } else if (text.includes(utt) && utt.length >= 2) {
        // Short CJK: exact only (prevents 堆栈信息 inside feature requests)
        if (isPrimarilyCjk(utt) && utt.length <= 6) continue;
        if (utt.length === 2 && !/[\u4e00-\u9fff]{2}/.test(utt)) continue;
        if (!isPrimarilyCjk(utt) && utt.length < 4) continue;
        if (taskType === "long_context" && utt.length < 6) continue;
        if (!isPrimarilyCjk(utt) && !/\s/.test(utt) && utt.length < 12) {
          if (!/^[a-z0-9.+_-]{8,}$/i.test(utt)) continue;
        }
        // Feature framing should not hit debug/vision short-ish anchors via contains
        if (
          taskType === "debug" &&
          /(新增|添加|实现|展示功能|功能|单元测试|文档)/.test(text) &&
          utt.length <= 10
        ) {
          continue;
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

  if (!best || best.score < 50) return null;
  return best;
}

export function hasBugTicketToken(normalizedInput: string): boolean {
  return /\bbugs?[-_ ]?\d+\b/i.test(norm(normalizedInput));
}

/**
 * Known bug brands without live failure/debug-work verbs → product mention
 * (no marketing phrase required).
 */
export function isProductStyleBugMention(normalizedInput: string): boolean {
  const n = norm(normalizedInput);
  if (!n) return false;
  if (hasLiveBreakageSignal(n)) return false;
  if (hasBugTicketToken(n)) return false;
  if (/\b(fix|investigate|resolve|repair|debug)\b/.test(n) && (hasKnownBugBrand(n) || /\bbugs?\b/.test(n))) {
    return false;
  }
  if (!hasKnownBugBrand(n)) return false;
  // Brand present, no fix/live failure → treat as product (intro, configure, compare)
  return true;
}

/**
 * Debug-relevant bug token: tickets, plural bugs, hyphen work; not product brands alone.
 */
export function hasIntentBugToken(normalizedInput: string): boolean {
  const n = norm(normalizedInput);
  if (hasBugTicketToken(n)) return true;

  // Explicit work on bugs/bug (singular or plural)
  if (
    /\b(fix|investigate|resolve|repair|debug)\b.{0,28}\bbugs?\b|\bbugs?\b.{0,28}\b(fix|investigate|resolve|repair)\b/.test(
      n,
    )
  ) {
    return true;
  }
  if (/\b(?:security|critical|production|urgent)[-_]?bugs?\b|\bbugs?[-_]?(?:report|fix|hunt)\b/.test(n)) {
    return true;
  }
  // Plural bare "bugs" with work verbs already covered; also "these bugs" / "production bugs"
  if (/\b(these|those|the|production|critical)\s+bugs\b/.test(n)) return true;

  if (isProductStyleBugMention(n)) return false;

  const stripped = stripKnownBugBrands(n);
  return /\bbugs?\b/.test(stripped);
}

/**
 * True log/transcript analysis (not instrumentation, not substring false positives).
 */
export function hasLongContextLogAnalyzeSignal(normalizedInput: string): boolean {
  const n = norm(normalizedInput);
  if (!n) return false;

  // Primary action is add/enable logging — not long_context
  if (
    /^(please\s+)?(add|enable|print|inject)\b.{0,24}\b(?:log(?:ging)?|logs)\b/.test(n) ||
    /\breview and add\b.{0,16}\b(?:log(?:ging)?|logs)\b/.test(n) ||
    /(?:增加|添加|加点|开启|启用|写入).{0,12}(?:日志|logging)/.test(n) ||
    /\benable\s+audit\s+logging\b/.test(n) ||
    (/console\.log/.test(n) && !/\b(analyze|summarize|inspect|review)\b.{0,20}\b(?:log|logs)\b/.test(n))
  ) {
    return false;
  }

  // English analyze verbs with FULL word boundaries (avoid preview→review, thread→read)
  const enVerb = String.raw`\b(?:analyze|read|summarize|inspect|review)\b`;
  const logWord = String.raw`(?:\blog\b|\blogs\b)`;
  const zhVerb = String.raw`(?:解析|分析|查看|阅读|梳理|总结|看一下|看下|定位)`;
  const zhLog = String.raw`(?:日志|审计日志|长日志|长文本)`;

  if (new RegExp(`${enVerb}.{0,28}${logWord}`).test(n)) return true;
  if (new RegExp(`${logWord}.{0,20}${enVerb}`).test(n)) return true;
  // ZH verbs may pair with EN log tokens ("帮我查看这段 log")
  if (new RegExp(`${zhVerb}.{0,24}(?:${zhLog}|${logWord}|\\baudit\\b)`).test(n)) return true;
  if (new RegExp(`(?:${zhLog}|${logWord}).{0,16}(?:${zhVerb}|线索|问题)`).test(n)) return true;

  if (/\b(audit\s+log|transcript)\b|审计日志|长文本|长日志/.test(n)) {
    // not bare "migration" alone as code task
    if (!/\bmigration in\b|\.ts\b|\.js\b/.test(n)) return true;
  }
  if (/数据库迁移|迁移脚本/.test(n) && !/\bsrc[/\\]|\.ts\b/.test(n)) return true;

  if (new RegExp(`${enVerb}.{0,20}\\baudit\\b`).test(n)) return true;
  if (new RegExp(`${zhVerb}.{0,20}\\baudit\\b`).test(n)) return true;

  // Tech logs: analyze nginx/docker/git/api logs
  if (
    new RegExp(
      `${enVerb}.{0,24}\\b(?:nginx|docker|git|api|server|application|access|error)\\b.{0,12}${logWord}`,
    ).test(n) ||
    (new RegExp(
      `\\b(?:nginx|docker|git|api|server|application|access|error)\\b.{0,10}${logWord}`,
    ).test(n) &&
      new RegExp(enVerb).test(n))
  ) {
    return true;
  }

  return false;
}

/** Continuation / agentic packaging (skipAgentic suppresses code/long from these alone). */
export function isAgenticProtocolPayload(text: string, truncatedRaw: string): boolean {
  const raw = truncatedRaw || "";
  const n = norm(text + " " + raw.slice(0, 2500));
  return (
    /tool_result|tool_use|role["\s]*:["\s]*tool|system-reminder|system_reminder|qqrrrrqqquuuuqqq|vvxxxxvvvddddvvv/.test(
      n,
    ) ||
    /\[request interrupted/i.test(raw) ||
    /web page content\s*:/i.test(raw) ||
    /base directory for this skill/i.test(raw) ||
    /\[\{"role":"tool"/.test(raw) ||
    /"type"\s*:\s*"tool_result"/.test(raw) ||
    /<path>.*<\/path>/.test(n) ||
    (/transcript/i.test(n) && /system-reminder|tool_result|skill/i.test(n))
  );
}
