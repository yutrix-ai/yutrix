import { useCallback, useEffect, useRef, useState } from "react";
import { fetchApi } from "@/lib/api";
import { useAuth } from "@/lib/store";
import { StatCard } from "@/components/StatCard";
import { useTimeRange } from "@/contexts/TimeRangeContext";
import { useEventStream } from "@/hooks/useEventStream";
import { AdminDashboard } from "@/components/Dashboard/AdminDashboard";
import { UserDashboard } from "@/components/Dashboard/UserDashboard";
import {
  UserUsageStats,
  DashboardStats,
  DashboardCharts,
  UserDashboardExtra,
} from "@/components/Dashboard/types";
import { isUsageStatEligible, liveUsageRequestDelta } from "@promptgate/shared";

export default function Dashboard() {
  const { user } = useAuth();
  const [userUsage, setUserUsage] = useState<UserUsageStats | null>(null);
  const [dashboardStats, setDashboardStats] = useState<DashboardStats | null>(null);
  const [dashboardCharts, setDashboardCharts] = useState<DashboardCharts | null>(null);
  const [userDashboardExtra, setUserDashboardExtra] = useState<UserDashboardExtra | null>(null);
  const [loading, setLoading] = useState(true);
  const { timeRangeQuery } = useTimeRange();
  const refreshTimerRef = useRef<number | null>(null);
  const activeRequestsRef = useRef<Record<string, any>>({});

  const isAdmin = user?.role === "admin";

  const refreshData = useCallback(async (options: { showLoading?: boolean } = {}) => {
    try {
      if (options.showLoading) setLoading(true);

      if (isAdmin) {
        const [stats, charts] = await Promise.all([
          fetchApi(`/admin/dashboard/stats?${timeRangeQuery}`),
          fetchApi(`/admin/dashboard/token-usage?${timeRangeQuery}`),
        ]);
        setDashboardStats(stats);
        setDashboardCharts(charts);
      } else {
        const [usage, extra] = await Promise.all([
          fetchApi(`/me/usage?${timeRangeQuery}`),
          fetchApi(`/me/usage/dashboard?${timeRangeQuery}`),
        ]);
        setUserUsage(usage);
        setUserDashboardExtra(extra);
      }
    } catch (err) {
      console.error("Failed to fetch dashboard data:", err);
    } finally {
      if (options.showLoading) setLoading(false);
    }
  }, [timeRangeQuery, isAdmin]);

  const scheduleRealtimeRefresh = useCallback(() => {
    if (refreshTimerRef.current !== null) return;
    refreshTimerRef.current = window.setTimeout(() => {
      refreshTimerRef.current = null;
      void refreshData();
    }, 1000);
  }, [refreshData]);

  const { reconnect, disconnect } = useEventStream({
    url: `/api/events/stream?${timeRangeQuery}`,
    onMessage: (event, data) => {
      if (event === "logUpdate") {
        if (isAdmin) {
          scheduleRealtimeRefresh();
        } else {
          const reqId = data.id;
          const prev = activeRequestsRef.current;
          const oldReq = prev[reqId] || { inputTokens: 0, outputTokens: 0, cost: 0, isNew: true };

          const inputDelta = (data.inputTokens || 0) - oldReq.inputTokens;
          const outputDelta = (data.outputTokens || 0) - oldReq.outputTokens;
          const tokensDelta = inputDelta + outputDelta;
          const costDelta = (data.cost || 0) - oldReq.cost;
          const countsTowardUsage = isUsageStatEligible(data.usageStatus);
          const requestDelta = liveUsageRequestDelta({
            usageStatus: data.usageStatus,
            isNewRequest: oldReq.isNew,
          });

          if (countsTowardUsage) {
            setUserUsage(s => {
              if (!s) return s;
              return {
                ...s,
                totalRequests: s.totalRequests + requestDelta,
                totalTokens: s.totalTokens + tokensDelta,
                totalPromptTokens: (s.totalPromptTokens || 0) + inputDelta,
                totalCompletionTokens: (s.totalCompletionTokens || 0) + outputDelta,
                totalCost: (s.totalCost || 0) + costDelta,
              };
            });

            setUserDashboardExtra(extra => {
              if (!extra) return extra;
              const updated = { ...extra };

              if (data.latencyMs && requestDelta) {
                const totalReqs = userUsage?.totalRequests || 0;
                const newTotal = totalReqs + 1;
                updated.avgLatencyMs = Math.round(((extra.avgLatencyMs * totalReqs) + data.latencyMs) / newTotal);
              }

              if (data.model && requestDelta) {
                const existing = updated.modelBreakdown.find(m => m.model === data.model);
                if (existing) {
                  updated.modelBreakdown = updated.modelBreakdown.map(m =>
                    m.model === data.model
                      ? { ...m, totalRequests: m.totalRequests + 1, totalTokens: m.totalTokens + tokensDelta, totalCost: m.totalCost + costDelta }
                      : m
                  );
                } else {
                  updated.modelBreakdown = [...updated.modelBreakdown, { model: data.model, totalRequests: 1, totalTokens: tokensDelta, totalCost: costDelta }];
                }
              }

              return updated;
            });
          }

          activeRequestsRef.current = {
            ...prev,
            [reqId]: {
              inputTokens: data.inputTokens || 0,
              outputTokens: data.outputTokens || 0,
              cost: data.cost || 0,
              isNew: false,
            }
          };
        }
      }
    }
  });

  useEffect(() => {
    disconnect();
    const timer = setTimeout(() => reconnect(), 100);
    return () => clearTimeout(timer);
  }, [timeRangeQuery, reconnect, disconnect]);

  useEffect(() => {
    void refreshData({ showLoading: true });
  }, [refreshData]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      void refreshData();
    }, 10000);
    return () => window.clearInterval(interval);
  }, [refreshData]);

  useEffect(() => {
    return () => {
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
      }
    };
  }, []);

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {[...Array(10)].map((_, i) => (
            <StatCard key={i} title="" value="" loading />
          ))}
        </div>
      </div>
    );
  }

  if (isAdmin) {
    return <AdminDashboard dashboardStats={dashboardStats} dashboardCharts={dashboardCharts} />;
  }

  return <UserDashboard userUsage={userUsage} userDashboardExtra={userDashboardExtra} />;
}
