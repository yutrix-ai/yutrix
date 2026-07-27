import { useTranslation } from "react-i18next";
import { useSettings } from "@/contexts/SettingsContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { UserTokenRank } from "./types";

function formatNumber(value: number) {
  return Number(value || 0).toLocaleString();
}

interface UserRankingTableProps {
  userRanking: UserTokenRank[];
  chartTokens: number;
}

export function UserRankingTable({ userRanking, chartTokens }: UserRankingTableProps) {
  const { t } = useTranslation();
  const { formatToken, formatCost } = useSettings();

  return (
    <Card className="flex flex-col min-h-0">
      <CardHeader className="flex flex-row items-start justify-between space-y-0">
        <div>
          <CardTitle>{t("dashboard.charts.tokenUsageRank", "Token 使用用户排行")}</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("dashboard.charts.tokenUsageRankDesc", "最近 24 小时按用户汇总，展示 Token 消耗最高的账号。")}
          </p>
        </div>
        <div className="text-right">
          <div className="text-2xl font-bold">{userRanking.length}</div>
          <div className="text-xs text-muted-foreground">
            {t("dashboard.charts.activeUsersLabel", "活跃用户")}
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex-1 flex flex-col min-h-0">
        {userRanking.length === 0 ? (
          <div className="flex flex-1 min-h-[280px] items-center justify-center text-muted-foreground">
            {t("dashboard.charts.noRankingData", "暂无用户排行数据")}
          </div>
        ) : (
          <div className="flex-1 min-h-[280px] overflow-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12">{t("dashboard.charts.table.rank", "排名")}</TableHead>
                  <TableHead>{t("dashboard.charts.table.user", "用户")}</TableHead>
                  <TableHead className="text-right">{t("dashboard.charts.table.totalTokens", "总 Tokens")}</TableHead>
                  <TableHead className="text-right">{t("common.cost", "费用")}</TableHead>
                  <TableHead className="text-right">{t("dashboard.charts.table.requests", "请求")}</TableHead>
                  <TableHead className="text-right">{t("dashboard.charts.table.ratio", "占比")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {userRanking.map((item, index) => {
                  const percent = chartTokens > 0 ? (item.totalTokens / chartTokens) * 100 : 0;

                  return (
                    <TableRow key={item.userId}>
                      <TableCell className="font-medium text-muted-foreground">
                        #{index + 1}
                      </TableCell>
                      <TableCell>
                        <div className="font-medium">{item.username}</div>
                        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-primary/10">
                          <div
                            className="h-full rounded-full bg-primary"
                            style={{ width: `${Math.min(percent, 100)}%` }}
                          />
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="font-semibold text-foreground">
                          {formatToken(item.totalTokens)}
                        </div>
                        <div className="text-xs text-muted-foreground mt-0.5">
                          {t("dashboard.charts.table.inputOutput", "入: {{input}} / 出: {{output}}", {
                            input: formatToken(item.inputTokens || 0),
                            output: formatToken(item.outputTokens || 0),
                          })}
                        </div>
                      </TableCell>
                      <TableCell className="text-right font-semibold text-foreground">
                        {item.totalCost != null ? formatCost(item.totalCost) : "-"}
                      </TableCell>
                      <TableCell className="text-right text-muted-foreground">
                        {formatNumber(item.totalRequests)}
                      </TableCell>
                      <TableCell className="text-right text-muted-foreground">
                        {Math.round(percent)}%
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
  );
}
