import { useEffect, useRef, useState, useCallback } from "react";
import { fetchEventSource } from "@microsoft/fetch-event-source";
import { useAuth } from "@/lib/store";
import { getAuthHeaders } from "@/lib/api";

export type SSEStatus = "connecting" | "connected" | "error" | "closed";

interface UseEventStreamOptions {
  url?: string;
  headers?: Record<string, string>;
  onMessage?: (event: string, data: any) => void;
  onConnected?: () => void;
  onError?: (err: any) => void;
}

export function useEventStream(options: UseEventStreamOptions = {}) {
  const { user } = useAuth();
  const [status, setStatus] = useState<SSEStatus>("closed");
  const abortControllerRef = useRef<AbortController | null>(null);
  
  // Keep refs for callbacks so we don't trigger reconnects when they change
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  }, [options]);

  const connect = useCallback(() => {
    if (!user) return; // Need auth
    if (abortControllerRef.current) return; // Already connecting/connected

    const ctrl = new AbortController();
    abortControllerRef.current = ctrl;
    setStatus("connecting");

    // fetch-event-source takes care of auto-reconnect on most errors.
    // SSE endpoints behind reverse proxies / Docker need Bearer authentication headers
    // and credentials: 'include' as session cookies are often omitted or stripped.
    const streamUrl = optionsRef.current.url || "/api/events/stream";
    void fetchEventSource(streamUrl, {
      method: "GET",
      headers: getAuthHeaders(optionsRef.current.headers),
      credentials: "include",
      openWhenHidden: true,
      signal: ctrl.signal,
      async onopen(response) {
        if (response.ok && response.headers.get("content-type")?.startsWith("text/event-stream")) {
          setStatus("connected");
          if (optionsRef.current.onConnected) optionsRef.current.onConnected();
        } else {
          // e.g. 401/403
          setStatus("error");
          throw new Error("Failed to connect to SSE stream");
        }
      },
      onmessage(msg) {
        if (msg.event === "ping" || msg.event === "connected") return;
        try {
          const data = msg.data ? JSON.parse(msg.data) : null;
          if (optionsRef.current.onMessage) {
            optionsRef.current.onMessage(msg.event, data);
          }
        } catch (e) {
          console.error("Failed to parse SSE message", e);
        }
      },
      onclose() {
        if (ctrl.signal.aborted) return;
        setStatus("connecting");
        throw new Error("SSE connection closed");
      },
      onerror(err) {
        if (ctrl.signal.aborted) return;
        console.error("SSE Error:", err);
        setStatus("error");
        if (optionsRef.current.onError) optionsRef.current.onError(err);
        return 3000;
      }
    }).catch((err) => {
      if (ctrl.signal.aborted) return;
      console.error("SSE connection stopped:", err);
      if (abortControllerRef.current === ctrl) {
        abortControllerRef.current = null;
      }
      setStatus("error");
      if (optionsRef.current.onError) optionsRef.current.onError(err);
    });

  }, [user]);

  const disconnect = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
      setStatus("closed");
    }
  }, []);

  useEffect(() => {
    if (user) {
      connect();
    } else {
      disconnect();
    }
    return () => {
      disconnect();
    };
  }, [user, connect, disconnect]);

  return { status, reconnect: connect, disconnect };
}
