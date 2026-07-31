/**
 * Aurelio-style short route utterances + pure classification signal helpers.
 * Shared by classifyStrategyTask / classifyIntentTaskType.
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
  return (s || "").toLowerCase().replace(/\s+/g, " ").trim();
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

/** Known product/tool brands (always use global flag for multi-match strip). */
export const KNOWN_BUG_BRAND_SOURCE = String.raw`\bbug[-_]?(?:analyzer|locator|snag|tracker|bot|finder)\b|\bbug\s+(?:analyzer|locator|snag|tracker|bot|finder)\b`;

function knownBugBrandRe(): RegExp {
  return new RegExp(KNOWN_BUG_BRAND_SOURCE, "gi");
}

export function stripKnownBugBrands(n: string): string {
  return n
    .replace(knownBugBrandRe(), " ")
    .replace(/\bbug(?=定位|分析|助手|工具|系统)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasKnownBugBrand(n: string): boolean {
  return (
    knownBugBrandRe().test(n) || /\bbug(?=定位|分析|助手|工具|系统)/.test(n)
  );
}

/** Structured log-line paste (nginx/app logs), not source code. */
export function looksLikeStructuredLogPaste(raw: string): boolean {
  const t = raw || "";
  // key=value log fields
  const kv = (
    t.match(
      /\b(?:function|class|return|status|level|msg|message|request_id|trace_id)=/gi,
    ) || []
  ).length;
  if (kv >= 3) return true;
  // timestamp-heavy lines
  const ts = (t.match(/\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}/g) || []).length;
  if (ts >= 3 && t.length > 500) return true;
  return false;
}

/**
 * Strong code-development intent (file paths, tech implement, dense multi-lang source).
 * Excludes structured log pastes that only contain function=/class=/return=.
 */
export function hasStrongCodeDevIntent(
  normalizedInput: string,
  rawText?: string,
): boolean {
  const n = norm(normalizedInput);
  const raw = rawText || n;
  if (!n) return false;
  if (looksLikeStructuredLogPaste(raw)) return false;

  if (
    /\bsrc[/\\]|\.(tsx?|jsx?|vue|java|py|go|rs|sql|cpp|c|cs|rb|php|kt|swift)\b/.test(
      n,
    )
  ) {
    return true;
  }
  // implement only with tech adjacency
  if (
    /\bimplement\b.{0,40}\b(api|endpoint|parser|function|method|component|handler|service|module|interface|class|schema|migration|logger)\b/.test(
      n,
    ) ||
    /\b(api|endpoint|parser|function|component|service)\b.{0,40}\bimplement\b/.test(
      n,
    )
  ) {
    return true;
  }
  if (
    /\b(refactor|write a (?:unit )?test|add a (?:method|function|component))\b/.test(
      n,
    )
  ) {
    return true;
  }
  if (
    /实现|重构|写一个|新增.*功能|封装/.test(n) &&
    /接口|组件|函数|样式|页面|api|css|代码/.test(n)
  ) {
    return true;
  }

  // Dense multi-language source (not log kv lines)
  const codeTokens = (
    raw.match(
      /\b(const|let|var|function|class|import|export|return|def|fn|func|package|struct|impl|SELECT|INSERT|UPDATE|CREATE|FROM|WHERE|=>)\b/gi,
    ) || []
  ).length;
  const fence =
    /```/.test(raw) || /^(def |fn |func |package |SELECT )/m.test(raw);
  if (
    codeTokens >= 8 ||
    (raw.length > 2000 && codeTokens >= 4) ||
    (fence && codeTokens >= 3)
  ) {
    return true;
  }
  if (
    /\blog handling\b|\bmigration in\b|\bstorage api\b/.test(n) &&
    /\b(src[/\\]|implement|fix)\b/.test(n)
  ) {
    return true;
  }
  return false;
}

/** Writing intent strong enough to beat bare long_context nouns. */
export function hasStrongWritingIntent(normalizedInput: string): boolean {
  const n = norm(normalizedInput);
  return (
    /\b(write|rewrite|polish|translate|article|email|story|changelog|release notes|essay|biography)\b/.test(
      n,
    ) || /写作|润色|文案|文章|邮件|故事|翻译|发布说明|更新说明|传记/.test(n)
  );
}

/** Strip design handling phrases so live clauses can still be detected. */
export function stripDesignHandlingPhrases(normalizedInput: string): string {
  return norm(normalizedInput)
    .replace(/\b(with\s+)?(timeout|error|exception|failure)\s+handling\b/g, " ")
    .replace(/\bneed\s+(timeout|error|exception|failure)\s+handling\b/g, " ")
    .replace(/\bfailure\s+handling\b/g, " ")
    .replace(/\bbug\s*fix(?:es|ing)?\b/g, " ")
    .replace(/\brelease notes\b/g, " ")
    .replace(/超时处理|错误处理|异常处理|失败重试/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Live breakage (runtime / ops). */
export function hasLiveBreakageSignal(normalizedInput: string): boolean {
  const n = norm(normalizedInput);
  if (!n) return false;

  // Exception class with optional single-letter prefix; exclude dev framing
  const exceptionClass = /\b[a-z0-9_]+exception\b/.test(n);
  const exceptionLivePhrase =
    /\b(throws?|throwing|unhandled|uncaught)\b.{0,16}\bexception\b/.test(n) ||
    /\bexception\b.{0,10}(at\s|:\s*\d|thrown|raised)/.test(n);
  const exceptionDevFraming =
    /\b(write|document|unit\s*tests?|test for|mock|stub|catch|implement|rename|add documentation|handle)\b.{0,48}\b[a-z0-9_]*exception\b/.test(
      n,
    ) ||
    /\b[a-z0-9_]*exception\b.{0,32}\b(behavior|unit\s*test|documentation|handling|and retry)\b/.test(
      n,
    ) ||
    /\bcatch\s+[a-z0-9_]*exception\b/.test(n) ||
    /\bimplement\b.{0,24}\b[a-z0-9_]*exception\b.{0,16}\bhandling\b/.test(n);

  if ((exceptionClass || exceptionLivePhrase) && !exceptionDevFraming)
    return true;

  if (
    /\b(stack\s*trace|stacktrace|traceback|panic|crashes?|crashed|crashing)\b/.test(
      n,
    ) ||
    /\b(typeerror|referenceerror|syntaxerror|rangeerror|nullpointerexception|systemerror)\b/.test(
      n,
    ) ||
    /\b(not working|doesn't work|does not work|still not working|is not working|aren't working|is broken|stopped working|won't start|will not start|is failing|are failing)\b/.test(
      n,
    ) ||
    /\b(keeps? timing out|timing out|timed out|times out|time out|requests? time out)\b/.test(
      n,
    ) ||
    /\b(returns?|returned)\s*(?:a\s+)?(?:5\d\d|500|502|503|504)\b|\bhttp\s*5\d\d\b/.test(
      n,
    ) ||
    /\b(failed to|failure to|build failed|build fails|deployment failed|execution failed|applicationcontext failed|request failed)\b/.test(
      n,
    ) ||
    /\bcode["\s:=]+404\b|\b"code"\s*:\s*404\b/.test(n) ||
    /\bthrows?\s+(an?\s+)?error\b|\berror\s+(was\s+)?thrown\b/.test(n) ||
    /\berror\s+occurred\b|\bshows?\s+an?\s+error\b|\bhas\s+an?\s+error\b/.test(
      n,
    )
  ) {
    // Spec: "report an error when ..." is design, not live
    if (/\breport(s|ed|ing)?\s+(an?\s+)?error\s+when\b/.test(n)) return false;
    if (/\bto report an?\s+error\s+when\b/.test(n)) return false;
    return true;
  }

  // ZH feature framing: 新增报错/异常/堆栈…功能 — not live breakage
  if (
    /(新增|添加|实现).{0,12}(报错|异常|堆栈).{0,12}(提示|展示|功能)/.test(n)
  ) {
    return false;
  }
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
    /还是失败|仍然失败|请求还是失败|部署失败|失败了/.test(n) ||
    (/(不存在|无效)/.test(n) &&
      !/当.+不存在|若不存在|is not found|when .+ not found|token is invalid/.test(
        n,
      ))
  ) {
    return true;
  }

  // UI layout: feature verbs don't short-circuit the whole sentence; re-check fault clauses
  if (/滚动条|盖住|溢出|重叠|遮挡|错位/.test(n)) {
    // Pure feature / placement specs
    if (
      /^(?=.*(加|添加|支持|写|示例|布局|放在|需求)).*(滚动条|溢出|重叠)/.test(
        n,
      ) &&
      !/(还是|仍然|又|再次|出现).{0,8}(错位|溢出|重叠|遮挡|盖住)/.test(n)
    ) {
      // "需求定了，滚动条放在右边" — 了 is not fault tone
      if (
        /(放在|加一个|支持|示例|布局)/.test(n) &&
        !/(还是|仍然|错位|盖住|bug|报错)/.test(n)
      ) {
        return false;
      }
    }
    // Fault after feature: 实现溢出处理后页面还是错位
    if (/(还是|仍然|又|再次).{0,12}(错位|溢出|重叠|遮挡|盖住|不)/.test(n))
      return true;
    if (/(出现|盖住).{0,8}(溢出|重叠|遮挡|滚动)/.test(n)) return true;
    // production path + layout fault
    if (/\.(vue|tsx?|jsx?)\b/.test(n) && /(溢出|错位|遮挡|盖住)/.test(n))
      return true;
    return false;
  }

  return false;
}

/** Design / feature-spec prose without an independent live clause. */
export function isDesignSpecFailureTheme(normalizedInput: string): boolean {
  const n = norm(normalizedInput);
  if (!n) return false;
  const remainder = stripDesignHandlingPhrases(n);
  if (hasLiveBreakageSignal(remainder)) return false;
  // residual bug work after strip (not brand)
  if (hasIntentBugToken(remainder) && !hasKnownBugBrand(n)) return false;

  return (
    /\b(with\s+)?(timeout|error|exception|failure)\s+handling\b/.test(n) ||
    /\bneed\s+(timeout|error|exception|failure)\s+handling\b/.test(n) ||
    /\bbug\s*fix\b|\bfix notes\b|\brelease notes\b/.test(n) ||
    /\breturn\s+\d{3}\s+when\b|\bwhen the .+ is not found\b|\bif .+ not found\b|\bwhen the token is invalid\b/.test(
      n,
    ) ||
    /超时处理|错误处理|异常处理|失败重试|返回\s*\d{3}|当.+不存在|若不存在/.test(
      n,
    ) ||
    /\bimplement\b.+\b(timeout|error|failure|exception)\b.+\b(handling|support|retry)\b/.test(
      n,
    ) ||
    /\bimplement the api to report an error when\b/.test(n) ||
    /实现.+(超时|错误|失败|异常).*(处理|支持|重试)/.test(n) ||
    /\b(write|document|unit\s*tests?|test for)\b.{0,40}\b[a-z0-9_]*exception\b/.test(
      n,
    ) ||
    /\bwrite (?:an )?article about\b|\bcharacter biography\b/.test(n)
  );
}

/**
 * Explicit failure for routing. Design spans stripped first; residual live wins.
 * Brand product mode does NOT suppress independent non-brand failure on full text.
 */
export function hasExplicitFailureSignal(normalizedInput: string): boolean {
  const n = norm(normalizedInput);
  if (!n) return false;

  const remainder = stripDesignHandlingPhrases(n);
  // Residual after stripping handling phrases
  if (hasLiveBreakageSignal(remainder)) return true;
  // Bug tokens on remainder (brands stripped inside hasIntentBugToken)
  if (hasIntentBugToken(remainder)) return true;

  // Full-text live (e.g. brand + "shows an error") — always check live on full string
  if (hasLiveBreakageSignal(n)) return true;

  // ZH residual failure after 失败重试 strip
  if (/还是失败|仍然失败|请求还是失败|部署失败|失败了|还是报错/.test(n))
    return true;

  // Bug work: fix/investigate bugs — not "bug fix" inside release notes / writing
  if (
    /\b(fix|investigate|resolve|repair|debug)\b.{0,28}\bbugs?\b/.test(n) &&
    !/\brelease notes\b|\bwrite\b.{0,20}\b(article|notes|biography)\b/.test(n)
  ) {
    return true;
  }
  if (/\bfix\b.{0,16}\bbugs?\b.{0,16}\b(in|on)\b/.test(n)) return true;
  if (hasBugTicketToken(n)) return true;

  // Brand-only product talk without live failure → not debug
  if (isProductStyleBugMention(n) && !hasLiveBreakageSignal(n)) {
    // Independent failure after brand strip
    const stripped = stripKnownBugBrands(n);
    if (hasLiveBreakageSignal(stripped)) return true;
    if (
      /\b(has a bug|has bugs|shows? an? error|is failing|are failing)\b/.test(n)
    )
      return true;
    return false;
  }

  if (hasIntentBugToken(n) && !isDesignSpecFailureTheme(n)) return true;

  return false;
}

/** Controlled CN short aliases with polite prefix / punctuation / short tail. */
export function matchShortCnTaskAlias(
  normalizedInput: string,
): UtteranceMatch | null {
  const n = norm(normalizedInput);
  if (!n) return null;
  // Feature framing is a code/spec request, never a pasted-stack alias.
  if (
    /(?:新增|增加|添加|加|实现|开发|支持|配置|设计).{0,16}(?:堆栈|调用栈|异常栈|报错|异常).{0,16}(?:功能|展示|提示|监控|告警|上报)/.test(
      n,
    )
  ) {
    return null;
  }

  const soft = n.replace(/[。！？.!?]+$/g, "").trim();

  // Natural image requests tolerate polite prefixes and diagnostic tails.
  if (
    /^(?:(?:请|麻烦|劳驾)(?:你)?|(?:能|可以)否?(?:麻烦)?|能不能)?(?:帮我)?(?:看|看下|看一下|看看|分析|识别)(?:一下)?(?:这|那)(?:张|幅|个)?(?:图|图片|截图|照片)(?:的)?(?:(?:布局|内容|文字)(?:和(?:布局|内容|文字))*|哪里有问题|有什么问题|怎么了)?(?:吗|么)?$/.test(
      soft,
    ) ||
    /^(?:你)?能看到(?:这)?(?:张|幅)?(?:图|图片|截图|照片)吗$/.test(soft)
  ) {
    return {
      taskType: "vision",
      utterance: soft,
      score: 900,
      reason: "alias_vision_short",
    };
  }

  // Stack pastes may be long and may use either a colon or a comma.
  const stackText = soft.replace(
    /^(?:请|麻烦)?(?:帮我)?(?:看下|看一下|看看|分析)?/,
    "",
  );
  if (/^(?:堆栈|调用栈|异常栈|堆栈信息)(?:如下)?$/.test(stackText)) {
    return {
      taskType: "debug",
      utterance: soft,
      score: 900,
      reason: "alias_debug_short",
    };
  }
  if (
    /^(?:堆栈|调用栈|异常栈|堆栈信息)(?:如下)?[：:，,]\s*.+/.test(stackText) &&
    !/功能|展示|新增|增加|添加|实现|开发/.test(stackText)
  ) {
    return {
      taskType: "debug",
      utterance: soft,
      score: 880,
      reason: "alias_debug_stack_tail",
    };
  }

  if (/^从日志[里中]定位问题$|^看一下服务日志$/.test(soft)) {
    return {
      taskType: "long_context",
      utterance: soft,
      score: 900,
      reason: "alias_long_context_short",
    };
  }

  return null;
}

export function matchStrategyUtterance(
  normalizedInput: string,
): UtteranceMatch | null {
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
        if (isPrimarilyCjk(utt) && utt.length <= 6) continue;
        if (utt.length === 2 && !/[\u4e00-\u9fff]{2}/.test(utt)) continue;
        if (!isPrimarilyCjk(utt) && utt.length < 4) continue;
        if (taskType === "long_context" && utt.length < 8) continue;
        // long_context utterances must not win when code/writing intent present
        if (
          taskType === "long_context" &&
          (hasStrongCodeDevIntent(text) || hasStrongWritingIntent(text))
        ) {
          continue;
        }
        if (!isPrimarilyCjk(utt) && !/\s/.test(utt) && utt.length < 12) {
          if (!/^[a-z0-9.+_-]{8,}$/i.test(utt)) continue;
        }
        if (
          taskType === "debug" &&
          /(新增|添加|实现|展示功能|功能|单元测试|文档|文章|传记)/.test(text) &&
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
 * Known bug brand as product mention only when no independent live failure
 * remains after brand strip.
 */
export function isProductStyleBugMention(normalizedInput: string): boolean {
  const n = norm(normalizedInput);
  if (!n) return false;
  if (!hasKnownBugBrand(n)) return false;
  if (hasBugTicketToken(n)) return false;
  // Independent live failure on brand-stripped text → not pure product
  const stripped = stripKnownBugBrands(n);
  if (hasLiveBreakageSignal(stripped)) return false;
  if (
    /\b(has a bug|has bugs|shows? an? error|is failing|are failing)\b/.test(n)
  )
    return false;
  if (
    /\b(fix|investigate|resolve|repair|debug)\b/.test(n) &&
    /\bbugs?\b/.test(stripped)
  ) {
    return false;
  }
  // Brand present, residual has no live failure → product
  return true;
}

/**
 * Debug-relevant bug token with work/fault context — not bare "bugs" in writing.
 */
export function hasIntentBugToken(normalizedInput: string): boolean {
  const n = norm(normalizedInput);
  if (hasBugTicketToken(n)) return true;

  // Writing / release notes / biography about bugs — not debug work
  if (
    /\b(write|article|biography|essay|release notes|documentation)\b/.test(n) &&
    /\bbugs?\b/.test(n) &&
    !/\b(investigate|resolve|repair)\b/.test(n)
  ) {
    // "write release notes for this bug fix" is documentation, not live debug
    return false;
  }
  if (/\bbugs?\s+bunny\b|\babout software bugs\b/.test(n)) return false;

  // Explicit debug work: fix/investigate bugs (not "bug fix" inside release notes — already excluded)
  if (
    /\b(fix|investigate|resolve|repair|debug)\b.{0,28}\bbugs?\b/.test(n) ||
    (/\bbugs?\b.{0,28}\b(investigate|resolve|repair)\b/.test(n) &&
      !/\brelease notes\b|\bwrite\b/.test(n))
  ) {
    return true;
  }
  // "fix the bug in the parser" / "fix bugs in the parser"
  if (/\bfix\b.{0,20}\bbugs?\b.{0,20}\b(in|on|for)\b/.test(n)) return true;
  if (
    /\b(?:security|critical|production|urgent)[-_]?bugs?\b|\bbugs?[-_]?(?:report|fix|hunt)\b/.test(
      n,
    )
  ) {
    return true;
  }
  // "these/production bugs" only with resolve/fix/investigate already covered;
  // bare "the bugs" alone is not enough
  if (
    /\b(investigate|fix|resolve)\b.{0,16}\b(these|those|production|critical)\s+bugs\b/.test(
      n,
    )
  ) {
    return true;
  }
  if (
    /\b(these|those|production|critical)\s+bugs\b/.test(n) &&
    /\b(fix|investigate|resolve|repair)\b/.test(n)
  ) {
    return true;
  }

  if (isProductStyleBugMention(n)) {
    // After brand strip, residual independent bug work?
    const stripped = stripKnownBugBrands(n);
    if (/\b(has a bug|has bugs)\b/.test(n)) return true;
    if (/\bbugs?\b/.test(stripped) && /\b(fix|investigate|resolve)\b/.test(n))
      return true;
    return false;
  }

  const stripped = stripKnownBugBrands(n);
  // Standalone singular "bug" only with fault/work context, not bare word
  if (
    /\bbug\b/.test(stripped) &&
    /\b(fix|the bug|a bug|this bug|parser)\b/.test(n)
  )
    return true;
  if (
    /\bbugs\b/.test(stripped) &&
    /\b(fix|investigate|resolve|repair|these|production)\b/.test(n)
  ) {
    return true;
  }
  return false;
}

/**
 * True log analysis — requires analyze-family verbs; audit/transcript not bare nouns.
 */
export function hasLongContextLogAnalyzeSignal(
  normalizedInput: string,
): boolean {
  const n = norm(normalizedInput);
  if (!n) return false;

  // Strong code/writing steals — checked by caller too
  if (hasStrongCodeDevIntent(n) || hasStrongWritingIntent(n)) {
    // still allow pure "analyze nginx logs" without implement
    if (
      !/\b(analyze|check|find|parse|search|summarize|inspect|review)\b.{0,24}\b(?:log|logs)\b/.test(
        n,
      ) &&
      !/(分析|查看|检查).{0,12}日志/.test(n)
    ) {
      return false;
    }
    if (/\b(implement|build|src[/\\]|storage api|parser api)\b/.test(n))
      return false;
    if (/\bwrite an article\b|\btranslate\b/.test(n)) return false;
  }

  // Primary action instrumentation only at start / as main clause
  if (
    /^(please\s+)?(add|enable|inject)\b.{0,24}\b(?:log(?:ging)?|logs)\b/.test(
      n,
    ) ||
    /\breview and add\b.{0,16}\b(?:log(?:ging)?|logs)\b/.test(n) ||
    /(?:增加|添加|加点|开启|启用|写入).{0,12}(?:日志|logging)/.test(n) ||
    /\benable\s+audit\s+logging\b/.test(n)
  ) {
    return false;
  }
  // "print and analyze the logs" — print first but analyze present → allow if analyze logs
  // Only block pure print logs without analyze
  if (
    /\bprint\b.{0,24}\b(?:log|logs)\b/.test(n) &&
    !/\b(analyze|summarize|inspect|review|check|find|parse|search)\b/.test(n)
  ) {
    return false;
  }

  const enVerb = String.raw`\b(?:analyze|read|summarize|inspect|review|check|find|parse|search)\b`;
  const logWord = String.raw`(?:\blog\b|\blogs\b)`;
  const zhVerb = String.raw`(?:解析|分析|查看|阅读|梳理|总结|看一下|看下|定位|检查)`;
  const zhLog = String.raw`(?:日志|审计日志|长日志|长文本)`;

  // print and analyze the logs
  if (new RegExp(`\\bprint\\b.{0,16}${enVerb}.{0,20}${logWord}`).test(n))
    return true;
  if (new RegExp(`${enVerb}.{0,28}${logWord}`).test(n)) return true;
  if (new RegExp(`${logWord}.{0,20}${enVerb}`).test(n)) return true;
  if (new RegExp(`${zhVerb}.{0,24}(?:${zhLog}|${logWord}|\\baudit\\b)`).test(n))
    return true;
  if (
    new RegExp(`(?:${zhLog}|${logWord}).{0,16}(?:${zhVerb}|线索|问题)`).test(n)
  )
    return true;

  // find errors in nginx logs
  if (
    new RegExp(
      `${enVerb}.{0,20}\\berrors?\\b.{0,16}\\b(?:nginx|docker|git|api|server)\\b.{0,8}${logWord}`,
    ).test(n)
  ) {
    return true;
  }
  if (
    new RegExp(
      `${enVerb}.{0,16}\\b(?:nginx|docker|git|api|server|application|access)\\b.{0,10}${logWord}`,
    ).test(n)
  ) {
    return true;
  }
  if (
    new RegExp(
      `\\b(?:nginx|docker|git|api|server|application|access)\\b.{0,10}${logWord}`,
    ).test(n) &&
    new RegExp(enVerb).test(n)
  ) {
    return true;
  }

  // audit/transcript ONLY with analyze-family verbs (not bare nouns)
  if (
    new RegExp(`${enVerb}.{0,24}\\b(audit(?:\\s+log)?|transcript)\\b`).test(
      n,
    ) ||
    new RegExp(`${zhVerb}.{0,20}(审计日志|长文本|长日志)`).test(n)
  ) {
    if (
      !/\b(implement|build|write an article|storage api|parser api)\b/.test(n)
    )
      return true;
  }

  // Migration docs / scripts as long content (not src/file fix tasks)
  if (
    /数据库迁移|迁移脚本/.test(n) &&
    !/\bsrc[/\\]|\.ts\b|implement|fix\b/.test(n)
  ) {
    return true;
  }

  return false;
}

export function isAgenticProtocolPayload(
  text: string,
  truncatedRaw: string,
): boolean {
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
