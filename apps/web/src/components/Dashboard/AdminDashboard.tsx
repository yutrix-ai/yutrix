import { useTranslation } from "react-i18next";
import { useSettings } from "@/contexts/SettingsContext";
import { StatCard } from "@/components/StatCard";
import { EmptyState } from "@/components/EmptyState";
import { TokenUsageChart } from "./TokenUsageChart";
import { UserRankingTable } from "./UserRankingTable";
import { Activity, Key, Zap, TrendingUp, Server, Globe, Radio, CheckCircle, Coins, Gauge } from "lucide-react";
import { DashboardStats, DashboardCharts } from "./types";

interface AdminDashboardProps {
  dashboardStats: DashboardStats | null;
  dashboardCharts: DashboardCharts | null;
}

export function AdminDashboard({ dashboardStats, dashboardCharts }: AdminDashboardProps) {
  const { t } = useTranslation();
  const { formatToken, formatCost } = useSettings();

  if (!dashboardStats) {
    return (
      <EmptyState
        title={t("dashboard.welcome.title", "欢迎使用 PromptGate")}
        description={t("dashboard.welcome.description", "开始配置您的 AI 网关。按照以下步骤完成初始设置：")}
        icon={<Zap className="h-12 w-12" />}
      />
    );
  }

  const tokenSeries = dashboardCharts?.tokenSeries || [];
  const userRanking = dashboardCharts?.userRanking || [];
  const chartTokens = tokenSeries.reduce((acc, curr) => acc + curr.tokens, 0);
  const chartRequests = tokenSeries.reduce((acc, curr) => acc + curr.requests, 0);

  return (
    <div className="space-y-6 flex flex-col h-full min-h-0">
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        <StatCard
          title={t("dashboard.stats.todayRequests", "今日请求数")}
          value={dashboardStats.todayRequests.toLocaleString()}
          icon={<Activity className="h-8 w-8" />}
        />
        <StatCard
          title={t("dashboard.stats.todayTokens", "今日 Token")}
          value={formatToken(dashboardStats.todayTokens)}
          description={t("dashboard.stats.tokenBreakdown", "输入: {{input}} / 输出: {{output}}", {
            input: formatToken(dashboardStats.todayInputTokens),
            output: formatToken(dashboardStats.todayOutputTokens),
          })}
          icon={<Zap className="h-8 w-8" />}
        />
        <StatCard
          title={t("dashboard.stats.todayCost", "今日费用")}
          value={formatCost(dashboardStats.todayCost)}
          description={t("dashboard.stats.todayCostDesc", "今日消耗总金额 (USD)")}
          icon={<Coins className="h-8 w-8" />}
        />
        <StatCard
          title={t("dashboard.stats.successRate", "成功率")}
          value={`${Math.round(dashboardStats.successRate)}%`}
          icon={<CheckCircle className="h-8 w-8" />}
        />
        <StatCard
          title={t("dashboard.stats.avgLatency", "平均延迟")}
          value={`${dashboardStats.avgLatencyMs.toFixed(0)}ms`}
          icon={<TrendingUp className="h-8 w-8" />}
        />
        <StatCard
          title={t("dashboard.stats.activeApiKeys", "活跃 API Key")}
          value={dashboardStats.activeApiKeys}
          icon={<Key className="h-8 w-8" />}
        />
        <StatCard
          title={t("dashboard.stats.enabledProviders", "启用供应商")}
          value={dashboardStats.enabledProviders}
          icon={<Server className="h-8 w-8" />}
        />
        <StatCard
          title={t("dashboard.stats.totalSubdomains", "二级域名")}
          value={dashboardStats.totalSubdomains}
          icon={<Globe className="h-8 w-8" />}
        />
        <StatCard
          title={t("dashboard.stats.totalEndpoints", "端点总数")}
          value={dashboardStats.totalEndpoints}
          icon={<Radio className="h-8 w-8" />}
        />
        <StatCard
          title={t("dashboard.stats.tpm", "每分钟 Token (TPM)")}
          value={formatToken(dashboardStats.tpm)}
          icon={<Gauge className="h-8 w-8" />}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2 flex-1 min-h-0">
        <TokenUsageChart
          tokenSeries={tokenSeries}
          chartTokens={chartTokens}
          chartRequests={chartRequests}
        />
        <UserRankingTable
          userRanking={userRanking}
          chartTokens={chartTokens}
        />
      </div>
    </div>
  );
}
