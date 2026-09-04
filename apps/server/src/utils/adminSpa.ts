export type AdminSpaGateInput = {
  hostname: string;
  adminHost?: string | null;
  routeHostnames: Iterable<string>;
};

/** Lowercase, trim, drop trailing dot and optional :port. */
export function normalizeHostname(value: string | null | undefined): string {
  let host = String(value ?? "").trim().toLowerCase();
  if (!host) return "";
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end >= 0 ? host.slice(0, end + 1) : host;
  }
  const colon = host.lastIndexOf(":");
  if (colon > 0 && /^\d+$/.test(host.slice(colon + 1))) {
    return host.slice(0, colon);
  }
  return host;
}

/**
 * Whether this Host may receive the admin console HTML shell.
 * Configured route hosts always win (never SPA), even if adminHost is mis-set equal.
 * Empty/unset adminHost: any non-route host is allowed (zero-config).
 */
export function shouldServeAdminSpa(input: AdminSpaGateInput): boolean {
  const host = normalizeHostname(input.hostname);
  const routes = new Set(
    [...input.routeHostnames].map(normalizeHostname).filter(Boolean),
  );
  if (host && routes.has(host)) return false;

  const admin = normalizeHostname(input.adminHost);
  if (!admin) return true;
  return host === admin;
}

/** Paths that must never fall through to index.html (gateway + admin API). */
export function isAdminSpaFallbackPath(url: string): boolean {
  const path = url.split("?")[0];
  return (
    !path.startsWith("/api/") &&
    !path.startsWith("/v1/") &&
    !path.startsWith("/v0/")
  );
}

export function isAdminSpaDocumentPath(url: string): boolean {
  const path = url.split("?")[0];
  return path === "/" || path === "/index.html";
}
