import i18next from "i18next";
import { replaceUninterpolatedI18nParams } from "./actionLogI18nFallback";

export { replaceUninterpolatedI18nParams };

export function renderActionLogLine(entry: any, showServerRaw: boolean = false): string {
  if (!entry) return "";

  if (showServerRaw) {
    return entry.serverLine || entry.line || JSON.stringify(entry);
  }
  
  if (entry.code) {
    const key = `logs.code.${entry.code}`;
    const result = replaceUninterpolatedI18nParams(String(i18next.t(key, entry.params || {})));
    // If it translated to something different, format it with level/timestamp
    if (result !== key && result !== undefined) {
      let levelText = entry.level;
      if (entry.level === "INFO") levelText = i18next.language.startsWith("zh") ? "信息" : "INFO";
      if (entry.level === "WARN") levelText = i18next.language.startsWith("zh") ? "警告" : "WARN";
      if (entry.level === "ERROR") levelText = i18next.language.startsWith("zh") ? "错误" : "ERROR";
      
      return `${entry.timestamp} ${levelText} ${result}`;
    }
  }

  // fallback to serverLine or legacy line
  const line = entry.serverLine || entry.line;
  if (line) {
    return line;
  }
  
  return JSON.stringify(entry);
}
