import { useState, useEffect } from "react";
import { fetchApi } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Label } from "@/components/ui/label";
import { Route as RouteIcon, Edit2, AlertCircle, SlidersHorizontal } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { EmptyState } from "@/components/EmptyState";

import { UserStrategyEditor } from "@/components/Routes/UserStrategyEditor";
import { StrategyRoutingRule } from "@/components/Routes/types";

interface UserRoute {
  id: string;
  name: string;
  host: string;
  path: string;
  incomingProtocol: string;
  allowClientModel?: boolean;
  providerId?: string;
  providerName?: string;
  defaultModelId?: string;
  defaultModelName?: string;
  overrideModelId?: string | null;
  overrideStrategyRules?: string | null;
  strategyRoutingEnabled?: boolean;
  strategyRoutingRules?: string;
  providerProtocol?: string;
}

interface ProviderModel {
  modelId: string;
  displayName?: string;
  protocol: "openai" | "anthropic";
  enabled?: boolean;
}

export default function UserRoutes() {
  const { t } = useTranslation();
  const [routes, setRoutes] = useState<UserRoute[]>([]);
  const [loading, setLoading] = useState(true);

  // Dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingRoute, setEditingRoute] = useState<UserRoute | null>(null);
  const [models, setModels] = useState<ProviderModel[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [overrideMode, setOverrideMode] = useState<"default" | "fixed" | "strategy">("default");
  const [strategyRules, setStrategyRules] = useState<StrategyRoutingRule[]>([]);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      const data = await fetchApi("/user/routes");
      setRoutes(data);
    } catch (e: any) {
      toast.error(t("routes.toasts.loadFailed", "加载失败") + ": " + e.message);
    } finally {
      setLoading(false);
    }
  };

  const openEdit = async (route: UserRoute) => {
    if (!route.allowClientModel) return;
    
    setEditingRoute(route);
    
    let mode: "default" | "fixed" | "strategy" = "default";
    let initialRules: StrategyRoutingRule[] = [];
    
    if (route.overrideStrategyRules) {
      mode = "strategy";
      setSelectedModel("default");
      try {
        initialRules = JSON.parse(route.overrideStrategyRules);
      } catch (e) {}
    } else if (route.overrideModelId) {
      mode = "fixed";
      setSelectedModel(route.overrideModelId);
    } else {
      setSelectedModel("default");
      if (route.strategyRoutingEnabled && route.strategyRoutingRules) {
        try {
          initialRules = JSON.parse(route.strategyRoutingRules);
        } catch (e) {}
      }
    }
    
    setOverrideMode(mode);
    setStrategyRules(initialRules);
    setDialogOpen(true);
    setLoadingModels(true);
    setModels([]);

    try {
      const res = await fetchApi(`/user/providers/${route.providerId}/models`);
      setModels(res.filter((m: ProviderModel) => m.enabled !== false));
    } catch (e: any) {
      toast.error(t("routes.toasts.loadModelsFailed", "加载模型失败") + ": " + e.message);
    } finally {
      setLoadingModels(false);
    }
  };

  const closeDialog = () => {
    setDialogOpen(false);
    setEditingRoute(null);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingRoute) return;

    try {
      let body: any = {};
      if (overrideMode === "default") {
        body = { modelId: null, strategyRoutingRules: null };
      } else if (overrideMode === "fixed") {
        body = { modelId: selectedModel === "default" || selectedModel === "" ? null : selectedModel, strategyRoutingRules: null };
      } else if (overrideMode === "strategy") {
        body = { modelId: null, strategyRoutingRules: JSON.stringify(strategyRules) };
      }

      await fetchApi(`/user/routes/${editingRoute.id}/override`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      toast.success(t("common.saveSuccess", "保存成功"));
      loadData();
      closeDialog();
    } catch (e: any) {
      toast.error(t("common.saveFailed", "保存失败") + ": " + e.message);
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <Card><CardContent className="p-6"><Skeleton className="h-64 w-full" /></CardContent></Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("routes.userRoutes.dialogTitle", "选择自定义模型")}</DialogTitle>
            <DialogDescription>
              {t("routes.userRoutes.dialogDesc", { name: editingRoute?.name, defaultValue: `为 "${editingRoute?.name}" 选择一个不同的模型。这将仅对您生效，覆盖该路由的默认配置。` })}
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleSave} className="space-y-4 pt-4">
            {editingRoute?.strategyRoutingEnabled && (
              <div className="space-y-2">
                <Label className="text-sm font-medium">{t("routes.userRoutes.overrideMode", "覆盖模式")}</Label>
                <Select value={overrideMode} onValueChange={(val: any) => { setOverrideMode(val); if (val === "default") setSelectedModel("default"); }} disabled={loadingModels}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="default">{t("routes.userRoutes.modeDefault", "默认策略")}</SelectItem>
                    <SelectItem value="fixed">{t("routes.userRoutes.modeFixed", "全局固定模型")}</SelectItem>
                    <SelectItem value="strategy">{t("routes.userRoutes.modeStrategy", "自定义策略映射")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}

            {(!editingRoute?.strategyRoutingEnabled || overrideMode === "fixed") && (
              <div className="space-y-2">
                <Label className="text-sm font-medium">{t("routes.userRoutes.modelLabel", "模型")}</Label>
                <Select value={selectedModel} onValueChange={setSelectedModel} disabled={loadingModels}>
                  <SelectTrigger>
                    <SelectValue placeholder={loadingModels ? t("common.loading", "加载中...") : t("routes.userRoutes.selectModel", "选择模型")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="default">
                      {editingRoute?.strategyRoutingEnabled 
                        ? t("routes.userRoutes.strategyDefault", "策略路由 (默认)") 
                        : t("routes.userRoutes.defaultModel", { name: editingRoute?.defaultModelName, defaultValue: `默认模型 (${editingRoute?.defaultModelName})` })
                      }
                    </SelectItem>
                    {models.map(m => (
                      <SelectItem key={m.modelId} value={m.modelId}>
                        {m.displayName || m.modelId} {m.modelId === editingRoute?.defaultModelId ? t("routes.userRoutes.defaultBadge", "(默认)") : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {editingRoute?.strategyRoutingEnabled && overrideMode === "strategy" && (
              <div className="space-y-2 pt-2 border-t mt-4">
                <UserStrategyEditor
                  rules={strategyRules}
                  onChange={setStrategyRules}
                  models={models}
                  providerId={editingRoute.providerId!}
                  providerProtocol={(editingRoute.providerProtocol as any) || "openai"}
                />
              </div>
            )}

            <DialogFooter>
              <Button type="button" variant="ghost" onClick={closeDialog}>{t("common.cancel", "取消")}</Button>
              <Button type="submit">{t("common.save", "保存")}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Card>
        <CardContent className="p-0">
          {routes.length === 0 ? (
            <EmptyState
              icon={<RouteIcon className="h-12 w-12" />}
              title={t("routes.empty.title", "暂无路由")}
              description={t("routes.empty.userDescription", "您当前没有可访问的路由。")}
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("routes.table.name", "名称")}</TableHead>
                  <TableHead>{t("routes.table.protocol", "协议")}</TableHead>
                  <TableHead>{t("routes.table.trigger", "触发条件 (Host + Path)")}</TableHead>
                  <TableHead>{t("routes.table.currentModel", "当前使用模型")}</TableHead>
                  <TableHead className="text-right">{t("routes.table.actions", "操作")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {routes.map(r => (
                  <TableRow key={r.id}>
                    <TableCell className="font-medium">{r.name}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-zinc-500">{r.incomingProtocol === 'openai' ? 'OpenAI' : 'Anthropic'}</Badge>
                    </TableCell>
                    <TableCell>
                      <div className="text-sm">{r.host}</div>
                      <div className="text-xs text-muted-foreground">{r.path}</div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col">
                        {r.overrideStrategyRules ? (
                          <span className="text-sm flex items-center text-blue-600 dark:text-blue-500 font-medium">
                            <SlidersHorizontal className="h-3.5 w-3.5 mr-1.5" />
                            {t("routes.userRoutes.customStrategy", "已覆盖个人策略")}
                          </span>
                        ) : r.overrideModelId ? (
                          <span className="text-sm">
                            {r.overrideModelId}
                          </span>
                        ) : r.strategyRoutingEnabled ? (
                          <span className="text-sm flex items-center text-emerald-600 dark:text-emerald-500 font-medium">
                            <SlidersHorizontal className="h-3.5 w-3.5 mr-1.5" />
                            {t("routes.table.strategyRouting", "策略路由")}
                          </span>
                        ) : (
                          <span className="text-sm">
                            {r.defaultModelName || t("routes.userRoutes.unknownModel", "未知模型")}
                          </span>
                        )}
                        {r.overrideModelId && (
                          <span className="text-xs text-blue-500 font-medium flex items-center mt-0.5">
                            {t("routes.userRoutes.overridden", "已覆盖默认模型")}
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      {r.allowClientModel ? (
                        <Button variant="ghost" size="sm" onClick={() => openEdit(r)}>
                          <Edit2 className="h-4 w-4 mr-1" />
                          {t("routes.userRoutes.customize", "自定义")}
                        </Button>
                      ) : (
                        <span className="text-xs text-muted-foreground">{t("routes.userRoutes.notConfigurable", "不可配置")}</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
