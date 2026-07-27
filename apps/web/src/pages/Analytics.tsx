import { useState, useEffect } from "react";
import { fetchApi } from "@/lib/api";
import { useTranslation } from "react-i18next";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/EmptyState";
import { BarChart3 } from "lucide-react";
import { useTimeRange } from "@/contexts/TimeRangeContext";

import { StatsOverview } from "@/components/Analytics/StatsOverview";
import { BreakdownTabs } from "@/components/Analytics/BreakdownTabs";
import { DetailDialog } from "@/components/Analytics/DetailDialog";
import { Stats, BreakdownItem, DetailType } from "@/components/Analytics/types";

export default function Analytics() {
  const { t } = useTranslation();
  const { timeRangeQuery } = useTimeRange();
  
  const [stats, setStats] = useState<Stats | null>(null);
  const [byUser, setByUser] = useState<BreakdownItem[]>([]);
  const [byProvider, setByProvider] = useState<BreakdownItem[]>([]);
  const [byProviderKey, setByProviderKey] = useState<BreakdownItem[]>([]);
  const [byModel, setByModel] = useState<BreakdownItem[]>([]);
  const [byEndpoint, setByEndpoint] = useState<BreakdownItem[]>([]);
  const [bySubdomain, setBySubdomain] = useState<BreakdownItem[]>([]);

  const [loading, setLoading] = useState(true);

  const [detailOpen, setDetailOpen] = useState(false);
  const [detailType, setDetailType] = useState<DetailType | null>(null);
  const [detailValue, setDetailValue] = useState<string>("");
  const [detailName, setDetailName] = useState<string>("");
  const [detailData, setDetailData] = useState<any[]>([]);
  const [detailPeriod, setDetailPeriod] = useState<{ start: string; end: string } | null>(null);
  const [detailRadarMetrics, setDetailRadarMetrics] = useState<any>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [chartMetric, setChartMetric] = useState<"requests" | "tokens" | "cost">("requests");

  const handleOpenDetail = async (
    type: DetailType,
    value: string,
    name: string
  ) => {
    setDetailType(type);
    setDetailValue(value);
    setDetailName(name);
    setDetailOpen(true);
    setDetailLoading(true);
    setDetailData([]);
    setDetailPeriod(null);
    setDetailRadarMetrics(null);
    setChartMetric("requests");
    try {
      const res = await fetchApi(`/admin/analytics/detail?type=${type}&value=${encodeURIComponent(value || "null")}&${timeRangeQuery}`);
      if (res) {
        setDetailData(res.data || []);
        setDetailPeriod({ start: res.startDate, end: res.endDate });
        setDetailRadarMetrics(res.radarMetrics || null);
      }
    } catch (err) {
      console.error("Failed to load details:", err);
    } finally {
      setDetailLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [timeRangeQuery]);

  const loadData = async () => {
    setLoading(true);
    try {
      const [statsData, userData, providerData, providerKeyData, modelData, endpointData, subdomainData] =
        await Promise.all([
          fetchApi(`/admin/analytics/stats?${timeRangeQuery}`),
          fetchApi(`/admin/analytics/by-user?${timeRangeQuery}`),
          fetchApi(`/admin/analytics/by-provider?${timeRangeQuery}`),
          fetchApi(`/admin/analytics/by-provider-key?${timeRangeQuery}`),
          fetchApi(`/admin/analytics/by-model?${timeRangeQuery}`),
          fetchApi(`/admin/analytics/by-endpoint?${timeRangeQuery}`),
          fetchApi(`/admin/analytics/by-subdomain?${timeRangeQuery}`),
        ]);

      setStats(statsData);
      setByUser(userData);
      setByProvider(providerData);
      setByProviderKey(providerKeyData);
      setByModel(modelData);
      setByEndpoint(endpointData);
      setBySubdomain(subdomainData);

    } catch (e: any) {
      console.error("Failed to load analytics:", e);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex justify-end items-center">
          <Skeleton className="h-10 w-32" />
        </div>

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
          title={t("analytics.empty.title", "暂无统计数据")}
          description={t("analytics.empty.description", "当有 API 请求后，这里将显示详细的统计分析")}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full gap-6 min-h-0">
      <StatsOverview stats={stats} />

      <BreakdownTabs
        byUser={byUser}
        byProvider={byProvider}
        byProviderKey={byProviderKey}
        byModel={byModel}
        byEndpoint={byEndpoint}
        bySubdomain={bySubdomain}
        onOpenDetail={handleOpenDetail}
      />

      <DetailDialog
        open={detailOpen}
        onOpenChange={setDetailOpen}
        type={detailType}
        name={detailName}
        data={detailData}
        period={detailPeriod}
        loading={detailLoading}
        chartMetric={chartMetric}
        setChartMetric={setChartMetric}
        radarMetrics={detailRadarMetrics}
      />
    </div>
  );
}
