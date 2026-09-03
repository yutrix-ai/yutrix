import { useState, useEffect } from "react";
import { fetchApi } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/EmptyState";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Server, Edit2, Trash2, Plus, Key, Copy } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { ProviderApiKeysModal } from "../components/ProviderApiKeysModal";
import { ProviderModelsModal } from "../components/ProviderModelsModal";
import { ProviderEditModal } from "../components/ProviderEditModal";

export interface Provider {
  id: string;
  name: string;
  openaiBaseUrl?: string;
  anthropicBaseUrl?: string;
  timeoutMs: number;
  streamTimeoutMs?: number;
  concurrencyLimit: number;
  maxOutputTokens: number;
  hourlyTokenLimit?: number;
  enabled: boolean;
  modelsCount: number;
  keysCount: number;
  activeKeysCount: number;
  lastTestStatus?: "success" | "failed";
  lastTestAt?: string;
  upstreamProxyUrl?: string;
  weightProxyUrl?: string;
  manualModels?: string[];
}

export default function Providers() {
  const { t } = useTranslation();
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(true);

  // Dialog states
  const [editDialog, setEditDialog] = useState<{ open: boolean; provider: Provider | null; copying?: boolean }>({ open: false, provider: null, copying: false });
  const [modelListDialog, setModelListDialog] = useState<{ open: boolean; provider: Provider | null }>({ open: false, provider: null });
  const [apiKeysDialog, setApiKeysDialog] = useState<{ open: boolean; provider: Provider | null }>({ open: false, provider: null });
  
  const [deleteConfirm, setDeleteConfirm] = useState<{
    open: boolean;
    providerId: string | null;
    providerName: string;
  }>({ open: false, providerId: null, providerName: "" });

  const openCreate = () => {
    setEditDialog({ open: true, provider: null, copying: false });
  };

  const openEdit = (provider: Provider) => {
    setEditDialog({ open: true, provider, copying: false });
  };

  const openCopy = (provider: Provider) => {
    setEditDialog({ open: true, provider, copying: true });
  };

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      const data = await fetchApi("/admin/providers");
      setProviders(Array.isArray(data) ? data : []);
    } catch (err: any) {
      toast.error(t("providers.toasts.loadFailed", "加载供应商失败") + ": " + err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteConfirm.providerId) return;

    try {
      await fetchApi(`/admin/providers/${deleteConfirm.providerId}`, {
        method: "DELETE",
        body: "{}"
      });
      toast.success(t("providers.toasts.deleted", "供应商已删除"));
      loadData();
      setDeleteConfirm({ open: false, providerId: null, providerName: "" });
    } catch (e: any) {
      toast.error(t("providers.toasts.deleteFailed", "删除失败") + ": " + e.message);
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex justify-end">
          <Skeleton className="h-10 w-32" />
        </div>
        <Card>
          <CardContent className="p-6">
            <div className="space-y-3">
              {[...Array(3)].map((_, i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-end items-center">
        <Button onClick={openCreate}>
          <Plus className="h-4 w-4 mr-2" />
          {t("providers.actions.add", "添加供应商")}
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          {providers.length === 0 ? (
            <EmptyState
              icon={<Server className="h-12 w-12" />}
              title={t("providers.empty.title", "暂无供应商")}
              description={t("providers.empty.description", "添加您的第一个 AI 供应商以开始使用")}
              action={{
                label: t("providers.actions.add", "添加供应商"),
                onClick: openCreate,
              }}
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("providers.table.name", "名称")}</TableHead>
                  <TableHead>{t("providers.table.apiKeys", "API Keys")}</TableHead>
                  <TableHead>{t("providers.table.openaiProtocol", "OpenAI 协议")}</TableHead>
                  <TableHead>{t("providers.table.anthropicProtocol", "Anthropic 协议")}</TableHead>
                  <TableHead>{t("providers.table.models", "模型列表")}</TableHead>
                  <TableHead>{t("providers.table.concurrencyLimit", "并发限制")}</TableHead>
                  <TableHead>{t("providers.table.timeout", "超时时间")}</TableHead>
                  <TableHead>{t("providers.table.proxy", "代理")}</TableHead>
                  <TableHead className="text-right">{t("providers.table.actions", "操作")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {providers.map((p: any) => (
                  <TableRow key={p.id}>
                    <TableCell className="font-medium">{p.name}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Button variant="outline" size="sm" onClick={() => setApiKeysDialog({ open: true, provider: p })}>
                          <Key className="h-4 w-4 mr-2" />
                          {t("providers.actions.manageKeys", "管理密钥")} ({p.keysCount || 0}{(p.keysCount - p.activeKeysCount) > 0 ? t("providers.actions.keysInactive", ", {{count}} 停用", { count: p.keysCount - p.activeKeysCount }) : ''})
                        </Button>
                      </div>
                    </TableCell>
                    <TableCell>
                      {p.openaiBaseUrl ? <Badge variant="default" className="bg-green-100 text-green-800 border-green-200">{t("providers.status.configured", "已配置")}</Badge> : <Badge variant="secondary">{t("providers.status.notConfigured", "未配置")}</Badge>}
                    </TableCell>
                    <TableCell>
                      {p.anthropicBaseUrl ? <Badge variant="default" className="bg-green-100 text-green-800 border-green-200">{t("providers.status.configured", "已配置")}</Badge> : <Badge variant="secondary">{t("providers.status.notConfigured", "未配置")}</Badge>}
                    </TableCell>
                    <TableCell>
                      <Button variant="link" size="sm" onClick={() => setModelListDialog({ open: true, provider: p })} className="px-0">
                        {t("providers.actions.viewModels", "查看模型")} ({p.modelsCount || 0})
                      </Button>
                    </TableCell>
                    <TableCell>{p.concurrencyLimit ?? "-"}</TableCell>
                    <TableCell>{p.timeoutMs ? `${p.timeoutMs / 1000}s` : "-"}</TableCell>
                    <TableCell>
                      {(p.upstreamProxyUrl || p.weightProxyUrl) ? <Badge variant="outline" className="bg-blue-50/50 text-blue-700 border-blue-200/60 dark:bg-blue-950/20 dark:text-blue-400 dark:border-blue-800/40">{t("providers.status.configured", "已配置")}</Badge> : <span className="text-muted-foreground text-xs">-</span>}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end items-center gap-2">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-muted-foreground"
                          onClick={() => openCopy(p)}
                          title={t("providers.actions.copy", "复制")}
                          aria-label={t("providers.actions.copy", "复制")}
                        >
                          <Copy className="h-4 w-4" />
                        </Button>
                        <Button variant="ghost" size="icon" onClick={() => openEdit(p)}>
                          <Edit2 className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-destructive hover:text-destructive/90"
                          onClick={() => setDeleteConfirm({ open: true, providerId: p.id, providerName: p.name })}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={deleteConfirm.open}
        onOpenChange={(open) => !open && setDeleteConfirm({ open: false, providerId: null, providerName: "" })}
        title={t("providers.delete.title", "确认删除供应商")}
        description={t("providers.delete.description", "您确定要删除供应商 {{name}} 吗？此操作不可逆，且会同时删除其关联的所有模型配置和 API 密钥。", { name: deleteConfirm.providerName })}
        onConfirm={handleDelete}
      />

      <ProviderApiKeysModal
        open={apiKeysDialog.open}
        onOpenChange={(open) => setApiKeysDialog({ ...apiKeysDialog, open })}
        provider={apiKeysDialog.provider}
        onUpdate={loadData}
      />

      <ProviderModelsModal
        open={modelListDialog.open}
        onOpenChange={(open) => setModelListDialog({ ...modelListDialog, open })}
        provider={modelListDialog.provider}
        onRefreshSuccess={loadData}
      />

      <ProviderEditModal
        open={editDialog.open}
        onOpenChange={(open) => setEditDialog({ ...editDialog, open })}
        provider={editDialog.provider}
        copying={editDialog.copying}
        existingNames={providers.map((p) => p.name)}
        onSaveSuccess={loadData}
      />
    </div>
  );
}
