import { useTranslation } from "react-i18next";
import { Users, Server, Cpu, Radio, Globe, Key } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState } from "@/components/EmptyState";
import { useSettings } from "@/contexts/SettingsContext";
import { BreakdownItem, DetailType } from "./types";

interface BreakdownTabsProps {
  byUser: BreakdownItem[];
  byProvider: BreakdownItem[];
  byProviderKey: BreakdownItem[];
  byModel: BreakdownItem[];
  byEndpoint: BreakdownItem[];
  bySubdomain: BreakdownItem[];
  onOpenDetail: (type: DetailType, value: string, name: string) => void;
}

export function BreakdownTabs({
  byUser,
  byProvider,
  byProviderKey,
  byModel,
  byEndpoint,
  bySubdomain,
  onOpenDetail,
}: BreakdownTabsProps) {
  const { t } = useTranslation();
  const { formatToken, formatCost } = useSettings();

  return (
    <Tabs defaultValue="user" className="flex flex-col flex-1 min-h-0 gap-4">
      <TabsList className="grid w-full grid-cols-6 shrink-0">
        <TabsTrigger value="user">
          <Users className="h-4 w-4 mr-2" />
          {t("analytics.tabs.user", "用户")}
        </TabsTrigger>
        <TabsTrigger value="provider">
          <Server className="h-4 w-4 mr-2" />
          {t("analytics.tabs.provider", "供应商")}
        </TabsTrigger>
        <TabsTrigger value="providerKey">
          <Key className="h-4 w-4 mr-2" />
          {t("analytics.tabs.providerKey", "供应商密钥")}
        </TabsTrigger>
        <TabsTrigger value="model">
          <Cpu className="h-4 w-4 mr-2" />
          {t("analytics.tabs.model", "模型")}
        </TabsTrigger>
        <TabsTrigger value="endpoint">
          <Radio className="h-4 w-4 mr-2" />
          {t("analytics.tabs.endpoint", "端点")}
        </TabsTrigger>
        <TabsTrigger value="subdomain">
          <Globe className="h-4 w-4 mr-2" />
          {t("analytics.tabs.subdomain", "子域名")}
        </TabsTrigger>
      </TabsList>

      {/* By User */}
      <TabsContent value="user" className="flex-1 min-h-0 data-[state=active]:flex flex-col m-0">
        <Card className="flex-1 flex flex-col min-h-0">
          <CardHeader className="shrink-0">
            <CardTitle>{t("analytics.breakdown.userTitle", "按用户统计")}</CardTitle>
          </CardHeader>
          <CardContent className="flex-1 overflow-auto">
            {byUser.length === 0 ? (
              <EmptyState
                icon={<Users className="h-12 w-12" />}
                title={t("analytics.breakdown.noUserData", "暂无用户数据")}
                description={t("analytics.breakdown.noUserDesc", "还没有用户使用记录")}
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("analytics.table.username", "用户名")}</TableHead>
                    <TableHead className="text-right">{t("analytics.table.requests", "请求数")}</TableHead>
                    <TableHead className="text-right">{t("analytics.table.tokens", "Tokens")}</TableHead>
                    <TableHead className="text-right">{t("common.cost", "费用")}</TableHead>
                    <TableHead className="text-right">{t("analytics.table.avgLatency", "平均延迟")}</TableHead>
                    <TableHead className="text-right">{t("analytics.table.successRate", "成功率")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {byUser.map((item, i) => (
                    <TableRow
                      key={i}
                      className="cursor-pointer hover:bg-muted/50"
                      onClick={() => onOpenDetail("user", item.userId, item.username || t("analytics.table.unknown", "未知"))}
                    >
                      <TableCell className="font-medium">
                        {item.username || t("analytics.table.unknown", "未知")}
                      </TableCell>
                      <TableCell className="text-right">
                        {item.totalRequests.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="font-semibold">{formatToken(item.totalTokens)}</div>
                        <div className="text-xs text-muted-foreground mt-0.5">
                          {t("analytics.table.tokenBreakdownShort", "入: {{input}} / 出: {{output}}", {
                            input: formatToken(item.totalInputTokens || 0),
                            output: formatToken(item.totalOutputTokens || 0),
                          })}
                        </div>
                      </TableCell>
                      <TableCell className="text-right font-semibold text-foreground">
                        {item.totalCost != null ? formatCost(item.totalCost) : "-"}
                      </TableCell>
                      <TableCell className="text-right">
                        {Math.round(item.avgLatencyMs)}ms
                      </TableCell>
                      <TableCell className="text-right">
                        {Math.round(item.successRate)}%
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </TabsContent>

      {/* By Provider */}
      <TabsContent value="provider" className="flex-1 min-h-0 data-[state=active]:flex flex-col m-0">
        <Card className="flex-1 flex flex-col min-h-0">
          <CardHeader className="shrink-0">
            <CardTitle>{t("analytics.breakdown.providerTitle", "按供应商统计")}</CardTitle>
          </CardHeader>
          <CardContent className="flex-1 overflow-auto">
            {byProvider.length === 0 ? (
              <EmptyState
                icon={<Server className="h-12 w-12" />}
                title={t("analytics.breakdown.noProviderData", "暂无供应商数据")}
                description={t("analytics.breakdown.noProviderDesc", "还没有供应商使用记录")}
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("analytics.table.providerName", "供应商名称")}</TableHead>
                    <TableHead className="text-right">{t("analytics.table.requests", "请求数")}</TableHead>
                    <TableHead className="text-right">{t("analytics.table.tokens", "Tokens")}</TableHead>
                    <TableHead className="text-right">{t("common.cost", "费用")}</TableHead>
                    <TableHead className="text-right">{t("analytics.table.avgLatency", "平均延迟")}</TableHead>
                    <TableHead className="text-right">{t("analytics.table.successRate", "成功率")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {byProvider.map((item, i) => (
                    <TableRow
                      key={i}
                      className="cursor-pointer hover:bg-muted/50"
                      onClick={() => onOpenDetail("provider", item.providerId, item.providerName || t("analytics.table.unknown", "未知"))}
                    >
                      <TableCell className="font-medium">
                        {item.providerName || t("analytics.table.unknown", "未知")}
                      </TableCell>
                      <TableCell className="text-right">
                        {item.totalRequests.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="font-semibold">{formatToken(item.totalTokens)}</div>
                        <div className="text-xs text-muted-foreground mt-0.5">
                          {t("analytics.table.tokenBreakdownShort", "入: {{input}} / 出: {{output}}", {
                            input: formatToken(item.totalInputTokens || 0),
                            output: formatToken(item.totalOutputTokens || 0),
                          })}
                        </div>
                      </TableCell>
                      <TableCell className="text-right font-semibold text-foreground">
                        {item.totalCost != null ? formatCost(item.totalCost) : "-"}
                      </TableCell>
                      <TableCell className="text-right">
                        {Math.round(item.avgLatencyMs)}ms
                      </TableCell>
                      <TableCell className="text-right">
                        {Math.round(item.successRate)}%
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </TabsContent>

      {/* By Provider Key */}
      <TabsContent value="providerKey" className="flex-1 min-h-0 data-[state=active]:flex flex-col m-0">
        <Card className="flex-1 flex flex-col min-h-0">
          <CardHeader className="shrink-0">
            <CardTitle>{t("analytics.breakdown.providerKeyTitle", "按供应商密钥统计")}</CardTitle>
          </CardHeader>
          <CardContent className="flex-1 overflow-auto">
            {byProviderKey.length === 0 ? (
              <EmptyState
                icon={<Key className="h-12 w-12" />}
                title={t("analytics.breakdown.noProviderKeyData", "暂无密钥数据")}
                description={t("analytics.breakdown.noProviderKeyDesc", "还没有带有密钥记录的请求")}
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("analytics.table.providerName", "供应商名称")}</TableHead>
                    <TableHead>{t("analytics.table.apiKey", "API Key")}</TableHead>
                    <TableHead className="text-right">{t("analytics.table.requests", "请求数")}</TableHead>
                    <TableHead className="text-right">{t("analytics.table.tokens", "Tokens")}</TableHead>
                    <TableHead className="text-right">{t("common.cost", "费用")}</TableHead>
                    <TableHead className="text-right">{t("analytics.table.avgLatency", "平均延迟")}</TableHead>
                    <TableHead className="text-right">{t("analytics.table.successRate", "成功率")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {byProviderKey.map((item, i) => (
                    <TableRow
                      key={i}
                      className="cursor-pointer hover:bg-muted/50"
                      onClick={() => onOpenDetail("provider", item.providerId, item.providerName || t("analytics.table.unknown", "未知"))}
                    >
                      <TableCell className="font-medium">
                        {item.providerName || t("analytics.table.unknown", "未知")}
                      </TableCell>
                      <TableCell>
                        <code className="font-mono text-xs text-muted-foreground break-all whitespace-pre-wrap">
                          {item.apiKey || t("analytics.table.unknownKey", "未知 / 遗留密钥")}
                        </code>
                      </TableCell>
                      <TableCell className="text-right">
                        {item.totalRequests.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="font-semibold">{formatToken(item.totalTokens)}</div>
                        <div className="text-xs text-muted-foreground mt-0.5">
                          {t("analytics.table.tokenBreakdownShort", "入: {{input}} / 出: {{output}}", {
                            input: formatToken(item.totalInputTokens || 0),
                            output: formatToken(item.totalOutputTokens || 0),
                          })}
                        </div>
                      </TableCell>
                      <TableCell className="text-right font-semibold text-foreground">
                        {item.totalCost != null ? formatCost(item.totalCost) : "-"}
                      </TableCell>
                      <TableCell className="text-right">
                        {Math.round(item.avgLatencyMs)}ms
                      </TableCell>
                      <TableCell className="text-right">
                        {Math.round(item.successRate)}%
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </TabsContent>

      {/* By Model */}
      <TabsContent value="model" className="flex-1 min-h-0 data-[state=active]:flex flex-col m-0">
        <Card className="flex-1 flex flex-col min-h-0">
          <CardHeader className="shrink-0">
            <CardTitle>{t("analytics.breakdown.modelTitle", "按模型统计")}</CardTitle>
          </CardHeader>
          <CardContent className="flex-1 overflow-auto">
            {byModel.length === 0 ? (
              <EmptyState
                icon={<Cpu className="h-12 w-12" />}
                title={t("analytics.breakdown.noModelData", "暂无模型数据")}
                description={t("analytics.breakdown.noModelDesc", "还没有模型使用记录")}
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("analytics.table.modelName", "模型名称")}</TableHead>
                    <TableHead className="text-right">{t("analytics.table.requests", "请求数")}</TableHead>
                    <TableHead className="text-right">{t("analytics.table.tokens", "Tokens")}</TableHead>
                    <TableHead className="text-right">{t("common.cost", "费用")}</TableHead>
                    <TableHead className="text-right">{t("analytics.table.avgLatency", "平均延迟")}</TableHead>
                    <TableHead className="text-right">{t("analytics.table.successRate", "成功率")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {byModel.map((item, i) => (
                    <TableRow
                      key={i}
                      className="cursor-pointer hover:bg-muted/50"
                      onClick={() => onOpenDetail("model", item.model, item.model || t("analytics.table.unknown", "未知"))}
                    >
                      <TableCell className="font-medium font-mono">
                        {item.model || t("analytics.table.unknown", "未知")}
                      </TableCell>
                      <TableCell className="text-right">
                        {item.totalRequests.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="font-semibold">{formatToken(item.totalTokens)}</div>
                        <div className="text-xs text-muted-foreground mt-0.5">
                          {t("analytics.table.tokenBreakdownShort", "入: {{input}} / 出: {{output}}", {
                            input: formatToken(item.totalInputTokens || 0),
                            output: formatToken(item.totalOutputTokens || 0),
                          })}
                        </div>
                      </TableCell>
                      <TableCell className="text-right font-semibold text-foreground">
                        {item.totalCost != null ? formatCost(item.totalCost) : "-"}
                      </TableCell>
                      <TableCell className="text-right">
                        {Math.round(item.avgLatencyMs)}ms
                      </TableCell>
                      <TableCell className="text-right">
                        {Math.round(item.successRate)}%
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </TabsContent>

      {/* By Endpoint */}
      <TabsContent value="endpoint" className="flex-1 min-h-0 data-[state=active]:flex flex-col m-0">
        <Card className="flex-1 flex flex-col min-h-0">
          <CardHeader className="shrink-0">
            <CardTitle>{t("analytics.breakdown.endpointTitle", "按端点统计")}</CardTitle>
          </CardHeader>
          <CardContent className="flex-1 overflow-auto">
            {byEndpoint.length === 0 ? (
              <EmptyState
                icon={<Radio className="h-12 w-12" />}
                title={t("analytics.breakdown.noEndpointData", "暂无端点数据")}
                description={t("analytics.breakdown.noEndpointDesc", "还没有端点使用记录")}
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("analytics.table.endpointName", "端点名称")}</TableHead>
                    <TableHead>{t("analytics.table.path", "路径")}</TableHead>
                    <TableHead className="text-right">{t("analytics.table.requests", "请求数")}</TableHead>
                    <TableHead className="text-right">{t("analytics.table.tokens", "Tokens")}</TableHead>
                    <TableHead className="text-right">{t("common.cost", "费用")}</TableHead>
                    <TableHead className="text-right">{t("analytics.table.avgLatency", "平均延迟")}</TableHead>
                    <TableHead className="text-right">{t("analytics.table.successRate", "成功率")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {byEndpoint.map((item, i) => (
                    <TableRow
                      key={i}
                      className="cursor-pointer hover:bg-muted/50"
                      onClick={() => onOpenDetail("endpoint", item.endpointId, item.endpointName || item.endpointPath || t("analytics.table.unknown", "未知"))}
                    >
                      <TableCell className="font-medium">
                        {item.endpointName || t("analytics.table.unknown", "未知")}
                      </TableCell>
                      <TableCell className="font-mono text-sm">
                        {item.endpointPath || "-"}
                      </TableCell>
                      <TableCell className="text-right">
                        {item.totalRequests.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="font-semibold">{formatToken(item.totalTokens)}</div>
                        <div className="text-xs text-muted-foreground mt-0.5">
                          {t("analytics.table.tokenBreakdownShort", "入: {{input}} / 出: {{output}}", {
                            input: formatToken(item.totalInputTokens || 0),
                            output: formatToken(item.totalOutputTokens || 0),
                          })}
                        </div>
                      </TableCell>
                      <TableCell className="text-right font-semibold text-foreground">
                        {item.totalCost != null ? formatCost(item.totalCost) : "-"}
                      </TableCell>
                      <TableCell className="text-right">
                        {Math.round(item.avgLatencyMs)}ms
                      </TableCell>
                      <TableCell className="text-right">
                        {Math.round(item.successRate)}%
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </TabsContent>

      {/* By Subdomain */}
      <TabsContent value="subdomain" className="flex-1 min-h-0 data-[state=active]:flex flex-col m-0">
        <Card className="flex-1 flex flex-col min-h-0">
          <CardHeader className="shrink-0">
            <CardTitle>{t("analytics.breakdown.subdomainTitle", "按子域名统计")}</CardTitle>
          </CardHeader>
          <CardContent className="flex-1 overflow-auto">
            {bySubdomain.length === 0 ? (
              <EmptyState
                icon={<Globe className="h-12 w-12" />}
                title={t("analytics.breakdown.noSubdomainData", "暂无子域名数据")}
                description={t("analytics.breakdown.noSubdomainDesc", "还没有子域名使用记录")}
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("analytics.table.subdomain", "子域名")}</TableHead>
                    <TableHead>{t("analytics.table.hostname", "主机名")}</TableHead>
                    <TableHead className="text-right">{t("analytics.table.requests", "请求数")}</TableHead>
                    <TableHead className="text-right">{t("analytics.table.tokens", "Tokens")}</TableHead>
                    <TableHead className="text-right">{t("common.cost", "费用")}</TableHead>
                    <TableHead className="text-right">{t("analytics.table.avgLatency", "平均延迟")}</TableHead>
                    <TableHead className="text-right">{t("analytics.table.successRate", "成功率")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {bySubdomain.map((item, i) => (
                    <TableRow
                      key={i}
                      className="cursor-pointer hover:bg-muted/50"
                      onClick={() => onOpenDetail("subdomain", item.subdomainId, item.subdomainName || item.subdomainHostname || t("analytics.table.unknown", "未知"))}
                    >
                      <TableCell className="font-medium">
                        {item.subdomainName || t("analytics.table.unknown", "未知")}
                      </TableCell>
                      <TableCell className="font-mono text-sm">
                        {item.subdomainHostname || "-"}
                      </TableCell>
                      <TableCell className="text-right">
                        {item.totalRequests.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="font-semibold">{formatToken(item.totalTokens)}</div>
                        <div className="text-xs text-muted-foreground mt-0.5">
                          {t("analytics.table.tokenBreakdownShort", "入: {{input}} / 出: {{output}}", {
                            input: formatToken(item.totalInputTokens || 0),
                            output: formatToken(item.totalOutputTokens || 0),
                          })}
                        </div>
                      </TableCell>
                      <TableCell className="text-right font-semibold text-foreground">
                        {item.totalCost != null ? formatCost(item.totalCost) : "-"}
                      </TableCell>
                      <TableCell className="text-right">
                        {Math.round(item.avgLatencyMs)}ms
                      </TableCell>
                      <TableCell className="text-right">
                        {Math.round(item.successRate)}%
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </TabsContent>
    </Tabs>
  );
}
