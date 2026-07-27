export const API_BASE = "/api";

export async function fetchApi(endpoint: string, options: RequestInit = {}) {
  const token = localStorage.getItem("token") || sessionStorage.getItem("token");
  const headers: Record<string, string> = {
    ...((options.headers as Record<string, string>) || {}),
  };

  if (options.body !== undefined) {
    if (!headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }
  }

  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers,
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
