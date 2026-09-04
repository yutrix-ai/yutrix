/** Replace leftover i18next placeholders when a log param was omitted. */
export function replaceUninterpolatedI18nParams(text: unknown): string {
  return String(text ?? "").replace(/\{\{[^{}]+\}\}/g, "-");
}
