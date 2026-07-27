import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/EmptyState";
import { StatCard } from "@/components/StatCard";
import { BarChart3, Activity, Zap, Clock, AlertTriangle, CheckCircle2, Coins, Loader2 } from "lucide-react";
import { Link } from "wouter";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export function StatsGrid({ stats, formatToken, formatCost }: any) {
  const { t } = useTranslation();
  return (
    <div className="shrink-0 grid gap-4 md:grid-cols-2 lg:grid-cols-5">
      <StatCard
        title={t("myStats.stats.totalRequests", "总请求数")}
        value={stats.totalRequests.toLocaleString()}
        icon={<Activity className="h-8 w-8" />}
      />
      <StatCard
        title={t("myStats.stats.totalTokens", "总 Token")}
        value={formatToken(stats.totalTokens)}
        description={t("myStats.stats.tokenBreakdown", "输入: {{input}} / 输出: {{output}}", {
          input: formatToken(stats.totalPromptTokens || 0),
          output: formatToken(stats.totalCompletionTokens || 0),
        })}
        icon={<Zap className="h-8 w-8" />}
      />
      <StatCard
        title={t("myStats.stats.totalCost", "总费用")}
        value={formatCost(stats.totalCost)}
        description={t("myStats.stats.totalCostDesc", "全部请求消耗总金额 (USD)")}
        icon={<Coins className="h-8 w-8" />}
      />
      <StatCard
        title={t("myStats.stats.successRate", "成功率")}
        value={`${Math.round(stats.successRate)}%`}
        icon={<CheckCircle2 className="h-8 w-8" />}
      />
      <StatCard
        title={t("myStats.stats.errorCount", "错误数")}
        value={stats.errorCount.toLocaleString()}
        icon={<AlertTriangle className="h-8 w-8" />}
      />
    </div>
  );
}

export function RecentLogs({ recentLogs, formatDateTime, formatToken, formatCost, setSelectedError, scrollRef, handleScroll, loadingMore, hasMore }: any) {
  const { t } = useTranslation();
  return (
    <Card className="flex-1 min-h-0 flex flex-col overflow-hidden">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Clock className="h-5 w-5" />
          {t("myStats.recentRequests.title", "最近请求")}
          <Badge variant="secondary">{t("myStats.recentRequests.count", "{{count}} 条", { count: recentLogs.length })}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-auto p-0"
      >
        {recentLogs.length === 0 ? (
          <EmptyState
            icon={<Clock className="h-12 w-12" />}
            title={t("myStats.recentRequests.noLogsTitle", "暂无请求记录")}
            description={t("myStats.recentRequests.noLogsDesc", "您还没有发起任何 API 请求")}
          />
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="hidden md:table-cell">{t("myStats.recentRequests.table.time", "时间")}</TableHead>
                  <TableHead>{t("myStats.recentRequests.table.model", "模型")}</TableHead>
                  <TableHead className="text-right">{t("myStats.recentRequests.table.status", "状态码")}</TableHead>
                  <TableHead className="text-right">{t("myStats.recentRequests.table.tokens", "Token")}</TableHead>
                  <TableHead className="text-right">{t("common.cost", "费用")}</TableHead>
                  <TableHead className="text-right">{t("myStats.recentRequests.table.latency", "延迟")}</TableHead>
                  <TableHead>{t("myStats.recentRequests.table.errorMessage", "错误信息")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recentLogs.map((log: any) => (
                  <TableRow key={log.id}>
                    <TableCell className="hidden md:table-cell text-muted-foreground text-sm">
                      {formatDateTime(log.createdAt)}
                    </TableCell>
                    <TableCell className="font-mono text-sm">{log.model || "-"}</TableCell>
                    <TableCell className="text-right">
                      <Badge
                        className={log.usageStatus === "processing" || !log.statusCode ? "processing-gradient w-16 inline-block h-5" : ""}
                        variant={
                          log.statusCode !== null && log.statusCode >= 200 && log.statusCode < 300
                            ? "default"
                            : "destructive"
                        }
                      >
                        {log.usageStatus === "processing" || !log.statusCode ? "" : log.statusCode}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="font-semibold">{formatToken(log.totalTokens || 0)}</div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {t("myStats.recentRequests.table.tokenBreakdownShort", "入: {{input}} / 出: {{output}}", {
                          input: formatToken(log.inputTokens || 0),
                          output: formatToken(log.outputTokens || 0),
                        })}
                      </div>
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm font-semibold text-foreground">
                      {log.cost != null ? formatCost(log.cost) : "-"}
                    </TableCell>
                    <TableCell className="text-right">{log.latencyMs || 0}ms</TableCell>
                    <TableCell>
                      <div
                        className="max-w-[250px] truncate text-xs text-muted-foreground cursor-pointer hover:text-foreground hover:underline transition-colors"
                        onClick={() => {
                          if (log.errorMessage) {
                            setSelectedError(log.errorMessage);
                          }
                        }}
                        title={log.errorMessage ? t("common.clickToExpand", "点击查看完整错误信息") : ""}
                      >
                        {log.errorMessage || "-"}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {loadingMore && (
              <div className="flex items-center justify-center py-4 gap-2 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span className="text-sm">{t("common.loadingMore", "加载更多...")}</span>
              </div>
            )}
            {!hasMore && recentLogs.length > 0 && (
              <div className="text-center py-4 text-xs text-muted-foreground">
                {t("myStats.recentRequests.noMore", "没有更多记录了")}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function ErrorDialog({ selectedError, setSelectedError }: any) {
  const { t } = useTranslation();
  return (
    <Dialog open={selectedError !== null} onOpenChange={(open) => !open && setSelectedError(null)}>
      <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>{t("myStats.recentRequests.errorDetail", "错误详情")}</DialogTitle>
        </DialogHeader>
        <div className="flex-1 overflow-auto bg-zinc-950 text-zinc-100 p-4 rounded-md font-mono text-xs break-all whitespace-pre-wrap select-text">
          {selectedError}
        </div>
        <div className="flex justify-end gap-2 mt-4">
          <Button
            variant="outline"
            onClick={() => {
              if (selectedError) {
                navigator.clipboard.writeText(selectedError);
                toast.success(t("common.copySuccess", "已复制到剪贴板"));
              }
            }}
          >
            {t("common.copy", "复制")}
          </Button>
          <Button onClick={() => setSelectedError(null)}>
            {t("common.close", "关闭")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
