import { useTranslation } from "react-i18next";
import { BarChart3, Info } from "lucide-react";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/EmptyState";
import { useSettings } from "@/contexts/SettingsContext";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as ChartTooltip,
  ResponsiveContainer,
  RadarChart,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
  Radar,
} from "recharts";
import { DetailType } from "./types";

interface DetailDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  type: DetailType | null;
  name: string;
  data: any[];
  period: { start: string; end: string } | null;
  loading: boolean;
  chartMetric: "requests" | "tokens" | "cost";
  setChartMetric: (metric: "requests" | "tokens" | "cost") => void;
  radarMetrics?: {
    contextSpike: number;
    streamAbort: number;
    cacheEfficiency: number;
    thrashing: number;
    ttftPenalty: number;
  };
}

export function DetailDialog({
  open,
  onOpenChange,
  type,
  name,
  data,
  period,
  loading,
  chartMetric,
  setChartMetric,
  radarMetrics,
}: DetailDialogProps) {
  const { t } = useTranslation();
  const { formatToken, formatCost } = useSettings();

  const getTitle = () => {
    if (!type) return "";
    const prefixMap = {
      user: t("analytics.detail.userTitle", "用户使用详情"),
      provider: t("analytics.detail.providerTitle", "供应商使用详情"),
      model: t("analytics.detail.modelTitle", "模型使用详情"),
      endpoint: t("analytics.detail.endpointTitle", "端点使用详情"),
      subdomain: t("analytics.detail.subdomainTitle", "子域名使用详情"),
    };
    return `${prefixMap[type]}: ${name}`;
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl h-[85vh] flex flex-col p-6 overflow-hidden">
        <DialogHeader className="shrink-0 mb-2">
          <DialogTitle>{getTitle()}</DialogTitle>
          {period && (
            <DialogDescription className="text-xs text-muted-foreground mt-1">
              {t("analytics.detail.timeRange", "统计时间范围")}: {period.start} ~ {period.end}
            </DialogDescription>
          )}
        </DialogHeader>
        <DialogBody className="flex-1 flex flex-col min-h-0 overflow-hidden gap-4">
          {loading ? (
            <div className="space-y-6">
              <div className="grid gap-4 grid-cols-2 md:grid-cols-4">
                {[...Array(4)].map((_, i) => (
                  <Skeleton key={i} className="h-20 w-full" />
                ))}
              </div>
              <Skeleton className="h-44 w-full" />
              <Skeleton className="h-32 w-full" />
            </div>
          ) : data.length === 0 ? (
            <EmptyState
              icon={<BarChart3 className="h-12 w-12" />}
              title={t("analytics.empty.title", "暂无数据")}
              description={t("analytics.empty.description", "该时间段内暂无该维度的调用数据")}
            />
          ) : (
            <div className="flex-1 flex flex-col min-h-0 gap-4">
              {/* Stats cards for details */}
              {(() => {
                const totalReqs = data.reduce((acc, curr) => acc + curr.requests, 0);
                const totalToks = data.reduce((acc, curr) => acc + curr.tokens, 0);
                const totalInToks = data.reduce((acc, curr) => acc + curr.inputTokens, 0);
                const totalOutToks = data.reduce((acc, curr) => acc + curr.outputTokens, 0);
                const totalCst = data.reduce((acc, curr) => acc + curr.cost, 0);
                const avgLat = totalReqs > 0 ? Math.round(data.reduce((acc, curr) => acc + (curr.avgLatencyMs * curr.requests), 0) / totalReqs) : 0;
                const succRate = totalReqs > 0 ? Math.round((data.reduce((acc, curr) => acc + (curr.successRate * curr.requests), 0) / totalReqs)) : 100;

                return (
                  <div className="grid gap-4 grid-cols-2 md:grid-cols-4 shrink-0">
                    <div className="rounded-lg border bg-card p-3 shadow-sm">
                      <div className="text-xs font-medium text-muted-foreground">{t("analytics.table.requests", "请求数")}</div>
                      <div className="text-lg font-bold mt-0.5">{totalReqs.toLocaleString()}</div>
                    </div>
                    <div className="rounded-lg border bg-card p-3 shadow-sm">
                      <div className="text-xs font-medium text-muted-foreground">Tokens</div>
                      <div className="text-lg font-bold mt-0.5">{formatToken(totalToks)}</div>
                      <div className="text-[10px] text-muted-foreground mt-0.5">
                        {t("analytics.table.tokenBreakdownShort", "入: {{input}} / 出: {{output}}", {
                          input: formatToken(totalInToks),
                          output: formatToken(totalOutToks),
                        })}
                      </div>
                    </div>
                    <div className="rounded-lg border bg-card p-3 shadow-sm">
                      <div className="text-xs font-medium text-muted-foreground">{t("common.cost", "费用")}</div>
                      <div className="text-lg font-bold mt-0.5 text-emerald-600">{totalCst != null ? formatCost(totalCst) : "-"}</div>
                    </div>
                    <div className="rounded-lg border bg-card p-3 shadow-sm">
                      <div className="text-xs font-medium text-muted-foreground">{t("analytics.table.successRate", "成功率")} / {t("analytics.table.avgLatency", "平均延迟")}</div>
                      <div className="text-lg font-bold mt-0.5">{succRate}% <span className="text-xs font-normal text-muted-foreground ml-1">({avgLat}ms)</span></div>
                    </div>
                  </div>
                );
              })()}

              {/* Trend & Radar Section */}
              <div className="shrink-0 grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="flex flex-col">
                  <div className="flex justify-between items-center mb-2">
                    <h4 className="text-xs font-semibold">{t("analytics.detail.trend", "使用趋势")}</h4>
                    <div className="flex gap-1 bg-muted p-0.5 rounded-md text-[10px] border">
                    <button
                      onClick={() => setChartMetric("requests")}
                      className={`px-2 py-0.5 rounded-sm font-medium transition-all ${chartMetric === "requests" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
                    >
                      {t("analytics.table.requests", "请求数")}
                    </button>
                    <button
                      onClick={() => setChartMetric("tokens")}
                      className={`px-2 py-0.5 rounded-sm font-medium transition-all ${chartMetric === "tokens" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
                    >
                      Tokens
                    </button>
                    <button
                      onClick={() => setChartMetric("cost")}
                      className={`px-2 py-0.5 rounded-sm font-medium transition-all ${chartMetric === "cost" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
                    >
                      {t("common.cost", "费用")}
                    </button>
                  </div>
                </div>

                <div className="h-44 w-full bg-card rounded-lg border p-3 shadow-inner">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={data} margin={{ top: 5, right: 5, left: -25, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
                      <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fontSize: 9, fill: "#6b7280" }} />
                      <YAxis
                        tickLine={false}
                        axisLine={false}
                        tickFormatter={(val) => {
                          if (chartMetric === "tokens") return formatToken(val);
                          if (chartMetric === "cost") return formatCost(val);
                          return val.toLocaleString();
                        }}
                        tick={{ fontSize: 9, fill: "#6b7280" }}
                      />
                      <ChartTooltip
                        content={({ active, payload, label }) => {
                          if (!active || !payload?.length) return null;
                          const d = payload[0].payload;
                          return (
                            <div className="rounded-md border bg-card px-2.5 py-1.5 text-[11px] shadow-md space-y-1">
                              <div className="font-semibold">{label}</div>
                              <div>
                                {t("analytics.table.requests", "请求数")}: <span className="font-semibold">{d.requests.toLocaleString()}</span>
                              </div>
                              <div>
                                Tokens: <span className="font-semibold text-violet-600">{formatToken(d.tokens)}</span>
                                <span className="text-muted-foreground ml-1">
                                  ({t("analytics.table.tokenBreakdownShort", "入: {{input}} / 出: {{output}}", {
                                    input: formatToken(d.inputTokens),
                                    output: formatToken(d.outputTokens),
                                  })})
                                </span>
                              </div>
                              <div>
                                {t("common.cost", "费用")}: <span className="font-semibold text-emerald-600">{formatCost(d.cost)}</span>
                              </div>
                              <div>
                                {t("analytics.table.avgLatency", "平均延迟")}: <span className="font-semibold">{d.avgLatencyMs}ms</span>
                              </div>
                              <div>
                                {t("analytics.table.successRate", "成功率")}: <span className="font-semibold">{d.successRate}%</span>
                              </div>
                            </div>
                          );
                        }}
                      />
                      <Bar
                        dataKey={chartMetric}
                        fill={chartMetric === "tokens" ? "#8b5cf6" : chartMetric === "cost" ? "#10b981" : "#3b82f6"}
                        radius={[3, 3, 0, 0]}
                      />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                </div>
                {radarMetrics && (
                  <div className="flex flex-col">
                    <div className="flex justify-between items-center mb-2">
                      <h4 className="text-xs font-semibold flex items-center gap-1">
                        {t("analytics.detail.tuqs.title", "Token Usage Quality Score (TUQS 2.0)")}
                        <Popover>
                          <PopoverTrigger><Info className="h-3 w-3 text-muted-foreground hover:text-foreground cursor-pointer" /></PopoverTrigger>
                          <PopoverContent className="w-80 text-xs space-y-2 p-3">
                            <p>{t("analytics.detail.tuqs.desc1")}</p>
                            <p>{t("analytics.detail.tuqs.desc2")}</p>
                            <p>{t("analytics.detail.tuqs.desc3")}</p>
                            <p>{t("analytics.detail.tuqs.desc4")}</p>
                            <p>{t("analytics.detail.tuqs.desc5")}</p>
                          </PopoverContent>
                        </Popover>
                      </h4>
                      <div className="text-[10px] text-muted-foreground font-mono">{t("analytics.detail.tuqs.optimal", "100 = Optimal")}</div>
                    </div>
                    <div className="h-44 w-full bg-card rounded-lg border shadow-inner flex items-center justify-center">
                      <ResponsiveContainer width="100%" height="100%">
                        <RadarChart data={[
                          { subject: t("analytics.detail.tuqs.contextSpike", "Context Spike"), A: radarMetrics.contextSpike, fullMark: 100 },
                          { subject: t("analytics.detail.tuqs.streamAbort", "Stream Abort"), A: radarMetrics.streamAbort, fullMark: 100 },
                          { subject: t("analytics.detail.tuqs.cacheEfficiency", "Cache Efficiency"), A: radarMetrics.cacheEfficiency, fullMark: 100 },
                          { subject: t("analytics.detail.tuqs.thrashing", "Thrashing"), A: radarMetrics.thrashing, fullMark: 100 },
                          { subject: t("analytics.detail.tuqs.ttftPenalty", "TTFT Penalty"), A: radarMetrics.ttftPenalty, fullMark: 100 }
                        ]}>
                          <PolarGrid />
                          <PolarAngleAxis dataKey="subject" tick={{ fontSize: 10 }} />
                          <PolarRadiusAxis angle={30} domain={[0, 100]} tick={false} axisLine={false} />
                          <Radar name="Score" dataKey="A" stroke="#8b5cf6" fill="#8b5cf6" fillOpacity={0.4} />
                          <ChartTooltip contentStyle={{ fontSize: 11, borderRadius: 6 }} />
                        </RadarChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                )}
              </div>

              {/* Table Section */}
              <div className="flex-1 min-h-0 flex flex-col">
                <h4 className="text-xs font-semibold mb-2 shrink-0">{t("analytics.detail.breakdown", "详细数据")}</h4>
                <div className="flex-1 min-h-0 border rounded-md overflow-y-auto bg-card">
                  <Table>
                    <TableHeader className="sticky top-0 bg-secondary/90 backdrop-blur-sm z-10">
                      <TableRow>
                        <TableHead className="w-1/4 py-1.5 text-xs">{t("analytics.detail.time", "时间段")}</TableHead>
                        <TableHead className="text-right py-1.5 text-xs">{t("analytics.table.requests", "请求数")}</TableHead>
                        <TableHead className="text-right py-1.5 text-xs">Tokens</TableHead>
                        <TableHead className="text-right py-1.5 text-xs">{t("common.cost", "费用")}</TableHead>
                        <TableHead className="text-right py-1.5 text-xs">{t("analytics.table.avgLatency", "平均延迟")}</TableHead>
                        <TableHead className="text-right py-1.5 text-xs">{t("analytics.table.successRate", "成功率")}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.map((item, i) => (
                        <TableRow key={i} className="hover:bg-muted/30">
                          <TableCell className="font-medium py-1.5 text-[11px]">{item.label}</TableCell>
                          <TableCell className="text-right py-1.5 text-[11px]">{item.requests.toLocaleString()}</TableCell>
                          <TableCell className="text-right py-1.5 text-[11px]">
                            <div className="font-semibold">{formatToken(item.tokens)}</div>
                            <div className="text-[9px] text-muted-foreground">
                              {t("analytics.table.tokenBreakdownShort", "入: {{input}} / 出: {{output}}", {
                                input: formatToken(item.inputTokens),
                                output: formatToken(item.outputTokens),
                              })}
                            </div>
                          </TableCell>
                          <TableCell className="text-right py-1.5 text-[11px] font-semibold text-foreground">
                            {item.cost != null ? formatCost(item.cost) : "-"}
                          </TableCell>
                          <TableCell className="text-right py-1.5 text-[11px]">{item.avgLatencyMs}ms</TableCell>
                          <TableCell className="text-right py-1.5 text-[11px]">{item.successRate}%</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            </div>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
