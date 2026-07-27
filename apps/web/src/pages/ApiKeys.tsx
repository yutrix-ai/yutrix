import { useEffect, useState } from "react";
import { fetchApi } from "@/lib/api";
import { useAuth } from "@/lib/store";
import { useSettings } from "@/contexts/SettingsContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useTranslation } from "react-i18next";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { StatusBadge } from "@/components/StatusBadge";
import { EmptyState } from "@/components/EmptyState";
import { KeyDisplay } from "@/components/KeyDisplay";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Key, RefreshCcw, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

type ApiKeyStatus = "active" | "disabled" | "revoked";
type AdminStatusFilter = ApiKeyStatus | "all";

interface ApiKey {
  id: string;
  name: string;
  keyPrefix: string;
  status: ApiKeyStatus;
  createdAt: string;
  lastUsedAt?: string;
  userId?: string;
  username?: string;
  concurrencyLimit?: number;
  expiresAt?: string;
}


function isExpired(key: ApiKey) {
  return Boolean(key.expiresAt && new Date(key.expiresAt).getTime() < Date.now());
}

function getStatusMeta(key: ApiKey, t: any) {
  if (key.status === "revoked") {
    return { status: "disabled" as const, label: t("apiKeys.status.revoked", "已删除") };
  }
  if (key.status === "disabled") {
    return { status: "disabled" as const, label: t("apiKeys.status.disabled", "已禁用") };
  }
  if (isExpired(key)) {
    return { status: "disabled" as const, label: t("apiKeys.status.expired", "已过期") };
  }
  return { status: "active" as const, label: t("apiKeys.status.active", "启用中") };
}

function sortKeys(keys: ApiKey[]) {
  return [...keys].sort((a, b) => {
    const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return bTime - aTime;
  });
}

export default function ApiKeys() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { formatDateTime } = useSettings();
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [adminStatusFilter, setAdminStatusFilter] = useState<AdminStatusFilter>("active");
  const [createdKey, setCreatedKey] = useState("");
  const [createdKeyDialogOpen, setCreatedKeyDialogOpen] = useState(false);
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [revokeConfirm, setRevokeConfirm] = useState<{
    open: boolean;
    keyId: string | null;
    keyName: string;
  }>({ open: false, keyId: null, keyName: "" });

  const isAdmin = user?.role === "admin";
  const apiEndpoint = isAdmin ? "/admin/api-keys" : "/me/api-keys";

  const loadKeys = async () => {
    try {
      const data = await fetchApi(apiEndpoint);
      setKeys(Array.isArray(data) ? sortKeys(data) : []);
    } catch (err: any) {
      toast.error(t("apiKeys.toasts.loadFailed", "加载数据失败") + ": " + err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadKeys();
  }, [apiEndpoint]);

  const handleUserReset = async () => {
    if (isAdmin || resetting) return;

    try {
      setResetting(true);
      const res = await fetchApi("/me/api-keys", {
        method: "POST",
        body: JSON.stringify({ name: t("apiKeys.defaultName", "默认 API Key") }),
      });
      setCreatedKey(res.apiKey);
      setCreatedKeyDialogOpen(true);
      await loadKeys();
      toast.success(t("apiKeys.toasts.createSuccess", "API Key 已生成，请立即保存"));
    } catch (err: any) {
      toast.error(t("apiKeys.toasts.actionFailed", "操作失败") + ": " + err.message);
    } finally {
      setResetting(false);
    }
  };

  const handleAdminStatusChange = async (keyId: string, status: Exclude<ApiKeyStatus, "revoked">) => {
    try {
      await fetchApi(`/admin/api-keys/${keyId}`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
      await loadKeys();
      toast.success(status === "active" ? t("apiKeys.toasts.enabled", "API Key 已启用") : t("apiKeys.toasts.disabled", "API Key 已禁用"));
    } catch (err: any) {
      toast.error(t("apiKeys.toasts.updateFailed", "更新失败") + ": " + err.message);
    }
  };

  const handleAdminRevoke = async () => {
    if (!revokeConfirm.keyId) return;

    try {
      await fetchApi(`/admin/api-keys/${revokeConfirm.keyId}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "revoked" }),
      });
      await loadKeys();
      toast.success(t("apiKeys.toasts.deleted", "API Key 已删除"));
      setRevokeConfirm({ open: false, keyId: null, keyName: "" });
    } catch (err: any) {
      toast.error(t("apiKeys.toasts.deleteFailed", "删除失败") + ": " + err.message);
    }
  };

  const closeCreatedKeyDialog = (open: boolean) => {
    setCreatedKeyDialogOpen(open);
    if (!open) setCreatedKey("");
  };

  if (loading) {
    return isAdmin ? (
      <div className="space-y-4">
        <Skeleton className="h-12 w-full" />
        <Card>
          <CardContent className="p-6">
            <div className="space-y-3">
              {[...Array(5)].map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    ) : (
      <div className="space-y-6">
        <Skeleton className="h-32 w-full" />
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
          <Skeleton className="h-72 w-full" />
          <Skeleton className="h-72 w-full" />
        </div>
      </div>
    );
  }

  if (!isAdmin) {
    const currentKey = keys.find((key) => key.status === "active") || keys[0] || null;
    const statusMeta = currentKey ? getStatusMeta(currentKey, t) : null;

    return (
      <div className="space-y-6">
        <section className="rounded-lg border bg-gradient-to-r from-primary/10 via-background to-background p-4 shrink-0">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3">
              <Key className="h-5 w-5 text-primary" />
              <span className="font-semibold text-sm">{t("apiKeys.userTitle", "我的 API Key")}</span>
            </div>
            <Button
              className="shrink-0"
              onClick={() => (currentKey ? setResetConfirmOpen(true) : handleUserReset())}
              disabled={resetting}
            >
              <RefreshCcw className="mr-2 h-4 w-4" />
              {resetting
                ? t("apiKeys.actions.processing", "处理中...")
                : currentKey
                ? t("apiKeys.actions.reset", "重置 API Key")
                : t("apiKeys.actions.generate", "生成 API Key")}
            </Button>
          </div>
        </section>

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
          <Card>
            <CardContent className="p-6">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-sm text-muted-foreground">{t("apiKeys.userCard.title", "当前可用凭证")}</p>
                  <h3 className="mt-1 text-xl font-semibold">PromptGate API Key</h3>
                </div>
                {statusMeta && <StatusBadge status={statusMeta.status} label={statusMeta.label} />}
              </div>

              {currentKey ? (
                <>
                  <div className="mt-6 rounded-lg border bg-muted/20 p-4">
                    <p className="text-sm text-muted-foreground">{t("apiKeys.userCard.prefix", "Key 前缀")}</p>
                    <code className="mt-2 block rounded-md bg-background px-4 py-3 font-mono text-2xl font-semibold tracking-wide">
                      {currentKey.keyPrefix}...
                    </code>
                    <p className="mt-3 text-xs text-muted-foreground">
                      {t("apiKeys.userCard.warning", "出于安全原因，完整 API Key 不会再次展示。需要完整密钥时请使用重置。")}
                    </p>
                  </div>

                  <div className="mt-6 grid gap-4 sm:grid-cols-2">
                    <div className="rounded-lg border p-4">
                      <span className="block text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        {t("apiKeys.userCard.createdAt", "创建时间")}
                      </span>
                      <div className="font-medium text-foreground">
                        {formatDateTime(currentKey.createdAt)}
                      </div>
                    </div>
                    <div className="rounded-lg border p-4">
                      <span className="block text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        {t("apiKeys.userCard.lastUsed", "最近使用")}
                      </span>
                      <div className="font-medium text-foreground">
                        {currentKey.lastUsedAt ? formatDateTime(currentKey.lastUsedAt) : t("apiKeys.userCard.neverUsed", "从未使用")}
                      </div>
                    </div>
                  </div>
                </>
              ) : (
                <div className="mt-6 rounded-lg border border-dashed p-8 text-center">
                  <p className="font-medium">{t("apiKeys.userCard.noKeyTitle", "还没有 API Key")}</p>
                  <p className="mt-2 text-sm text-muted-foreground">
                    {t("apiKeys.userCard.noKeyDesc", "生成后即可在 Playground、curl 或第三方客户端中调用 PromptGate。")}
                  </p>
                </div>
              )}
            </CardContent>
          </Card>

          <aside className="space-y-4">
            <div className="rounded-lg border bg-card p-5">
              <h3 className="font-semibold">{t("apiKeys.userSidebar.resetTitle", "重置会发生什么")}</h3>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                {t("apiKeys.userSidebar.resetDesc", "重置会立即作废旧 Key。使用旧 Key 的脚本、客户端或集成配置会停止工作，需要替换为新生成的完整密钥。")}
              </p>
            </div>
            <div className="rounded-lg border bg-card p-5">
              <h3 className="font-semibold">{t("apiKeys.userSidebar.flowTitle", "建议流程")}</h3>
              <div className="mt-3 space-y-3 text-sm text-muted-foreground">
                <p>{t("apiKeys.userSidebar.flowStep1", "1. 重置后立刻复制完整 API Key。")}</p>
                <p>{t("apiKeys.userSidebar.flowStep2", "2. 打开 Playground 粘贴完整 Key，生成 cURL 或 Claude Code 配置。")}</p>
                <p>{t("apiKeys.userSidebar.flowStep3", "3. 更新调用方后再清理旧配置。")}</p>
              </div>
            </div>
          </aside>
        </div>

        <Dialog open={createdKeyDialogOpen} onOpenChange={closeCreatedKeyDialog}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t("apiKeys.dialog.title", "请立即保存新的 API Key")}</DialogTitle>
              <DialogDescription>
                {t("apiKeys.dialog.description", "出于安全原因，完整 API Key 关闭后不会再次展示。")}
              </DialogDescription>
            </DialogHeader>
            <KeyDisplay
              keyValue={createdKey}
              label={t("apiKeys.dialog.label", "新的 API Key")}
              warning={t("apiKeys.dialog.warning", "请立即复制并保存。旧 Key 已失效，请同步更新所有调用方。")}
            />
            <DialogFooter>
              <Button onClick={() => closeCreatedKeyDialog(false)}>{t("apiKeys.actions.done", "完成")}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <ConfirmDialog
          open={resetConfirmOpen}
          onOpenChange={setResetConfirmOpen}
          title={t("apiKeys.resetConfirm.title", "确认重置 API Key")}
          description={t("apiKeys.resetConfirm.description", "重置后旧 API Key 会立即失效，正在使用旧 Key 的客户端将无法继续调用。确定要继续吗？")}
          confirmLabel={t("apiKeys.actions.reset", "重置")}
          variant="destructive"
          onConfirm={handleUserReset}
          loading={resetting}
        />
      </div>
    );
  }

  const visibleKeys =
    adminStatusFilter === "all"
      ? keys
      : keys.filter((key) => {
          if (adminStatusFilter === "active") {
            return getStatusMeta(key, t).status === "active";
          }
          if (adminStatusFilter === "disabled") {
            return key.status !== "revoked" && getStatusMeta(key, t).status === "disabled";
          }
          return key.status === "revoked";
        });

  const activeCount = keys.filter((key) => getStatusMeta(key, t).status === "active").length;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">
            {t("apiKeys.admin.summary", "当前启用中 {{activeCount}} 个，全部记录 {{totalCount}} 个。", { activeCount, totalCount: keys.length })}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <ShieldCheck className="h-4 w-4 text-muted-foreground" />
          <Select
            value={adminStatusFilter}
            onValueChange={(value) => setAdminStatusFilter(value as AdminStatusFilter)}
          >
            <SelectTrigger className="w-[160px]">
              <SelectValue placeholder={t("apiKeys.admin.filterPlaceholder", "状态筛选")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="active">{t("apiKeys.admin.filterActive", "启用中")}</SelectItem>
              <SelectItem value="disabled">{t("apiKeys.admin.filterDisabled", "已禁用/过期")}</SelectItem>
              <SelectItem value="revoked">{t("apiKeys.admin.filterRevoked", "已删除")}</SelectItem>
              <SelectItem value="all">{t("apiKeys.admin.filterAll", "全部状态")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          {visibleKeys.length === 0 ? (
            <EmptyState
              icon={<Key className="h-12 w-12" />}
              title={t("apiKeys.empty.title", "暂无 API Key")}
              description={
                adminStatusFilter === "active"
                  ? t("apiKeys.empty.descriptionActive", "当前没有启用中的 API Key")
                  : t("apiKeys.empty.descriptionFiltered", "当前筛选条件下没有 API Key 数据")
              }
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("apiKeys.table.user", "所属用户")}</TableHead>
                  <TableHead>{t("apiKeys.table.prefix", "前缀")}</TableHead>
                  <TableHead>{t("apiKeys.table.concurrencyLimit", "并发限制")}</TableHead>
                  <TableHead>{t("apiKeys.table.expiresAt", "过期时间")}</TableHead>
                  <TableHead>{t("apiKeys.table.status", "状态")}</TableHead>
                  <TableHead>{t("apiKeys.table.lastUsedAt", "最近使用时间")}</TableHead>
                  <TableHead>{t("apiKeys.table.createdAt", "创建时间")}</TableHead>
                  <TableHead className="text-right">{t("apiKeys.table.actions", "操作")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleKeys.map((key) => {
                  const statusMeta = getStatusMeta(key, t);
                  const canOperate = key.status !== "revoked";

                  return (
                    <TableRow key={key.id}>
                      <TableCell className="text-muted-foreground">
                        {key.username || "-"}
                      </TableCell>
                      <TableCell>
                        <code className="rounded bg-muted px-2 py-1 font-mono text-sm">
                          {key.keyPrefix}...
                        </code>
                      </TableCell>
                      <TableCell>{key.concurrencyLimit || 2}</TableCell>
                      <TableCell>
                        {key.expiresAt ? formatDateTime(key.expiresAt) : t("apiKeys.table.neverExpire", "永久有效")}
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={statusMeta.status} label={statusMeta.label} />
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {key.lastUsedAt ? formatDateTime(key.lastUsedAt) : t("apiKeys.userCard.neverUsed", "从未使用")}
                      </TableCell>
                      <TableCell className="hidden lg:table-cell text-muted-foreground">
                        {formatDateTime(key.createdAt)}
                      </TableCell>
                      <TableCell className="text-right">
                        {canOperate ? (
                          <div className="flex justify-end gap-2">
                            {key.status === "active" ? (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => handleAdminStatusChange(key.id, "disabled")}
                              >
                                {t("apiKeys.actions.disable", "禁用")}
                              </Button>
                            ) : (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => handleAdminStatusChange(key.id, "active")}
                              >
                                {t("apiKeys.actions.enable", "启用")}
                              </Button>
                            )}
                            <Button
                              variant="destructive"
                              size="sm"
                              onClick={() =>
                                setRevokeConfirm({
                                  open: true,
                                  keyId: key.id,
                                  keyName: key.keyPrefix,
                                })
                              }
                            >
                              {t("apiKeys.actions.delete", "删除")}
                            </Button>
                          </div>
                        ) : (
                          <span className="text-sm text-muted-foreground">{t("apiKeys.status.revoked", "已删除")}</span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={revokeConfirm.open}
        onOpenChange={(open) => setRevokeConfirm({ ...revokeConfirm, open })}
        title={t("apiKeys.deleteConfirm.title", "确认删除 API Key")}
        description={t("apiKeys.deleteConfirm.description", "确定要删除 \"{{name}}\" 吗？删除后该 Key 将立即失效，且无法恢复。", { name: revokeConfirm.keyName })}
        confirmLabel={t("apiKeys.actions.delete", "删除")}
        variant="destructive"
        onConfirm={handleAdminRevoke}
      />
    </div>
  );
}
