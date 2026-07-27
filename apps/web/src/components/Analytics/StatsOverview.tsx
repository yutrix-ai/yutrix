import { useTranslation } from "react-i18next";
import { Activity, Zap, Coins, CheckCircle, Clock } from "lucide-react";
import { StatCard } from "@/components/StatCard";
import { useSettings } from "@/contexts/SettingsContext";
import { Stats } from "./types";

interface StatsOverviewProps {
  stats: Stats;
}

export function StatsOverview({ stats }: StatsOverviewProps) {
  const { t } = useTranslation();
  const { formatToken, formatCost } = useSettings();

  return (
    <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 shrink-0">
      <StatCard
        title={t("analytics.stats.totalRequests", "总请求数")}
        value={stats.totalRequests.toLocaleString()}
        icon={<Activity className="h-8 w-8" />}
      />
      <StatCard
        title={t("analytics.stats.totalTokens", "总 Tokens")}
        value={formatToken(stats.totalTokens)}
        description={t("analytics.stats.tokenBreakdown", "输入: {{input}} / 输出: {{output}}", {
          input: formatToken(stats.totalInputTokens || 0),
          output: formatToken(stats.totalOutputTokens || 0),
        })}
        icon={<Zap className="h-8 w-8" />}
      />
      <StatCard
        title={t("analytics.stats.totalCost", "总费用")}
        value={formatCost(stats.totalCost)}
        description={t("analytics.stats.totalCostDesc", "全部请求消耗总金额 (USD)")}
        icon={<Coins className="h-8 w-8" />}
      />
      <StatCard
        title={t("analytics.stats.successRate", "成功率")}
        value={`${Math.round(stats.successRate)}%`}
        icon={<CheckCircle className="h-8 w-8" />}
      />
      <StatCard
        title={t("analytics.stats.avgLatency", "平均延迟")}
        value={`${Math.round(stats.avgLatencyMs)}ms`}
        icon={<Clock className="h-8 w-8" />}
      />
    </div>
  );
}
