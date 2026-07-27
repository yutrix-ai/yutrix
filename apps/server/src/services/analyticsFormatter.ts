export function maskApiKey(key: string | null | undefined): string {
  if (!key) return "";
  const dots = "••••••••••••";
  if (key.startsWith("sk-proj-")) {
    if (key.length > 14) {
      const prefix = key.slice(0, 12);
      const suffix = key.slice(-4);
      return prefix + dots + suffix;
    }
    return "sk-proj-" + dots;
  }
  if (key.startsWith("sk-")) {
    if (key.length > 14) {
      const prefix = key.slice(0, 7);
      const suffix = key.slice(-4);
      return prefix + dots + suffix;
    }
    return "sk-" + dots;
  }
  if (key.length > 8) {
    const prefix = key.slice(0, 4);
    const suffix = key.slice(-4);
    return prefix + dots + suffix;
  }
  return dots;
}
