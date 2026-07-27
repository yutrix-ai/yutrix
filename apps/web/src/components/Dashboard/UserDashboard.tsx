import { useTranslation } from "react-i18next";
import { useSettings } from "@/contexts/SettingsContext";
import { StatCard } from "@/components/StatCard";
import { EmptyState } from "@/components/EmptyState";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Activity, Zap, TrendingUp, CheckCircle, Coins, Box } from "lucide-react";
import { UserUsageStats, UserDashboardExtra } from "./types";

function formatNumber(value: number) {
  return Number(value || 0).toLocaleString();
}

interface UserDashboardProps {
  userUsage: UserUsageStats | null;
  userDashboardExtra: UserDashboardExtra | null;
}

export function UserDashboard({ userUsage, userDashboardExtra }: UserDashboardProps) {
  const { t } = useTranslation();
  const { formatToken, formatCost } = useSettings();

  if (!userUsage || userUsage.totalRequests === 0) {
    return (
      <EmptyState
        title={t("dashboard.welcome.title", "欢迎使用 PromptGate")}
        description={t("dashboard.welcome.description", "开始使用 AI 网关。创建 API Key 后即可开始调用。")}
        icon={<Zap className="h-12 w-12" />}
      />
    );
  }

  const modelBreakdown = userDashboardExtra?.modelBreakdown || [];
  const avgLatencyMs = userDashboardExtra?.avgLatencyMs || 0;
  const totalModelTokens = modelBreakdown.reduce((a, m) => a + m.totalTokens, 0);

  return (
    <div className="space-y-6">
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-5">
        <StatCard
          title={t("dashboard.stats.totalRequests", "总请求数")}
          value={userUsage.totalRequests.toLocaleString()}
          icon={<Activity className="h-8 w-8" />}
        />
        <StatCard
          title={t("dashboard.stats.totalTokensConsumed", "总消耗 Tokens")}
          value={formatToken(userUsage.totalTokens)}
          description={t("dashboard.stats.tokenBreakdown", "输入: {{input}} / 输出: {{output}}", {
            input: formatToken(userUsage.totalPromptTokens || 0),
            output: formatToken(userUsage.totalCompletionTokens || 0),
          })}
          icon={<Zap className="h-8 w-8" />}
        />
        <StatCard
          title={t("dashboard.stats.totalCost", "总费用")}
          value={formatCost(userUsage.totalCost)}
          description={t("dashboard.stats.totalCostDesc", "所有请求产生的总费用 (USD)")}
          icon={<Coins className="h-8 w-8" />}
        />
        <StatCard
          title={t("dashboard.stats.successRate", "成功率")}
          value={`${Math.round(userUsage.successRate)}%`}
          icon={<CheckCircle className="h-8 w-8" />}
        />
        <StatCard
          title={t("dashboard.stats.avgLatency", "平均延迟")}
          value={`${avgLatencyMs}ms`}
          icon={<TrendingUp className="h-8 w-8" />}
        />
      </div>

      <Card>
        <CardHeader className="flex flex-row items-start justify-between space-y-0">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Box className="h-5 w-5" />
              {t("dashboard.user.modelBreakdown", "模型用量分布")}
            </CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("dashboard.user.modelBreakdownDesc", "按模型维度统计 Token 消耗和请求次数。")}
            </p>
          </div>
          <div className="text-right">
            <div className="text-2xl font-bold">{modelBreakdown.length}</div>
            <div className="text-xs text-muted-foreground">
              {t("dashboard.user.activeModels", "活跃模型")}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {modelBreakdown.length === 0 ? (
            <div className="flex h-[120px] items-center justify-center text-muted-foreground">
              {t("dashboard.user.noModelData", "暂无模型用量数据")}
            </div>
          ) : (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("dashboard.user.table.model", "模型")}</TableHead>
                    <TableHead className="text-right">{t("dashboard.user.table.requests", "请求")}</TableHead>
                    <TableHead className="text-right">{t("dashboard.user.table.tokens", "Token")}</TableHead>
                    <TableHead className="text-right">{t("common.cost", "费用")}</TableHead>
                    <TableHead className="text-right">{t("dashboard.charts.table.ratio", "占比")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {modelBreakdown.slice(0, 5).map((item) => {
                    const percent = totalModelTokens > 0 ? (item.totalTokens / totalModelTokens) * 100 : 0;
                    return (
                      <TableRow key={item.model}>
                        <TableCell>
                          <span className="font-mono text-sm font-medium">{item.model}</span>
                        </TableCell>
                        <TableCell className="text-right text-muted-foreground">
                          {formatNumber(item.totalRequests)}
                        </TableCell>
                        <TableCell className="text-right">
                          <span className="font-semibold">{formatToken(item.totalTokens)}</span>
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm">
                          {item.totalCost != null ? formatCost(item.totalCost) : "-"}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-2">
                            <div className="w-16 h-1.5 overflow-hidden rounded-full bg-primary/10">
                              <div
                                className="h-full rounded-full bg-primary"
                                style={{ width: `${Math.min(percent, 100)}%` }}
                              />
                            </div>
                            <span className="text-xs text-muted-foreground w-10 text-right">{Math.round(percent)}%</span>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
