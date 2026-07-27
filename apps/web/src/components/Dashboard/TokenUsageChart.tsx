import { useTranslation } from "react-i18next";
import { useSettings } from "@/contexts/SettingsContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { TokenSeriesPoint } from "./types";

function formatNumber(value: number) {
  return Number(value || 0).toLocaleString();
}

function TokenTooltip({ active, payload, label }: any) {
  const { t } = useTranslation();
  const { formatToken, formatCost, formatDateTime } = useSettings();
  if (!active || !payload?.length) return null;
  const data = payload[0]?.payload as TokenSeriesPoint;

  return (
    <div className="rounded-md border bg-card px-3 py-2 text-sm shadow-md space-y-1">
      <div className="font-medium">{formatDateTime(data.hour)}</div>
      <div className="text-xs text-muted-foreground">
        {t("dashboard.charts.inputTokens", "输入 Token")}: <span className="font-semibold text-sky-600">{formatToken(data.inputTokens)}</span>
      </div>
      <div className="text-xs text-muted-foreground">
        {t("dashboard.charts.outputTokens", "输出 Token")}: <span className="font-semibold text-emerald-600">{formatToken(data.outputTokens)}</span>
      </div>
      <div className="text-xs text-muted-foreground border-b pb-1 mb-1">
        {t("dashboard.charts.totalTokens", "总 Token")}: <span className="font-semibold text-foreground">{formatToken(data.tokens)}</span>
      </div>
      {data.cost != null && (
        <div className="text-xs text-muted-foreground border-b pb-1 mb-1">
          {t("dashboard.charts.cost", "费用")}: <span className="font-semibold text-foreground">{formatCost(data.cost)}</span>
        </div>
      )}
      <div className="text-xs text-muted-foreground pt-0.5">
        {t("dashboard.charts.requests")}: <span className="font-medium text-foreground">{formatNumber(data.requests)}</span>
      </div>
    </div>
  );
}

interface TokenUsageChartProps {
  tokenSeries: TokenSeriesPoint[];
  chartTokens: number;
  chartRequests: number;
}

export function TokenUsageChart({ tokenSeries, chartTokens, chartRequests }: TokenUsageChartProps) {
  const { t } = useTranslation();
  const { formatToken, formatShortDateTime, tokenDisplayUnit } = useSettings();

  return (
    <Card className="flex flex-col min-h-0">
      <CardHeader className="flex flex-row items-start justify-between space-y-0">
        <div>
          <CardTitle>{t("dashboard.charts.tokenCurve", "Token 曲线")}</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("dashboard.charts.past24hTokenCurveDesc", "按时间段聚合 Token 消耗，辅助观察调用峰值。")}
          </p>
        </div>
        <div className="text-right">
          <div className="text-2xl font-bold">{formatToken(chartTokens)}</div>
          <div className="text-xs text-muted-foreground">
            {t("dashboard.charts.requestsCount", "{{count}} 次请求", { count: chartRequests })}
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex-1 flex flex-col min-h-0">
        {chartTokens === 0 ? (
          <div className="flex flex-1 min-h-[280px] items-center justify-center text-muted-foreground">
            {t("dashboard.charts.noTokenCurveData", "暂无 Token 曲线数据")}
          </div>
        ) : (
          <div className="flex-1 min-h-[280px]">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={tokenSeries} margin={{ top: 12, right: 12, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="totalGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#8b5cf6" stopOpacity={0.35} />
                    <stop offset="95%" stopColor="#8b5cf6" stopOpacity={0.03} />
                  </linearGradient>
                  <linearGradient id="inputGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.35} />
                    <stop offset="95%" stopColor="#3b82f6" stopOpacity={0.03} />
                  </linearGradient>
                  <linearGradient id="outputGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#10b981" stopOpacity={0.35} />
                    <stop offset="95%" stopColor="#10b981" stopOpacity={0.03} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
                <XAxis
                  dataKey="hour"
                  tickFormatter={(val) => formatShortDateTime(val)}
                  tickLine={false}
                  axisLine={false}
                  interval={3}
                  tick={{ fontSize: 12, fill: "#6b7280" }}
                />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(val) => formatToken(val)}
                  tick={{ fontSize: 12, fill: "#6b7280" }}
                  width={tokenDisplayUnit === 'raw' ? 85 : 44}
                />
                <Tooltip content={<TokenTooltip />} />
                <Area
                  type="monotone"
                  dataKey="tokens"
                  name={t("dashboard.charts.totalTokens", "总 Token")}
                  stroke="#8b5cf6"
                  strokeWidth={2}
                  fill="url(#totalGradient)"
                  dot={false}
                  activeDot={{ r: 4 }}
                />
                <Area
                  type="monotone"
                  dataKey="inputTokens"
                  name={t("dashboard.charts.inputTokens", "输入 Token")}
                  stroke="#3b82f6"
                  strokeWidth={2}
                  fill="url(#inputGradient)"
                  dot={false}
                  activeDot={{ r: 4 }}
                />
                <Area
                  type="monotone"
                  dataKey="outputTokens"
                  name={t("dashboard.charts.outputTokens", "输出 Token")}
                  stroke="#10b981"
                  strokeWidth={2}
                  fill="url(#outputGradient)"
                  dot={false}
                  activeDot={{ r: 4 }}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
