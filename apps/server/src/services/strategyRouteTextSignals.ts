/**
 * Shared lexical sources for clause-aware strategy routing.
 *
 * Keep inflection-heavy action vocabularies here so debug, writing, log, and
 * bug analyzers do not silently diverge as new forms are added.
 */

export const EN_DIAGNOSTIC_ACTION_SOURCE = String.raw`(?:fix(?:es|ed|ing)?|debug(?:s|ged|ging)?|investigat(?:e[sd]?|ing)|diagnos(?:e[sd]?|ing)|troubleshoot(?:s|ed|ing)?|resolv(?:e[sd]?|ing)|repair(?:s|ed|ing)?|triag(?:e[sd]?|ing)|reproduc(?:e[sd]?|ing)|address(?:es|ed|ing)?)`;

export const EN_LOG_ANALYSIS_ACTION_SOURCE = String.raw`(?:analy(?:ze[sd]?|zing)|analys(?:e[sd]?|ing)|read(?:s|ing)?|summari[sz](?:e[sd]?|ing)|inspect(?:s|ed|ing)?|review(?:s|ed|ing)?|check(?:s|ed|ing)?|find(?:s|ing)?|found|pars(?:e[sd]?|ing)|search(?:es|ed|ing)?|examin(?:e[sd]?|ing)|grep(?:s|ped|ping)?|scan(?:s|ned|ning)?|correlat(?:e[sd]?|ing)|investigat(?:e[sd]?|ing)|trac(?:e[sd]?|ing)|look(?:s|ed|ing)?\s+(?:through|at)|go(?:es|went|ing)?\s+through|quer(?:y|ies|ied|ying)|tail(?:s|ed|ing)?|filter(?:s|ed|ing)?|extract(?:s|ed|ing)?)`;

export const EN_WRITING_ACTION_SOURCE = String.raw`(?:writ(?:e|es|ing|ten)|wrote|draft(?:s|ed|ing)?|creat(?:e[sd]?|ing)|updat(?:e[sd]?|ing)|rewrit(?:e|es|ing|ten)|rewrote|revis(?:e[sd]?|ing)|author(?:s|ed|ing)?|publish(?:es|ed|ing)?|outlin(?:e[sd]?|ing)|polish(?:es|ed|ing)?|edit(?:s|ed|ing)?|proofread(?:s|ing)?|translat(?:e[sd]?|ing)|compos(?:e[sd]?|ing)|prepar(?:e[sd]?|ing)|produc(?:e[sd]?|ing)|review(?:s|ed|ing)?|document(?:s|ed|ing)?|summari[sz](?:e[sd]?|ing)|describ(?:e[sd]?|ing)|explain(?:s|ed|ing)?)`;

export const EN_META_WRITING_ACTION_SOURCE = String.raw`(?:rewrit(?:e|es|ing|ten)|rewrote|polish(?:es|ed|ing)?|translat(?:e[sd]?|ing)|document(?:s|ed|ing)?|summari[sz](?:e[sd]?|ing)|describ(?:e[sd]?|ing)|explain(?:s|ed|ing)?)`;

export const EN_WRITING_ARTIFACT_SOURCE = String.raw`(?:articles?|emails?|stories?|copy|blog\s+posts?|postmortems?|biograph(?:y|ies)|release\s+notes?|changelogs?|essays?|documentation|docs?|readmes?|descriptions?|summar(?:y|ies)|overviews?|memos?|notes?|proposals?|reports?|guides?|tutorials?|manuals?)`;

export function hasDiagnosticAction(text: string): boolean {
  return (
    new RegExp(`\\b${EN_DIAGNOSTIC_ACTION_SOURCE}\\b`, "i").test(text) ||
    /排查|定位|调试|修复|解决|诊断|复现/.test(text)
  );
}

export function hasDiagnosticQuestion(text: string): boolean {
  return /\bwhy\b|为什么|为何/.test(text);
}

export function hasLogAnalysisAction(text: string): boolean {
  return new RegExp(`\\b${EN_LOG_ANALYSIS_ACTION_SOURCE}\\b`, "i").test(text);
}
