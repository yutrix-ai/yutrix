import { useState, useEffect } from "react";
import { fetchApi } from "../lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { FormField } from "@/components/FormField";
import { EmptyState } from "@/components/EmptyState";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { StatusBadge } from "@/components/StatusBadge";
import { Globe, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

interface Subdomain {
  id: string;
  name: string;
  hostname: string;
  enabled: boolean;
  description: string | null;
  createdAt: string;
}

export default function Subdomains() {
  const { t } = useTranslation();
  const [data, setData] = useState<Subdomain[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<{
    open: boolean;
    id: string | null;
    name: string;
  }>({ open: false, id: null, name: "" });
  const [formData, setFormData] = useState({
    name: "",
    description: "",
    enabled: true,
  });

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      const res = await fetchApi("/admin/subdomains");
      setData(res);
    } catch (e: any) {
      toast.error(t("subdomains.toasts.loadFailed", "加载二级域名失败") + ": " + e.message);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await fetchApi("/admin/subdomains", {
        method: "POST",
        body: JSON.stringify(formData),
      });
      toast.success(t("subdomains.toasts.createSuccess", "二级域名创建成功"));
      setFormData({ name: "", description: "", enabled: true });
      setCreateDialogOpen(false);
      loadData();
    } catch (e: any) {
      toast.error(t("subdomains.toasts.createFailed", "创建失败") + ": " + e.message);
    }
  };

  const handleToggle = async (id: string, enabled: boolean) => {
    try {
      await fetchApi(`/admin/subdomains/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled }),
      });
      toast.success(enabled ? t("subdomains.toasts.enabled", "已启用") : t("subdomains.toasts.disabled", "已禁用"));
      loadData();
    } catch (e: any) {
      toast.error(t("subdomains.toasts.actionFailed", "操作失败") + ": " + e.message);
    }
  };

  const handleDelete = async () => {
    if (!deleteConfirm.id) return;
    try {
      await fetchApi(`/admin/subdomains/${deleteConfirm.id}`, {
        method: "DELETE",
        body: "{}"
      });
      toast.success(t("subdomains.toasts.deleted", "二级域名已删除"));
      loadData();
      setDeleteConfirm({ open: false, id: null, name: "" });
    } catch (e: any) {
      toast.error(t("subdomains.toasts.deleteFailed", "删除失败") + ": " + e.message);
    }
  };

  const filteredData = data.filter(
    (d) =>
      d.hostname.toLowerCase().includes(searchQuery.toLowerCase()) ||
      d.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (d.description && d.description.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="flex justify-end items-center">
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
      {/* Header with Search and Create Button */}
      <div className="flex justify-between items-center gap-4">
        <div className="flex-1 max-w-sm">
          <Input
            placeholder={t("subdomains.filters.searchPlaceholder", "搜索域名、名称或描述...")}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
        <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="h-4 w-4 mr-2" />
              {t("subdomains.actions.add", "添加二级域名")}
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t("subdomains.dialog.title", "添加二级域名")}</DialogTitle>
              <DialogDescription>
                {t("subdomains.dialog.description", "创建新的二级域名用于流量分流")}
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={handleSave} autoComplete="off">
              <div className="space-y-4">
                <FormField
                  label={t("subdomains.fields.prefix", "子域名前缀")}
                  required
                  hint={t("subdomains.hints.prefix", "完整主机名由前缀 + DNS 区域父域（mainDomain）拼接，例如 code + brtel.link → code.brtel.link。")}
                >
                  <Input
                    placeholder={t("subdomains.placeholders.prefix", "例如: code")}
                    value={formData.name}
                    onChange={(e) =>
                      setFormData({ ...formData, name: e.target.value })
                    }
                    required
                    autoFocus
                  />
                </FormField>

                <FormField label={t("subdomains.fields.description", "描述说明")}>
                  <Input
                    placeholder={t("subdomains.placeholders.description", "可选，用于说明此域名的用途")}
                    value={formData.description}
                    onChange={(e) =>
                      setFormData({ ...formData, description: e.target.value })
                    }
                  />
                </FormField>

                <div className="flex items-center justify-between">
                  <Label htmlFor="enabled">{t("subdomains.fields.enabled", "创建后立即启用")}</Label>
                  <Switch
                    id="enabled"
                    checked={formData.enabled}
                    onCheckedChange={(checked) =>
                      setFormData({ ...formData, enabled: checked })
                    }
                  />
                </div>

                <DialogFooter>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setCreateDialogOpen(false)}
                  >
                    {t("common.cancel", "取消")}
                  </Button>
                  <Button type="submit">{t("common.save", "保存")}</Button>
                </DialogFooter>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {/* Subdomains Table */}
      <Card>
        <CardContent className="p-0">
          {filteredData.length === 0 ? (
            data.length === 0 ? (
              <EmptyState
                icon={<Globe className="h-12 w-12" />}
                title={t("subdomains.empty.title", "暂无二级域名")}
                description={t("subdomains.empty.description", "添加您的第一个二级域名以开始配置流量分流")}
                action={{
                  label: t("subdomains.actions.add", "添加二级域名"),
                  onClick: () => setCreateDialogOpen(true),
                }}
              />
            ) : (
              <EmptyState
                icon={<Globe className="h-12 w-12" />}
                title={t("subdomains.empty.noResultsTitle", "未找到匹配的域名")}
                description={t("subdomains.empty.noResultsDesc", "尝试使用其他关键词搜索")}
              />
            )
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("subdomains.table.hostname", "域名")}</TableHead>
                  <TableHead>{t("subdomains.table.prefix", "前缀")}</TableHead>
                  <TableHead>{t("subdomains.table.description", "描述")}</TableHead>
                  <TableHead>{t("subdomains.table.status", "状态")}</TableHead>
                  <TableHead>{t("subdomains.table.enabled", "启用")}</TableHead>
                  <TableHead className="text-right">{t("subdomains.table.actions", "操作")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredData.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell className="font-medium font-mono">
                      {d.hostname}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {d.name}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {d.description || t("subdomains.table.noDescription", "无描述")}
                    </TableCell>
                    <TableCell>
                      <StatusBadge
                        status={d.enabled ? "active" : "disabled"}
                        label={d.enabled ? t("subdomains.status.enabled", "已启用") : t("subdomains.status.disabled", "已禁用")}
                      />
                    </TableCell>
                    <TableCell>
                      <Switch
                        checked={d.enabled}
                        onCheckedChange={(checked) =>
                          handleToggle(d.id, checked)
                        }
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          setDeleteConfirm({
                            open: true,
                            id: d.id,
                            name: d.hostname,
                          })
                        }
                        className="text-destructive hover:text-destructive"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
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
        title={t("subdomains.deleteConfirm.title", "确认删除二级域名")}
        description={t("subdomains.deleteConfirm.description", "确定要删除 \"{{name}}\" 吗？关联的端点路由也将被清除，此操作不可恢复。", { name: deleteConfirm.name })}
        confirmLabel={t("common.delete", "删除")}
        variant="destructive"
        onConfirm={handleDelete}
      />
    </div>
  );
}
