import { useState, useEffect, useRef, useCallback } from "react";
import { fetchApi } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useTranslation } from "react-i18next";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/EmptyState";
import { useSettings } from "@/contexts/SettingsContext";
import { BarChart3 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Link } from "wouter";
import { toast } from "sonner";
import { useTimeRange } from "@/contexts/TimeRangeContext";
import { useEventStream } from "@/hooks/useEventStream";
import { StatsGrid, RecentLogs, ErrorDialog } from "@/components/MyStats/MyStatsComponents";

const PAGE_SIZE = 20;
const MAX_LOGS_IN_MEMORY = 500;

interface UsageStats {
  totalRequests: number;
  totalTokens: number;
  totalPromptTokens?: number;
  totalCompletionTokens?: number;
  totalCost?: number;
  successRate: number;
  errorCount: number;
  lastRequestAt: string | null;
  apiKeyUsage: ApiKeyUsage[];
  recentLogs: RequestLog[];
}

interface ApiKeyUsage {
  apiKeyId: string | null;
  apiKeyPrefix: string | null;
  apiKeyName: string | null;
  totalRequests: number;
  totalTokens: number;
  errorCount: number;
  lastRequestAt: string | null;
}

interface RequestLog {
  id: string;
  model: string;
  statusCode: number | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost?: number;
  latencyMs: number;
  apiKeyPrefix?: string | null;
  errorMessage?: string | null;
  createdAt: string;
  usageStatus?: string | null;
}

function mergeRequestLogs(current: RequestLog[], incoming: RequestLog[]) {
  if (incoming.length === 0) return current;

  const byId = new Map<string, RequestLog>();
  for (const log of current) {
    byId.set(log.id, log);
  }
  for (const log of incoming) {
    const existing = byId.get(log.id);
    byId.set(log.id, existing ? { ...existing, ...log } : log);
  }

  return Array.from(byId.values())
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, MAX_LOGS_IN_MEMORY);
}

export default function MyStats() {
  const { t } = useTranslation();
  const { timeRangeQuery } = useTimeRange();
  const { formatToken, formatCost, formatDateTime } = useSettings();
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [recentLogs, setRecentLogs] = useState<RequestLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [selectedError, setSelectedError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const loadingMoreRef = useRef(false);
  const recentLogsRef = useRef<RequestLog[]>([]);
  
  // Track active real-time requests
  const [activeRequests, setActiveRequests] = useState<Record<string, any>>({});

  const { reconnect, disconnect } = useEventStream({
    url: `/api/events/stream?${timeRangeQuery}`,
    onMessage: (event, data) => {
      if (event === "logUpdate") {
        setActiveRequests(prev => {
          const reqId = data.id;
          const oldReq = prev[reqId] || { inputTokens: 0, outputTokens: 0, cost: 0, isNew: true };
          
          const inputDelta = (data.inputTokens || 0) - oldReq.inputTokens;
          const outputDelta = (data.outputTokens || 0) - oldReq.outputTokens;
          const tokensDelta = inputDelta + outputDelta;
          const costDelta = (data.cost || 0) - oldReq.cost;
          
          const isFailed = data.usageStatus === "failed";

          setStats(s => {
            if (!s) return s;
            return {
              ...s,
              totalRequests: oldReq.isNew ? s.totalRequests + 1 : s.totalRequests,
              totalTokens: s.totalTokens + tokensDelta,
              totalPromptTokens: (s.totalPromptTokens || 0) + inputDelta,
              totalCompletionTokens: (s.totalCompletionTokens || 0) + outputDelta,
              totalCost: (s.totalCost || 0) + costDelta,
              errorCount: isFailed && !oldReq.wasFailed ? s.errorCount + 1 : s.errorCount
            };
          });

          // Also update recentLogs if it's new
          if (oldReq.isNew) {
            const inputTokens = data.inputTokens || 0;
            const outputTokens = data.outputTokens || 0;
            const newLog: RequestLog = {
              id: data.id,
              model: data.model,
              statusCode: data.statusCode ?? null,
              inputTokens,
              outputTokens,
              totalTokens: data.totalTokens ?? inputTokens + outputTokens,
              cost: data.cost,
              latencyMs: data.latencyMs || 0,
              createdAt: data.createdAt || new Date().toISOString(),
              errorMessage: data.errorMessage,
              usageStatus: data.usageStatus
            };
            setRecentLogs(logs => mergeRequestLogs(logs, [newLog]));
          } else {
            // Update existing log
            setRecentLogs(logs => logs.map(l => 
              l.id === reqId 
                ? { 
                    ...l, 
                    inputTokens: data.inputTokens ?? l.inputTokens,
                    outputTokens: data.outputTokens ?? l.outputTokens,
                    totalTokens: data.totalTokens ?? (
                      (data.inputTokens ?? l.inputTokens ?? 0) +
                      (data.outputTokens ?? l.outputTokens ?? 0)
                    ),
                    cost: data.cost ?? l.cost,
                    statusCode: data.statusCode ?? l.statusCode,
                    latencyMs: data.latencyMs ?? l.latencyMs,
                    errorMessage: data.errorMessage ?? l.errorMessage,
                    usageStatus: data.usageStatus ?? l.usageStatus
                  } 
                : l
            ));
          }
          
          return {
            ...prev,
            [reqId]: {
              inputTokens: data.inputTokens || 0,
              outputTokens: data.outputTokens || 0,
              cost: data.cost || 0,
              isNew: false,
              wasFailed: isFailed
            }
          };
        });
      }
    }
  });

  // Reconnect stream when timeRangeQuery changes
  useEffect(() => {
    disconnect();
    const timer = setTimeout(() => reconnect(), 100);
    return () => clearTimeout(timer);
  }, [timeRangeQuery, reconnect, disconnect]);

  useEffect(() => {
    recentLogsRef.current = recentLogs;
  }, [recentLogs]);

  // -- Initial load: stats + first page of logs --
  const loadInitialData = useCallback(async () => {
    try {
      const [statsData, logsData] = await Promise.all([
        fetchApi(`/me/usage?${timeRangeQuery}`),
        fetchApi(`/me/usage/logs?limit=${PAGE_SIZE}`),
      ]);
      setStats(statsData);
      const logs: RequestLog[] = logsData.data || [];
      setRecentLogs(logs);
      setHasMore(logsData.hasMore ?? logs.length >= PAGE_SIZE);
    } catch (e: any) {
      toast.error(t("myStats.toasts.loadFailed", "加载统计失败") + ": " + e.message);
    } finally {
      setLoading(false);
    }
  }, [timeRangeQuery, t]);

  // -- Incremental poll: fetch new items + refresh stats --
  const pollNewData = useCallback(async () => {
    try {
      // Always refresh stats for real-time card updates
      const statsData = await fetchApi(`/me/usage?${timeRangeQuery}`);
      setStats(statsData);
      if (Array.isArray(statsData.recentLogs)) {
        setRecentLogs((current) => mergeRequestLogs(current, statsData.recentLogs));
      }
    } catch {
      // silent fail on poll
    }
  }, [timeRangeQuery]);

  // Separated so we can use the latest recentLogs state
  const pollNewLogs = useCallback(async () => {
    try {
      const currentLogs = recentLogsRef.current;
      if (currentLogs.length === 0) return;

      const newestTimestamp = currentLogs[0].createdAt;
      const res = await fetchApi(`/me/usage/logs?limit=${PAGE_SIZE}&after=${encodeURIComponent(newestTimestamp)}`);
      const newLogs: RequestLog[] = res.data || [];
      
      if (newLogs.length > 0) {
        setRecentLogs((current) => mergeRequestLogs(current, newLogs));
      }
    } catch {
      // silent
    }
  }, []);

  // -- Load more (older) logs on scroll to bottom --
  const loadMore = useCallback(async () => {
    if (loadingMoreRef.current || !hasMore) return;
    
    const currentLogs = recentLogsRef.current;
    if (currentLogs.length === 0) return;

    loadingMoreRef.current = true;
    setLoadingMore(true);

    try {
      const oldestTimestamp = currentLogs[currentLogs.length - 1].createdAt;
      const res = await fetchApi(`/me/usage/logs?limit=${PAGE_SIZE}&before=${encodeURIComponent(oldestTimestamp)}`);
      const olderLogs: RequestLog[] = res.data || [];
      
      if (olderLogs.length < PAGE_SIZE) {
        setHasMore(false);
      }
      
      if (olderLogs.length > 0) {
        setRecentLogs((current) => {
          const existingIds = new Set(current.map((l) => l.id));
          const unique = olderLogs.filter((l) => !existingIds.has(l.id));
          const merged = [...current, ...unique];
          return merged.slice(0, MAX_LOGS_IN_MEMORY);
        });
      } else {
        setHasMore(false);
      }
    } catch {
      // ignore
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [hasMore]);

  // -- Scroll handler for infinite scroll --
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const { scrollTop, scrollHeight, clientHeight } = el;
    if (scrollHeight - scrollTop - clientHeight < 100) {
      loadMore();
    }
  }, [loadMore]);

  // -- Effects --
  useEffect(() => {
    setLoading(true);
    setRecentLogs([]);
    setHasMore(true);
    loadInitialData();
  }, [loadInitialData]);

  useEffect(() => {
    const interval = setInterval(() => {
      pollNewData();
      pollNewLogs();
    }, 10000);
    return () => clearInterval(interval);
  }, [pollNewData, pollNewLogs]);

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-32" />
          ))}
        </div>

        <Skeleton className="h-96" />
      </div>
    );
  }

  if (!stats || stats.totalRequests === 0) {
    return (
      <div className="space-y-6">
        <EmptyState
          icon={<BarChart3 className="h-12 w-12" />}
          title={t("myStats.empty.title", "暂无调用数据")}
          description={t("myStats.empty.description", "当你使用 API Key 发起请求后，这里会展示请求量、Token 用量和错误统计。")}
        />
        <div className="flex flex-wrap gap-3 justify-center">
          <Button asChild>
            <Link href="/api-keys">{t("myStats.actions.createKey", "去创建 API Key")}</Link>
          </Button>
          <Button
            variant="outline"
            onClick={() =>
              toast.info(
                t("myStats.toasts.exampleInfo", "调用示例：Authorization 使用 Bearer <API Key>，请求 /v1/chat/completions。"),
              )
            }
          >
            {t("myStats.actions.viewExample", "查看调用示例")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-[calc(100vh-6rem)] flex flex-col space-y-6">
      {/* Stats Cards */}
      <StatsGrid stats={stats} formatToken={formatToken} formatCost={formatCost} />

      {/* Recent Requests */}
      <RecentLogs 
        recentLogs={recentLogs} 
        formatDateTime={formatDateTime} 
        formatToken={formatToken} 
        formatCost={formatCost} 
        setSelectedError={setSelectedError} 
        scrollRef={scrollRef} 
        handleScroll={handleScroll} 
        loadingMore={loadingMore} 
        hasMore={hasMore} 
      />

      <ErrorDialog selectedError={selectedError} setSelectedError={setSelectedError} />
    </div>
  );
}
