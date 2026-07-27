import { useState, useEffect } from "react";
import { fetchApi } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { useTranslation } from "react-i18next";
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
  DialogTrigger,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { FormField } from "@/components/FormField";
import { EmptyState } from "@/components/EmptyState";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { StatusBadge } from "@/components/StatusBadge";
import { KeyDisplay } from "@/components/KeyDisplay";
import { Ticket, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/lib/store";
import { useSettings } from "@/contexts/SettingsContext";

interface InviteCode {
  id: string;
  codePrefix: string;
  maxUses: number;
  usedCount: number;
  expiresAt: string | null;
  status: "active" | "disabled";
  createdBy: string;
  createdAt: string;
}

const initialFormData = {
  maxUses: 1,
  expiresAt: "",
};

export default function InviteCodes() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { formatDateTime } = useSettings();
  const [codes, setCodes] = useState<InviteCode[]>([]);
  const [loading, setLoading] = useState(true);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<{
    open: boolean;
    id: string | null;
    codePrefix: string;
  }>({ open: false, id: null, codePrefix: "" });
  const [newCode, setNewCode] = useState("");
  const [formData, setFormData] = useState(initialFormData);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      const data = await fetchApi("/admin/invite-codes");
      setCodes(data);
    } catch (e: any) {
      toast.error(t("inviteCodes.toasts.loadFailed", "加载邀请码失败") + ": " + e.message);
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const result = await fetchApi("/admin/invite-codes", {
        method: "POST",
        body: JSON.stringify({
          ...formData,
          expiresAt: formData.expiresAt || undefined,
        }),
      });
      setNewCode(result.code);
      toast.success(t("inviteCodes.toasts.createSuccess", "邀请码创建成功"));
      loadData();
    } catch (e: any) {
      toast.error(t("inviteCodes.toasts.createFailed", "创建失败") + ": " + e.message);
    }
  };

  const handleToggleStatus = async (id: string, currentStatus: string) => {
    const newStatus = currentStatus === "active" ? "disabled" : "active";
    try {
      await fetchApi(`/admin/invite-codes/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: newStatus }),
      });
      toast.success(newStatus === "active" ? t("inviteCodes.toasts.enabled", "邀请码已启用") : t("inviteCodes.toasts.disabled", "邀请码已禁用"));
      loadData();
    } catch (e: any) {
      toast.error(t("inviteCodes.toasts.actionFailed", "操作失败") + ": " + e.message);
    }
  };

  const handleDelete = async () => {
    if (!deleteConfirm.id) return;
    try {
      await fetchApi(`/admin/invite-codes/${deleteConfirm.id}`, {
        method: "DELETE",
      });
      toast.success(t("inviteCodes.toasts.deleted", "邀请码已删除"));
      loadData();
      setDeleteConfirm({ open: false, id: null, codePrefix: "" });
    } catch (e: any) {
      toast.error(t("inviteCodes.toasts.deleteFailed", "删除失败") + ": " + e.message);
    }
  };

  const handleCloseCreateDialog = () => {
    setCreateDialogOpen(false);
    setFormData(initialFormData);
    setNewCode("");
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="flex justify-end">
          <Skeleton className="h-10 w-32" />
        </div>
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
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-end items-center">
        <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="h-4 w-4 mr-2" />
              {t("inviteCodes.actions.create", "创建邀请码")}
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t("inviteCodes.actions.create", "创建邀请码")}</DialogTitle>
              <DialogDescription>
                {t("inviteCodes.dialog.description", "生成一个新的邀请码用于注册")}
              </DialogDescription>
            </DialogHeader>

            {newCode ? (
              <div className="space-y-4">
                <KeyDisplay
                  keyValue={newCode}
                  label={t("inviteCodes.dialog.inviteCodeLabel", "邀请码")}
                  warning={t("inviteCodes.dialog.warning", "请立即复制并保存此邀请码。关闭对话框后将无法再次查看！")}
                />
                <DialogFooter>
                  <Button onClick={handleCloseCreateDialog}>{t("inviteCodes.actions.done", "完成")}</Button>
                </DialogFooter>
              </div>
            ) : (
              <form onSubmit={handleCreate}>
                <div className="space-y-4">
                  <FormField label={t("inviteCodes.fields.maxUses", "最大使用次数")} required>
                    <Input
                      type="number"
                      min="1"
                      value={formData.maxUses}
                      onChange={(e) =>
                        setFormData({ ...formData, maxUses: parseInt(e.target.value) })
                      }
                      required
                    />
                  </FormField>

                  <FormField label={t("inviteCodes.fields.expiresAt", "过期时间")} hint={t("inviteCodes.hints.expiresAt", "留空表示永不过期")}>
                    <Input
                      type="datetime-local"
                      value={formData.expiresAt}
                      onChange={(e) =>
                        setFormData({ ...formData, expiresAt: e.target.value })
                      }
                    />
                  </FormField>

                  <DialogFooter>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={handleCloseCreateDialog}
                    >
                      {t("common.cancel", "取消")}
                    </Button>
                    <Button type="submit">{t("common.create", "创建")}</Button>
                  </DialogFooter>
                </div>
              </form>
            )}
          </DialogContent>
        </Dialog>
      </div>

      {/* Invite Codes Table */}
      <Card>
        <CardContent className="p-0">
          {codes.length === 0 ? (
            <EmptyState
              icon={<Ticket className="h-12 w-12" />}
              title={t("inviteCodes.empty.title", "暂无邀请码")}
              description={t("inviteCodes.empty.description", "创建第一个邀请码以允许新用户注册")}
              action={{
                label: t("inviteCodes.actions.create", "创建邀请码"),
                onClick: () => setCreateDialogOpen(true),
              }}
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("inviteCodes.table.prefix", "邀请码前缀")}</TableHead>
                  <TableHead>{t("inviteCodes.table.usage", "使用情况")}</TableHead>
                  <TableHead>{t("inviteCodes.table.maxUses", "最大次数")}</TableHead>
                  <TableHead>{t("inviteCodes.table.expiresAt", "过期时间")}</TableHead>
                  <TableHead>{t("inviteCodes.table.status", "状态")}</TableHead>
                  <TableHead className="hidden lg:table-cell">{t("inviteCodes.table.createdAt", "创建时间")}</TableHead>
                  <TableHead className="text-right">{t("inviteCodes.table.actions", "操作")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {codes.map((code) => (
                  <TableRow key={code.id}>
                    <TableCell className="font-mono">
                      {code.codePrefix}...
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">
                        {code.usedCount} / {code.maxUses}
                      </Badge>
                    </TableCell>
                    <TableCell>{code.maxUses}</TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {code.expiresAt
                        ? formatDateTime(code.expiresAt)
                        : t("inviteCodes.table.neverExpire", "永久有效")}
                    </TableCell>
                    <TableCell>
                      <StatusBadge
                        status={code.status === "active" ? "active" : "disabled"}
                        label={code.status === "active" ? t("inviteCodes.status.active", "启用") : t("inviteCodes.status.disabled", "禁用")}
                      />
                    </TableCell>
                    <TableCell className="hidden lg:table-cell text-muted-foreground">
                      {formatDateTime(code.createdAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleToggleStatus(code.id, code.status)}
                          className={
                            code.status === "active"
                              ? "text-destructive hover:text-destructive"
                              : "text-green-600 hover:text-green-600"
                          }
                        >
                          {code.status === "active" ? t("inviteCodes.status.disabled", "禁用") : t("inviteCodes.status.active", "启用")}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            setDeleteConfirm({
                              open: true,
                              id: code.id,
                              codePrefix: code.codePrefix,
                            })
                          }
                          className="text-destructive hover:text-destructive"
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

      {/* Delete Confirmation Dialog */}
      <ConfirmDialog
        open={deleteConfirm.open}
        onOpenChange={(open) => setDeleteConfirm({ ...deleteConfirm, open })}
        title={t("inviteCodes.deleteConfirm.title", "确认删除邀请码")}
        description={t("inviteCodes.deleteConfirm.description", "确定要删除邀请码 \"{{prefix}}...\" 吗？此操作不可恢复。", { prefix: deleteConfirm.codePrefix })}
        confirmLabel={t("common.delete", "删除")}
        variant="destructive"
        onConfirm={handleDelete}
      />
    </div>
  );
}
