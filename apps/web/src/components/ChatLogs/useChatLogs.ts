import { useState, useEffect, useRef, useMemo } from "react";
import { fetchApi, API_BASE } from "@/lib/api";
import { toast } from "sonner";
import { normalizeInputMessages, getContentText } from "./ChatLogUtils";

import { useTranslation } from "react-i18next";
import { useTimeRange } from "@/contexts/TimeRangeContext";
import { useAuth } from "@/lib/store";
import { useSettings } from "@/contexts/SettingsContext";

export function useChatLogs() {
  const { t } = useTranslation();
  const { timeRange, customStart, customEnd, timeRangeQuery } = useTimeRange();
  const { user } = useAuth();
  const { formatDateTime } = useSettings();
  
  const [sessions, setSessions] = useState<any[]>([]);
  const [sessionTurns, setSessionTurns] = useState<any[]>([]);
  const [liveTurns, setLiveTurns] = useState<any[]>([]);
  
  const [filterUserId, setFilterUserId] = useState("");
  const [filterModel, setFilterModel] = useState("");
  
  const [availableUsers, setAvailableUsers] = useState<{id: string, username: string}[]>([]);
  const [availableModels, setAvailableModels] = useState<string[]>([]);

  const [selectedSessionId, setSelectedSessionId] = useState<string | "LIVE">("LIVE");
  const [selectedTurnId, setSelectedTurnId] = useState<string | null>(null);

  const [isStreaming, setIsStreaming] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);

  const [showRawInput, setShowRawInput] = useState(false);
  const [showRawOutput, setShowRawOutput] = useState(false);
  const [, setTick] = useState(0);

  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);

  const [hoveredTurnIndex, setHoveredTurnIndex] = useState<number | null>(null);
  const turnRefs = useRef<Record<string, HTMLElement | null>>({});
  const conversationScrollRef = useRef<HTMLDivElement | null>(null);
  const [turnPositions, setTurnPositions] = useState<Record<string, number>>({});
  const [scrollContainerStats, setScrollContainerStats] = useState({ scrollHeight: 1, clientHeight: 1 });
  const [activeTurnIndex, setActiveTurnIndex] = useState<number>(0);
  
  const [autoScrollEnabled, setAutoScrollEnabled] = useState(() => {
    try {
      const stored = localStorage.getItem("promptgate_audit_autoscroll");
      if (stored !== null) return JSON.parse(stored);
    } catch { }
    return true;
  });

  useEffect(() => {
    localStorage.setItem("promptgate_audit_autoscroll", JSON.stringify(autoScrollEnabled));
  }, [autoScrollEnabled]);

  const scrollPositionsRef = useRef<Record<string, number>>((() => {
    try {
      const stored = localStorage.getItem("promptgate_audit_scroll_positions");
      if (stored) return JSON.parse(stored);
    } catch { }
    return {};
  })());



  const handleCacheResponse = async (turn: any) => {
    const token = localStorage.getItem("token") || sessionStorage.getItem("token");
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers["Authorization"] = `Bearer ${token}`;

    try {
      const res = await fetch(`${API_BASE}/admin/cache`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          inputText: turn.inputText,
          responseText: turn.outputText,
          model: turn.model,
          sourceLogId: turn.id,
        }),
      });

      if (res.ok) {
        toast.success(t("responseCache.cacheSuccess", "已添加到缓存"));
        return;
      }

      if (res.status === 409) {
        const data = await res.json();
        const confirmed = window.confirm(t("responseCache.cacheExists", "该输入已存在缓存，是否覆盖？"));
        if (confirmed && data.existing?.id) {
          const patchRes = await fetch(`${API_BASE}/admin/cache/${data.existing.id}`, {
            method: "PATCH",
            headers,
            body: JSON.stringify({
              responseText: turn.outputText,
              model: turn.model,
              sourceLogId: turn.id,
            }),
          });
          if (patchRes.ok) {
            toast.success(t("responseCache.overwriteSuccess", "缓存已覆盖"));
          } else {
            const errData = await patchRes.json().catch(() => ({}));
            toast.error(errData.error || "Failed to overwrite cache");
          }
        }
        return;
      }

      const errData = await res.json().catch(() => ({}));
      toast.error(errData.error || "Failed to cache response");
    } catch (e: any) {
      toast.error(e.message || "Failed to cache response");
    }
  };

  useEffect(() => {
    const timer = setInterval(() => {
      setTick((t) => t + 1);
    }, 10000);
    return () => clearInterval(timer);
  }, []);

  const filterUserIdRef = useRef(filterUserId);
  const filterModelRef = useRef(filterModel);
  const selectedSessionIdRef = useRef(selectedSessionId);
  const autoScrollEnabledRef = useRef(autoScrollEnabled);

  useEffect(() => {
    filterUserIdRef.current = filterUserId;
  }, [filterUserId]);

  useEffect(() => {
    filterModelRef.current = filterModel;
  }, [filterModel]);

  useEffect(() => {
    selectedSessionIdRef.current = selectedSessionId;
  }, [selectedSessionId]);

  useEffect(() => {
    autoScrollEnabledRef.current = autoScrollEnabled;
  }, [autoScrollEnabled]);

  useEffect(() => {
    setShowRawInput(false);
    setShowRawOutput(false);
  }, [selectedTurnId]);

  useEffect(() => {
    fetchDistinctFilters();
  }, []);

  useEffect(() => {
    setPage(1);
    fetchSessions(1, false);
  }, [timeRangeQuery]);

  useEffect(() => {
    if (selectedSessionId === "LIVE") {
      fetchLiveTurns();
      startStreaming();
    } else {
      stopStreaming();
      fetchSessionTurns(selectedSessionId);
    }
    return () => stopStreaming();
  }, [selectedSessionId]);

  const fetchDistinctFilters = async () => {
    try {
      const [usersRes, modelsRes] = await Promise.all([
        fetchApi("/admin/chat-logs/users") as Promise<{ data: {id: string, username: string}[] }>,
        fetchApi("/admin/chat-logs/models") as Promise<{ data: string[] }>,
      ]);
      setAvailableUsers(usersRes.data || []);
      setAvailableModels(modelsRes.data || []);
    } catch (e) {
      console.error("Failed to load filters");
    }
  };

  const fetchSessions = async (pageToLoad = 1, append = false) => {
    try {
      const url = new URL("/admin/chat-logs/sessions", window.location.origin);
      if (timeRange === "custom") {
        url.searchParams.set("timeRange", "custom");
        if (customStart) url.searchParams.set("startDate", customStart.toISOString());
        if (customEnd) url.searchParams.set("endDate", customEnd.toISOString());
      } else {
        url.searchParams.set("timeRange", timeRange);
      }
      url.searchParams.set("page", pageToLoad.toString());
      url.searchParams.set("limit", "20");
      if (filterUserId) url.searchParams.set("userId", filterUserId);
      if (filterModel) url.searchParams.set("model", filterModel);
      
      const data = (await fetchApi(url.pathname + url.search)) as { data: any[], pagination: any };
      
      if (append) {
        setSessions(prev => [...prev, ...(data.data || [])]);
      } else {
        setSessions(data.data || []);
      }

      if (typeof data.pagination?.hasMore === "boolean") {
        setHasMore(data.pagination.hasMore);
      } else if (data.pagination) {
        setHasMore(data.pagination.page < data.pagination.totalPages);
      } else {
        setHasMore((data.data || []).length === 20);
      }
    } catch (e) {
      toast.error(t("chatLogs.loadSessionFailed", "加载会话列表失败"));
    }
  };

  const fetchLiveTurns = async () => {
    try {
      const url = new URL("/admin/chat-logs/requests", window.location.origin);
      url.searchParams.set("limit", "50");
      if (timeRange === "custom") {
        url.searchParams.set("timeRange", "custom");
        if (customStart) url.searchParams.set("startDate", customStart.toISOString());
        if (customEnd) url.searchParams.set("endDate", customEnd.toISOString());
      } else {
        url.searchParams.set("timeRange", timeRange);
      }
      if (filterUserId) url.searchParams.set("userId", filterUserId);
      if (filterModel) url.searchParams.set("model", filterModel);
      
      const res = (await fetchApi(url.pathname + url.search)) as { data: any[] };
      if (res.data) {
        setLiveTurns(res.data);
      }
    } catch (e) {
      console.error("Failed to load initial live turns", e);
    }
  };

  const handleScroll = async (e: React.UIEvent<HTMLDivElement>) => {
    const { scrollTop, scrollHeight, clientHeight } = e.currentTarget;
    if (scrollHeight - scrollTop <= clientHeight + 50 && hasMore && !isLoadingMore) {
      setIsLoadingMore(true);
      const nextPage = page + 1;
      setPage(nextPage);
      await fetchSessions(nextPage, true);
      setIsLoadingMore(false);
    }
  };

  const fetchSessionTurns = async (sessionId: string) => {
    try {
      const data = (await fetchApi(`/admin/chat-logs/sessions/${sessionId}/turns`)) as { data: any[] };
      const turns = data.data || [];
      setSessionTurns(turns);
      setSelectedTurnId(null);
      
      // Handle scrolling based on auto-scroll state or restored position
      setTimeout(() => {
        if (conversationScrollRef.current) {
          const savedPosition = scrollPositionsRef.current[sessionId];
          if (autoScrollEnabledRef.current) {
            // Auto-scroll ON: scroll to bottom
            if (turns.length > 0) {
              const lastFilteredTurn = [...turns].reverse().find(turn => {
                const messages = normalizeInputMessages(turn.inputText);
                return messages.some((m: any) => m.role === "user" && getContentText(m.content).trim() !== "");
              });
              scrollToTurn(lastFilteredTurn ? lastFilteredTurn.id : turns[turns.length - 1].id);
            }
          } else if (savedPosition !== undefined) {
            // Auto-scroll OFF but has saved position: restore it
            conversationScrollRef.current.scrollTop = savedPosition;
          } else {
            // Auto-scroll OFF, no saved position: go to top
            conversationScrollRef.current.scrollTop = 0;
          }
        }
      }, 50);
    } catch (e) {
      toast.error(t("chatLogs.loadDetailsFailed", "加载会话详情失败"));
    }
  };

  const startStreaming = () => {
    stopStreaming();
    const eventSource = new EventSource("/api/admin/chat-logs/stream", { withCredentials: true });
    
    eventSource.addEventListener("chatLog", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data);
        
        // Use refs for latest filter state
        const currentFilterUserId = filterUserIdRef.current;
        const currentFilterModel = filterModelRef.current;
        if (currentFilterUserId && data.userId !== currentFilterUserId) return;
        if (currentFilterModel && !data.model?.includes(currentFilterModel)) return;
        
        // Add to live turns
        setLiveTurns((prev) => [data, ...prev].slice(0, 500));

        // If viewing this session, append to sessionTurns
        const currentSelectedSessionId = selectedSessionIdRef.current;
        if (currentSelectedSessionId !== "LIVE" && data.serverSessionId === currentSelectedSessionId) {
          setSessionTurns((prev) => [...prev, data]);
        }

        // Update sessions list dynamically
        setSessions((prevSessions) => {
          const sessionIndex = prevSessions.findIndex(s => s.serverSessionId === data.serverSessionId);
          if (sessionIndex > -1) {
            const updatedSessions = [...prevSessions];
            const session = { ...updatedSessions[sessionIndex] };
            session.turnCount = (session.turnCount || 0) + 1;
            session.inputTokens = (session.inputTokens || 0) + (data.inputTokens || 0);
            session.outputTokens = (session.outputTokens || 0) + (data.outputTokens || 0);
            session.lastUpdatedAt = data.createdAt || new Date().toISOString();
            
            // Move to top
            updatedSessions.splice(sessionIndex, 1);
            updatedSessions.unshift(session);
            return updatedSessions;
          } else {
            const newSession = {
              serverSessionId: data.serverSessionId,
              clientSessionId: data.clientSessionId,
              userId: data.userId,
              clientName: data.clientName,
              detectedClient: data.detectedClient,
              model: data.model,
              turnCount: 1,
              inputTokens: data.inputTokens || 0,
              outputTokens: data.outputTokens || 0,
              firstInputText: data.inputText,
              firstCreatedAt: data.createdAt || new Date().toISOString(),
              lastUpdatedAt: data.createdAt || new Date().toISOString()
            };
            return [newSession, ...prevSessions];
          }
        });
      } catch (e) {
        console.error("Error parsing chat log EventSource data:", e);
      }
    });

    eventSource.addEventListener("sessionMerged", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data);
        setSessions((prevSessions) => {
          const oldIndex = prevSessions.findIndex(s => s.serverSessionId === data.oldSessionId);
          const newIndex = prevSessions.findIndex(s => s.serverSessionId === data.newSessionId);
          
          let updated = [...prevSessions];
          
          if (oldIndex > -1 && newIndex > -1) {
            // Merge old into new
            const newSession = { ...updated[newIndex] };
            const oldSession = updated[oldIndex];
            newSession.turnCount = (newSession.turnCount || 0) + (oldSession.turnCount || 0);
            newSession.inputTokens = (newSession.inputTokens || 0) + (oldSession.inputTokens || 0);
            newSession.outputTokens = (newSession.outputTokens || 0) + (oldSession.outputTokens || 0);
            newSession.lastUpdatedAt = data.createdAt || new Date().toISOString();
            
            // Remove old session from the list
            updated.splice(oldIndex, 1);
            
            // Move the combined new session to top
            const finalNewIndex = updated.findIndex(s => s.serverSessionId === data.newSessionId);
            if (finalNewIndex > -1) {
              updated.splice(finalNewIndex, 1);
            }
            updated.unshift(newSession);
          } else if (oldIndex > -1) {
            // The new parent session is not loaded, just update the ID of the old one
            const session = { ...updated[oldIndex] };
            session.serverSessionId = data.newSessionId;
            updated[oldIndex] = session;
          }
          
          return updated;
        });

        // Also update the selectedSessionId if we are currently viewing the old session
        if (selectedSessionIdRef.current === data.oldSessionId) {
          setSelectedSessionId(data.newSessionId);
        }
      } catch (e) {
        console.error("Error parsing sessionMerged SSE data:", e);
      }
    });

    eventSource.addEventListener("sessionTitleUpdate", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data);
        setSessions((prevSessions) => {
          return prevSessions.map((s) => {
            if (s.serverSessionId === data.serverSessionId) {
              return {
                ...s,
                sessionTitle: data.sessionTitle
              };
            }
            return s;
          });
        });
      } catch (e) {
        console.error("Error parsing sessionTitleUpdate SSE data:", e);
      }
    });

    eventSource.onerror = () => {
      setIsStreaming(false);
      eventSource.close();
    };

    eventSourceRef.current = eventSource;
    setIsStreaming(true);
  };

  const stopStreaming = () => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    setIsStreaming(false);
  };

  const displayedTurns = useMemo(() => selectedSessionId === "LIVE" ? liveTurns : sessionTurns, [selectedSessionId, liveTurns, sessionTurns]);
  
  const filteredTurns = useMemo(() => {
    return displayedTurns
      .map((turn, index) => ({ turn, originalIndex: index }))
      .filter(({ turn }) => {
        const messages = normalizeInputMessages(turn.inputText);
        return messages.some(m => m.role === "user" && getContentText(m.content).trim() !== "");
      });
  }, [displayedTurns]);

  const selectedTurn = useMemo(() => displayedTurns.find(t => t.id === selectedTurnId), [displayedTurns, selectedTurnId]);
  
  const selectedSession = useMemo(() => selectedSessionId === "LIVE" ? null : sessions.find(s => s.serverSessionId === selectedSessionId), [selectedSessionId, sessions]);
  
  const isLiveMode = selectedSessionId === "LIVE" && !selectedTurn;
  const isConversationView = !isLiveMode && !selectedTurn && displayedTurns.length > 0;
  const recalculatePositions = () => {
    const container = conversationScrollRef.current;
    if (!container) return;

    const containerRect = container.getBoundingClientRect();
    const containerScrollHeight = container.scrollHeight;
    const containerClientHeight = container.clientHeight;

    const positions: Record<string, number> = {};
    filteredTurns.forEach(({ turn }) => {
      const el = turnRefs.current[turn.id];
      if (el) {
        const elRect = el.getBoundingClientRect();
        const y_turn = elRect.top - containerRect.top + container.scrollTop;
        positions[turn.id] = y_turn;
      }
    });

    setTurnPositions(positions);
    setScrollContainerStats({
      scrollHeight: containerScrollHeight || 1,
      clientHeight: containerClientHeight || 1,
    });
  };

  const updateActiveTurnIndex = () => {
    const container = conversationScrollRef.current;
    if (!container || filteredTurns.length === 0) return;

    // If container is not scrollable, do not overwrite the active index via scroll position
    if (container.scrollHeight <= container.clientHeight + 10) {
      return;
    }

    // 1. Check if scrolled near the bottom
    const isAtBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 25;
    if (isAtBottom) {
      setActiveTurnIndex(filteredTurns.length - 1);
      return;
    }

    // 2. Scroll-spy boundary
    const containerRect = container.getBoundingClientRect();
    const triggerY = container.scrollTop + 100; // 100px threshold from top of viewport

    let activeIdx = 0;
    for (let i = 0; i < filteredTurns.length; i++) {
      const { turn } = filteredTurns[i];
      const el = turnRefs.current[turn.id];
      if (el) {
        const elRect = el.getBoundingClientRect();
        const y_turn = elRect.top - containerRect.top + container.scrollTop;
        if (y_turn <= triggerY) {
          activeIdx = i;
        } else {
          break;
        }
      }
    }

    setActiveTurnIndex(activeIdx);
  };

  useEffect(() => {
    const container = conversationScrollRef.current;
    if (!container || !isConversationView) return;

    recalculatePositions();
    updateActiveTurnIndex();

    const observer = new ResizeObserver(() => {
      recalculatePositions();
      updateActiveTurnIndex();
    });

    observer.observe(container);
    if (container.firstElementChild) {
      observer.observe(container.firstElementChild);
    }

    filteredTurns.forEach(({ turn }) => {
      const el = turnRefs.current[turn.id];
      if (el) {
        observer.observe(el);
      }
    });

    return () => {
      observer.disconnect();
    };
  }, [filteredTurns, isConversationView, selectedSessionId]);

  const scrollToTurn = (turnId: string) => {
    const el = turnRefs.current[turnId];
    const container = conversationScrollRef.current;
    if (el && container) {
      const containerRect = container.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      const targetScrollTop = elRect.top - containerRect.top + container.scrollTop - 20;
      container.scrollTo({
        top: Math.max(0, targetScrollTop),
        behavior: 'smooth'
      });
    }
  };

  return {
    sessions, setSessions,
    sessionTurns, setSessionTurns,
    liveTurns, setLiveTurns,
    filterUserId, setFilterUserId,
    filterModel, setFilterModel,
    availableUsers, setAvailableUsers,
    availableModels, setAvailableModels,
    selectedSessionId, setSelectedSessionId,
    selectedTurnId, setSelectedTurnId,
    isStreaming, setIsStreaming,
    showRawInput, setShowRawInput,
    showRawOutput, setShowRawOutput,
    page, setPage,
    hasMore, setHasMore,
    isLoadingMore, setIsLoadingMore,
    hoveredTurnIndex, setHoveredTurnIndex,
    turnRefs,
    conversationScrollRef,
    turnPositions, setTurnPositions,
    scrollContainerStats, setScrollContainerStats,
    activeTurnIndex, setActiveTurnIndex,
    autoScrollEnabled, setAutoScrollEnabled,
    scrollPositionsRef,
    handleCacheResponse,
    fetchDistinctFilters,
    fetchSessions,
    fetchLiveTurns,
    handleScroll,
    fetchSessionTurns,
    startStreaming,
    stopStreaming,
    recalculatePositions,
    updateActiveTurnIndex,
    scrollToTurn,
    filterUserIdRef,
    filterModelRef,
    selectedSessionIdRef,
    autoScrollEnabledRef,
    displayedTurns,
    filteredTurns,
    selectedTurn,
    selectedSession,
    isLiveMode,
    isConversationView,
    t,
    formatDateTime,
    user
  };
}
