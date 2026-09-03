export const API_BASE = "/api";

export function getAuthToken(): string | null {
  return localStorage.getItem("token") || sessionStorage.getItem("token");
}

/**
 * Returns request headers with the Authorization Bearer header attached if a JWT token
 * is present in localStorage or sessionStorage.
 *
 * NOTE for SSE (Server-Sent Events):
 * When running behind Docker or reverse proxies, httpOnly session cookies are frequently
 * missing, stripped, or blocked. Native browser EventSource cannot send custom headers
 * (like Authorization: Bearer <token>), which causes SSE endpoints to return 401 Unauthorized
 * while regular API fetch calls succeed. SSE clients must use fetchEventSource with Bearer auth headers.
 */
export function getAuthHeaders(customHeaders?: Record<string, string>): Record<string, string> {
  const token = getAuthToken();
  const headers: Record<string, string> = { ...(customHeaders || {}) };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  return headers;
}

export async function fetchApi(endpoint: string, options: RequestInit = {}) {
  const headers: Record<string, string> = {
    ...((options.headers as Record<string, string>) || {}),
  };

  if (options.body !== undefined) {
    if (!headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }
  }

  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers: getAuthHeaders(headers),
  });

  if (!response.ok) {
    let errorMsg = "An error occurred";
    try {
      const data = await response.json();
      if (data.details && Array.isArray(data.details)) {
        errorMsg = (data.error || "错误") + ": " + data.details.map((d: any) => d.message).join("；");
      } else {
        errorMsg = data.error || errorMsg;
      }
    } catch (e) {
      // Ignored
    }
    if (response.status === 401 || response.status === 403) {
      if (endpoint !== "/auth/login" && endpoint !== "/auth/me") {
        localStorage.removeItem("token");
        sessionStorage.removeItem("token");
        window.location.href = "/login";
      }
    }
    throw new Error(errorMsg);
  }

  return response.json();
}
