import { useState, useEffect } from "react";
import { Link } from "wouter";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { fetchApi } from "@/lib/api";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { RefreshCw, Loader2, CheckCircle2, XCircle } from "lucide-react";

interface ProviderModelsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  provider: any | null;
  onRefreshSuccess: () => void;
}

function ModelRow({ model, onChange }: { model: any; onChange: (field: string, value: any) => void }) {
  const { t } = useTranslation();

  return (
    <TableRow className="hover:bg-muted/50 transition-colors">
      <TableCell className="py-3.5">
        <div className="flex-1 min-w-0">
          <div className="font-medium text-zinc-900 dark:text-zinc-100 truncate">{model.displayName}</div>
          <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5 font-mono truncate">{model.modelId}</div>
        </div>
      </TableCell>
      <TableCell className="py-3.5">
        <Switch
          checked={model.enabled}
          onCheckedChange={(checked) => onChange("enabled", checked)}
        />
      </TableCell>
      <TableCell className="py-3.5">
        <Switch
          checked={model.useOpencodeProxy}
          onCheckedChange={(checked) => onChange("useOpencodeProxy", checked)}
        />
      </TableCell>
      <TableCell className="py-3.5">
        <Input
          type="text"
          value={model.alias || ""}
          onChange={(e) => {
            const val = e.target.value;
            onChange("alias", val === "" ? null : val);
          }}
          placeholder={t("providers.modelList.placeholders.alias", "留空则显示原名")}
          className="h-9 w-36 text-sm bg-background border-zinc-200 dark:border-zinc-800 rounded-md focus-visible:ring-primary"
        />
      </TableCell>
      <TableCell className="py-3.5">
        <Input
          type="text"
          value={model.tokenizerRepo || ""}
          onChange={(e) => {
            const val = e.target.value;
            onChange("tokenizerRepo", val === "" ? null : val);
          }}
          placeholder={t("providers.modelList.placeholders.tokenizerRepo", "自动/通用规则")}
          className="h-9 w-32 text-sm bg-background border-zinc-200 dark:border-zinc-800 rounded-md focus-visible:ring-primary"
        />
      </TableCell>

      <TableCell className="py-3.5">
        <div className="relative flex items-center">
          <Input
            type="number"
            min="0"
            value={model.contextWindowTokens !== null && model.contextWindowTokens !== undefined ? model.contextWindowTokens : ""}
            onChange={(e) => {
              const val = e.target.value;
              onChange("contextWindowTokens", val === "" ? null : parseInt(val, 10));
            }}
            placeholder={t("providers.modelList.placeholders.uncapped", "不限")}
            title={t(
              "providers.modelList.hints.contextWindow",
              "模型总上下文窗口，用于长上下文策略路由。留空则不预判，依赖上游错误后 fallback。",
            )}
            className="h-9 w-28 text-center text-sm font-medium bg-background border-zinc-200 dark:border-zinc-800 rounded-md focus-visible:ring-primary"
          />
        </div>
      </TableCell>
      <TableCell className="py-3.5">
        <div className="relative flex items-center">
          <Input
            type="number"
            min="0"
            value={model.maxOutputTokens !== null && model.maxOutputTokens !== undefined ? model.maxOutputTokens : ""}
            onChange={(e) => {
              const val = e.target.value;
              onChange("maxOutputTokens", val === "" ? null : parseInt(val, 10));
            }}
            placeholder={t("providers.modelList.placeholders.uncapped", "不限")}
            title={t(
              "providers.modelList.hints.maxOutput",
              "仅裁剪请求中的 max_tokens，不参与上下文路由。",
            )}
            className="h-9 w-28 text-center text-sm font-medium bg-background border-zinc-200 dark:border-zinc-800 rounded-md focus-visible:ring-primary"
          />
        </div>
      </TableCell>
      <TableCell className="py-3.5">
        <div className="relative flex items-center">
          <span className="absolute left-3 text-muted-foreground text-xs font-semibold">$</span>
          <Input
            type="number"
            step="any"
            min="0"
            value={model.inputTokenPricePerM !== null && model.inputTokenPricePerM !== undefined ? model.inputTokenPricePerM : ""}
            onChange={(e) => {
              const val = e.target.value;
              onChange("inputTokenPricePerM", val === "" ? null : parseFloat(val));
            }}
            placeholder="0.00"
            className="h-9 w-24 pl-6 text-right text-sm font-medium bg-background border-zinc-200 dark:border-zinc-800 rounded-md focus-visible:ring-primary"
          />
        </div>
      </TableCell>
      <TableCell className="py-3.5">
        <div className="relative flex items-center">
          <span className="absolute left-3 text-muted-foreground text-xs font-semibold">$</span>
          <Input
            type="number"
            step="any"
            min="0"
            value={model.outputTokenPricePerM !== null && model.outputTokenPricePerM !== undefined ? model.outputTokenPricePerM : ""}
            onChange={(e) => {
              const val = e.target.value;
              onChange("outputTokenPricePerM", val === "" ? null : parseFloat(val));
            }}
            placeholder="0.00"
            className="h-9 w-24 pl-6 text-right text-sm font-medium bg-background border-zinc-200 dark:border-zinc-800 rounded-md focus-visible:ring-primary"
          />
        </div>
      </TableCell>
    </TableRow>
  );
}

export function ProviderModelsModal({ open, onOpenChange, provider, onRefreshSuccess }: ProviderModelsModalProps) {
  const { t } = useTranslation();
  const [providerModels, setProviderModels] = useState<any[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [refreshingModels, setRefreshingModels] = useState(false);
  const [savingModels, setSavingModels] = useState(false);
  const [opencodeStatus, setOpencodeStatus] = useState<{ready: boolean, running: boolean} | null>(null);

  useEffect(() => {
    if (open) {
      fetchApi("/admin/opencode/status").then(res => setOpencodeStatus(res)).catch(() => {});
    }
  }, [open]);

  useEffect(() => {
    if (open && provider) {
      loadModels();
    }
  }, [open, provider]);

  const loadModels = async () => {
    setLoadingModels(true);
    try {
      const res = await fetchApi(`/admin/providers/${provider.id}/models`);
      setProviderModels(res);
    } catch (e: any) {
      toast.error(t("providers.modelList.refreshFailed", "获取模型列表失败") + ": " + e.message);
    } finally {
      setLoadingModels(false);
    }
  };

  const handleRefreshModels = async () => {
    if (!provider) return;
    setRefreshingModels(true);
    try {
      const res = await fetchApi(`/admin/providers/${provider.id}/refresh-models`, {
        method: "POST",
        body: "{}"
      });
      if (res.success) {
        toast.success(t("providers.modelList.refreshSuccess", "刷新成功，已入库 {{count}} 个模型", { count: res.count }));
        onRefreshSuccess();
        loadModels();
      } else {
        toast.error(t("providers.modelList.refreshFailed", "刷新失败") + ": " + res.message);
      }
    } catch (e: any) {
      toast.error(t("providers.modelList.refreshFailed", "刷新失败") + ": " + e.message);
    } finally {
      setRefreshingModels(false);
    }
  };

  const handleModelFieldChange = (modelKey: string, field: string, value: any) => {
    setProviderModels(prev =>
      prev.map(m => ((m.id || m.modelId) === modelKey ? { ...m, [field]: value } : m))
    );
  };

  const handleToggleAllModels = (enabled: boolean) => {
    setProviderModels(prev => prev.map(m => ({ ...m, enabled })));
  };

  const allModelsEnabled = providerModels.length > 0 && providerModels.every(m => m.enabled);

  const handleSaveAllModels = async () => {
    if (!provider) return;
    setSavingModels(true);
    try {
      await fetchApi(`/admin/providers/${provider.id}/models`, {
        method: "PATCH",
        body: JSON.stringify(
          providerModels.map(m => ({
            modelId: m.modelId,
            enabled: m.enabled,
            contextWindowTokens: m.contextWindowTokens,
            maxOutputTokens: m.maxOutputTokens,
            inputTokenPricePerM: m.inputTokenPricePerM,
            outputTokenPricePerM: m.outputTokenPricePerM,
            tokenizerRepo: m.tokenizerRepo,
            useOpencodeProxy: Boolean(m.useOpencodeProxy),
            alias: m.alias,
          }))
        ),
      });
      toast.success(t("providers.modelList.toasts.saveSuccess", "模型配置已保存"));
      onOpenChange(false);
    } catch (e: any) {
      toast.error(t("providers.modelList.toasts.saveFailed", "保存失败") + ": " + e.message);
    } finally {
      setSavingModels(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[1180px] h-[85vh] flex flex-col p-0 overflow-hidden bg-background">
        <DialogHeader className="px-6 py-4 border-b shrink-0 bg-muted/30">
          <DialogTitle>{t("providers.modelList.title", "配置供应商模型")} - {provider?.name}</DialogTitle>
          <DialogDescription>
            {t(
              "providers.modelList.description",
              "精细化配置该供应商下的所有可用模型。「最大上下文」用于长上下文策略路由；「最大输出」仅裁剪请求 max_tokens。",
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 flex flex-col px-6">
          <div className="flex items-center justify-between px-6 py-4 border-b bg-muted/20 shrink-0">
            <div className="flex gap-2">
              <Button
                variant="default"
                size="sm"
                onClick={handleRefreshModels}
                disabled={refreshingModels}
                className="gap-2 shadow-sm font-medium"
              >
                <RefreshCw className={`h-4 w-4 ${refreshingModels ? 'animate-spin' : ''}`} />
                {refreshingModels ? t("providers.modelList.actions.refreshing", "获取中...") : t("providers.modelList.actions.refresh", "自动获取可用模型")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleToggleAllModels(!allModelsEnabled)}
                disabled={loadingModels || providerModels.length === 0}
                className="gap-1.5 text-xs font-medium"
              >
                {allModelsEnabled ? (
                  <>
                    <XCircle className="h-3.5 w-3.5 text-rose-500" />
                    {t("providers.modelList.disableAll", "一键关闭")}
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                    {t("providers.modelList.enableAll", "一键启用")}
                  </>
                )}
              </Button>
            </div>
            <div className="text-sm text-muted-foreground font-medium">
              {t("providers.modelList.total", "共计")}: <span className="text-foreground">{providerModels.length}</span> {t("providers.modelList.unit", "个模型")}
            </div>
          </div>

          {providerModels.some(m => m.useOpencodeProxy) && opencodeStatus && !opencodeStatus.ready && (
             <div className="mx-6 mt-4 p-3 bg-amber-50 dark:bg-amber-950 text-amber-800 dark:text-amber-200 rounded text-sm font-medium">
               ⚠️ {t("providers.modelList.opencodeWarning", "已为部分模型开启兼容通道，但 sidecar 尚未就绪。请前往系统信息安装。")}
               {" "}
               <Link href="/system-info" className="underline font-bold" onClick={() => onOpenChange(false)}>
                 {t("providers.modelList.opencodeWarningLink", "前往系统信息")}
               </Link>
             </div>
          )}

          <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar -mx-6 px-6 mt-4">
            <Table>
              <TableHeader className="sticky top-0 bg-background/95 backdrop-blur z-10 shadow-sm">
                <TableRow className="border-b-0 hover:bg-transparent">
                  <TableHead className="font-semibold">{t("providers.modelList.table.name", "模型名称 / ID")}</TableHead>
                  <TableHead className="w-24 font-semibold">{t("providers.modelList.table.enable", "启用")}</TableHead>
                  <TableHead className="w-24 font-semibold">{t("providers.modelList.table.opencode", "兼容通道")}</TableHead>
                  <TableHead className="w-40 font-semibold">{t("providers.modelList.table.alias", "别名")}</TableHead>
                  <TableHead className="w-36 font-semibold">{t("providers.modelList.table.tokenizer", "分词器")}</TableHead>
                  <TableHead className="w-32 font-semibold">{t("providers.modelList.table.contextWindow", "最大上下文")}</TableHead>
                  <TableHead className="w-32 font-semibold">{t("providers.modelList.table.maxTokens", "最大输出限制")}</TableHead>
                  <TableHead className="w-32 font-semibold">{t("providers.modelList.table.inputPrice", "输入 (1M)")}</TableHead>
                  <TableHead className="w-32 font-semibold">{t("providers.modelList.table.outputPrice", "输出 (1M)")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loadingModels ? (
                  <TableRow>
                    <TableCell colSpan={9} className="h-64 text-center">
                      <div className="flex flex-col items-center justify-center text-muted-foreground gap-3">
                        <Loader2 className="h-6 w-6 animate-spin text-primary" />
                        <span className="text-sm">{t("providers.modelList.loading", "加载中...")}</span>
                      </div>
                    </TableCell>
                  </TableRow>
                ) : providerModels.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={9} className="h-64 text-center text-muted-foreground">
                      <div className="flex flex-col items-center justify-center gap-2">
                        <p>{t("providers.modelList.empty", "暂无模型，请点击获取列表。")}</p>
                      </div>
                    </TableCell>
                  </TableRow>
                ) : (
                  providerModels.map((m) => (
                    <ModelRow
                      key={m.id || m.modelId}
                      model={m}
                      onChange={(field, value) => handleModelFieldChange(m.id || m.modelId, field, value)}
                    />
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </div>

        <DialogFooter className="px-6 py-4 border-t shrink-0 bg-muted/10">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("common.cancel", "取消")}
          </Button>
          <Button onClick={handleSaveAllModels} disabled={savingModels}>
            {savingModels ? t("common.saving", "保存中...") : t("providers.modelList.actions.save", "保存修改")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
