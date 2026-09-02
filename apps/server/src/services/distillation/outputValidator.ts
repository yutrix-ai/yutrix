import {
  distillationRecordOutputSchema,
  type DistillationRecordOutput,
} from "@promptgate/shared";

const PATH_PATTERN = /(?:\/[\w.-]+){2,}|\\[\w.-\\]+/;
const URL_PATTERN = /https?:\/\/|www\./i;
const FILE_EXT_IN_CONTEXT =
  /\b[\w-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|vue|sql)\b/i;

/** CJK business-ish tokens when paired with domain verbs — heuristic guard. */
const BUSINESS_VERB_CJK =
  /(?:订单|支付|库存|会员|商品|客户|合同|审批|报销)/;

export function containsBusinessLeakage(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (PATH_PATTERN.test(t)) return true;
  if (URL_PATTERN.test(t)) return true;
  if (FILE_EXT_IN_CONTEXT.test(t)) return true;
  if (BUSINESS_VERB_CJK.test(t)) return true;
  return false;
}

export function validateDistillationOutput(
  raw: unknown,
): { ok: true; data: DistillationRecordOutput } | { ok: false; error: string } {
  const parsed = distillationRecordOutputSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.message };
  }
  const data = parsed.data;
  const lines = [
    ...data.skill.capability,
    ...data.skill.heuristic,
    ...data.skill.workflow,
    ...data.skill.persona,
    ...data.routing.adjustments.map((a) => `${a.reason} ${a.pattern ?? ""} ${a.token ?? ""}`),
  ];
  for (const line of lines) {
    if (containsBusinessLeakage(line)) {
      return { ok: false, error: `business_leakage: ${line.slice(0, 80)}` };
    }
  }
  return { ok: true, data };
}
