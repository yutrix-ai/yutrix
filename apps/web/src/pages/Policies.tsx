import { useState, useEffect } from "react";
import { fetchApi } from "../lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { PolicyTable } from "@/components/Policies/PolicyTable";
import { PolicyFormDialog } from "@/components/Policies/PolicyFormDialog";

interface Policy {
  id: string;
  name: string;
  protocol: string;
  injectPosition: string;
  injectMode: string;
  conversationKeySource: string;
  conversationKeyName: string;
  fallbackMode: string;
  content: string;
  description: string | null;
  version: number;
  enabled: boolean;
}

const initialFormData = {
  name: "",
  protocol: "openai",
  injectPosition: "append_system",
  injectMode: "every_request",
  conversationKeySource: "header",
  conversationKeyName: "X-Conversation-Id",
  fallbackMode: "treat_as_new",
  content: "",
  description: "",
  enabled: true,
};

export default function Policies() {
  const { t } = useTranslation();
  const [data, setData] = useState<Policy[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [viewDialogOpen, setViewDialogOpen] = useState(false);
  const [selectedPolicy, setSelectedPolicy] = useState<Policy | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{
    open: boolean;
    id: string | null;
    name: string;
  }>({ open: false, id: null, name: "" });
  const [formData, setFormData] = useState(initialFormData);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      const res = await fetchApi("/admin/policies");
      setData(res);
    } catch (e: any) {
      toast.error(t("policies.toasts.loadFailed", "加载策略失败") + ": " + e.message);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await fetchApi("/admin/policies", {
        method: "POST",
        body: JSON.stringify(formData),
      });
      toast.success(t("policies.toasts.createSuccess", "策略创建成功"));
      setFormData(initialFormData);
      setCreateDialogOpen(false);
      loadData();
    } catch (e: any) {
      toast.error(t("policies.toasts.createFailed", "创建失败") + ": " + e.message);
    }
  };

  const handleToggle = async (id: string, enabled: boolean) => {
    try {
      await fetchApi(`/admin/policies/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled }),
      });
      toast.success(enabled ? t("policies.toasts.enabled", "已启用") : t("policies.toasts.disabled", "已禁用"));
      loadData();
    } catch (e: any) {
      toast.error(t("policies.toasts.actionFailed", "操作失败") + ": " + e.message);
    }
  };

  const handleDelete = async () => {
    if (!deleteConfirm.id) return;
    try {
      await fetchApi(`/admin/policies/${deleteConfirm.id}`, {
        method: "DELETE",
      });
      toast.success(t("policies.toasts.deleted", "策略已删除"));
      loadData();
      setDeleteConfirm({ open: false, id: null, name: "" });
    } catch (e: any) {
      toast.error(t("policies.toasts.deleteFailed", "删除失败") + ": " + e.message);
    }
  };

  const injectModeLabel = (mode: string) => {
    return mode === "once_per_conversation"
      ? t("policies.injectMode.oncePerConversation", "防重复")
      : t("policies.injectMode.everyRequest", "每次请求");
  };

  const injectPositionLabel = (pos: string) => {
    switch (pos) {
      case "messages_unshift":
        return t("policies.injectPosition.messagesUnshift", "头部插入");
      case "append_system":
        return t("policies.injectPosition.appendSystem", "追加 System");
      case "replace_system":
        return t("policies.injectPosition.replaceSystem", "替换 System");
      case "system":
        return t("policies.injectPosition.system", "覆盖");
      default:
        return pos;
    }
  };

  const filteredData = data.filter(
    (d) =>
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
      {/* Header with Search and Create Button */}
      <div className="flex justify-between items-center gap-4">
        <div className="flex-1 max-w-sm">
          <Input
            placeholder={t("policies.filters.searchPlaceholder", "搜索策略名称或描述...")}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
        <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="h-4 w-4 mr-2" />
              {t("policies.actions.add", "添加策略")}
            </Button>
          </DialogTrigger>
        </Dialog>
        <PolicyFormDialog 
          open={createDialogOpen} 
          onOpenChange={setCreateDialogOpen} 
          formData={formData} 
          setFormData={setFormData} 
          handleSave={handleSave} 
        />
      </div>

      {/* Policies Table */}
      <Card>
        <CardContent className="p-0">
          <PolicyTable
            data={data}
            filteredData={filteredData}
            handleToggle={handleToggle}
            setDeleteConfirm={setDeleteConfirm}
            setSelectedPolicy={setSelectedPolicy}
            setViewDialogOpen={setViewDialogOpen}
            setCreateDialogOpen={setCreateDialogOpen}
            injectPositionLabel={injectPositionLabel}
            injectModeLabel={injectModeLabel}
          />
        </CardContent>
      </Card>

      {/* View Policy Dialog */}
      <Dialog open={viewDialogOpen} onOpenChange={setViewDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{selectedPolicy?.name}</DialogTitle>
            <DialogDescription>
              {selectedPolicy?.description || t("policies.view.noDescription", "无描述")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label className="text-xs text-muted-foreground">{t("policies.view.protocol", "协议")}</Label>
                <div>{selectedPolicy?.protocol}</div>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">{t("policies.view.injectMode", "注入模式")}</Label>
                <div>{injectModeLabel(selectedPolicy?.injectMode || "")}</div>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">{t("policies.view.injectPosition", "注入位置")}</Label>
                <div>{injectPositionLabel(selectedPolicy?.injectPosition || "")}</div>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">{t("policies.view.version", "版本")}</Label>
                <div>v{selectedPolicy?.version}</div>
              </div>
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">{t("policies.view.content", "注入内容")}</Label>
              <pre className="mt-1 p-3 bg-muted rounded-md text-sm font-mono overflow-auto max-h-64">
                {selectedPolicy?.content}
              </pre>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <ConfirmDialog
        open={deleteConfirm.open}
        onOpenChange={(open) => setDeleteConfirm({ ...deleteConfirm, open })}
        title={t("policies.deleteConfirm.title", "确认删除策略")}
        description={t("policies.deleteConfirm.description", "确定要删除 \"{{name}}\" 吗？此操作不可恢复。", { name: deleteConfirm.name })}
        confirmLabel={t("common.delete", "删除")}
        variant="destructive"
        onConfirm={handleDelete}
      />
    </div>
  );
}
