import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/FormField";
import { EmptyState } from "@/components/EmptyState";
import { StatusBadge } from "@/components/StatusBadge";
import { Radio, Plus, Trash2, Settings } from "lucide-react";
import { useTranslation } from "react-i18next";

export function EndpointFormDialog({
  dialogOpen,
  setDialogOpen,
  selectedEndpointId,
  setSelectedEndpointId,
  formData,
  setFormData,
  handleSave,
  providers,
  getModelsForProviderProtocol,
  availablePolicies,
  initialFormData
}: any) {
  const { t } = useTranslation();

  return (
    <Dialog 
      open={dialogOpen} 
      onOpenChange={(open) => {
        if (!open) {
          setDialogOpen(false);
          setSelectedEndpointId(null);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button onClick={() => {
          setSelectedEndpointId(null);
          setFormData(initialFormData);
          setDialogOpen(true);
        }}>
          <Plus className="h-4 w-4 mr-2" />
          {t("endpoints.actions.add", "添加端点")}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{selectedEndpointId ? t("endpoints.dialog.editTitle", "编辑端点") : t("endpoints.dialog.addTitle", "添加监听端点")}</DialogTitle>
          <DialogDescription>
            {selectedEndpointId ? t("endpoints.dialog.editDesc", "修改端点及路由配置") : t("endpoints.dialog.addDesc", "创建新的 API 监听端点")}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSave}>
          <div className="space-y-4">
            <FormField label={t("endpoints.fields.name", "端点名称")} required>
              <Input
                placeholder={t("endpoints.placeholders.name", "例如: 默认对话")}
                value={formData.name}
                onChange={(e) =>
                  setFormData({ ...formData, name: e.target.value })
                }
                required
                autoFocus
              />
            </FormField>

            <FormField label={t("endpoints.fields.path", "监听路径")} required>
              <Input
                placeholder="/v1/chat/completions"
                value={formData.path}
                onChange={(e) =>
                  setFormData({ ...formData, path: e.target.value })
                }
                required
              />
            </FormField>

            <FormField label={t("endpoints.fields.provider", "供应商")} required>
              <Select
                value={formData.defaultProviderId}
                onValueChange={(value) =>
                  setFormData({ ...formData, defaultProviderId: value, virtualModelAlias: "" })
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder={t("endpoints.placeholders.provider", "选择供应商")} />
                </SelectTrigger>
                <SelectContent>
                  {providers.map((p: any) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>

            <FormField label={t("endpoints.fields.protocol", "协议类型")} required>
              <Select
                value={formData.incomingProtocol}
                onValueChange={(value) => {
                  const newPath = value === "openai" ? "/v1/chat/completions" : "/v1/messages";
                  setFormData({ 
                    ...formData, 
                    incomingProtocol: value,
                    virtualModelAlias: "",
                    path: formData.path === "/v1/chat/completions" || formData.path === "/v1/messages" || formData.path === "" 
                      ? newPath 
                      : formData.path
                  });
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="openai">OpenAI</SelectItem>
                  <SelectItem value="anthropic">Anthropic</SelectItem>
                </SelectContent>
              </Select>
            </FormField>

            <FormField label={t("endpoints.fields.model", "模型")} required>
              <Select
                value={formData.virtualModelAlias}
                onValueChange={(value) =>
                  setFormData({ ...formData, virtualModelAlias: value })
                }
                disabled={!formData.defaultProviderId}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t("endpoints.placeholders.model", "选择模型 (将同时作为此端点的别名)")} />
                </SelectTrigger>
                <SelectContent>
                  {getModelsForProviderProtocol(formData.defaultProviderId, formData.incomingProtocol).map((m: any) => (
                    <SelectItem key={m.id} value={m.modelId}>
                      {m.displayName || m.modelId}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>

            <FormField label={t("endpoints.fields.policy", "提示词策略")}>
              <Select
                value={formData.defaultPromptPolicyId}
                onValueChange={(value) =>
                  setFormData({ ...formData, defaultPromptPolicyId: value })
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder={t("endpoints.options.none", "无")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t("endpoints.options.none", "无")}</SelectItem>
                  {availablePolicies.map((p: any) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>

            <div className="grid grid-cols-3 gap-4">
              <FormField label={t("endpoints.fields.timeout", "超时时间 (ms, 0为不限制)")}>
                <Input
                  type="number"
                  value={formData.timeoutMs}
                  onChange={(e) =>
                    setFormData({ ...formData, timeoutMs: parseInt(e.target.value) || 0 })
                  }
                />
              </FormField>

              <FormField label={t("endpoints.fields.queueTimeout", "队列超时 (ms, 0为不限制)")}>
                <Input
                  type="number"
                  value={formData.queueTimeoutMs}
                  onChange={(e) =>
                    setFormData({ ...formData, queueTimeoutMs: parseInt(e.target.value) || 0 })
                  }
                />
              </FormField>

              <FormField label={t("endpoints.fields.maxBody", "最大 Body (MB, 0为不限制)")}>
                <Input
                  type="number"
                  value={formData.maxBodyMb}
                  onChange={(e) =>
                    setFormData({ ...formData, maxBodyMb: parseInt(e.target.value) || 0 })
                  }
                />
              </FormField>
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setDialogOpen(false);
                  setSelectedEndpointId(null);
                }}
              >
                {t("common.cancel", "取消")}
              </Button>
              <Button type="submit">{t("common.save", "保存")}</Button>
            </DialogFooter>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function EndpointsTable({
  endpoints,
  handleEditClick,
  setDeleteEndpointConfirm,
  setSelectedEndpointId,
  setFormData,
  setDialogOpen,
  initialFormData
}: any) {
  const { t } = useTranslation();

  if (endpoints.length === 0) {
    return (
      <EmptyState
        icon={<Radio className="h-12 w-12" />}
        title={t("endpoints.empty.title", "暂无端点")}
        description={t("endpoints.empty.description", "添加您的第一个 API 端点")}
        action={{
          label: t("endpoints.actions.add", "添加端点"),
          onClick: () => {
            setSelectedEndpointId(null);
            setFormData(initialFormData);
            setDialogOpen(true);
          },
        }}
      />
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t("endpoints.table.name", "名称")}</TableHead>
          <TableHead>{t("endpoints.table.path", "监听路径")}</TableHead>
          <TableHead>{t("endpoints.table.protocol", "协议")}</TableHead>
          <TableHead>{t("endpoints.table.alias", "别名")}</TableHead>
          <TableHead>{t("endpoints.table.status", "状态")}</TableHead>
          <TableHead className="text-right">{t("endpoints.table.actions", "操作")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {endpoints.map((ep: any) => (
          <TableRow key={ep.id}>
            <TableCell className="font-medium">{ep.name}</TableCell>
            <TableCell className="font-mono text-sm">{ep.path}</TableCell>
            <TableCell>
              <Badge variant="outline">{ep.incomingProtocol}</Badge>
            </TableCell>
            <TableCell>{ep.virtualModelAlias || "-"}</TableCell>
            <TableCell>
              <StatusBadge
                status={ep.enabled ? "active" : "disabled"}
                label={ep.enabled ? t("endpoints.status.active", "启用") : t("endpoints.status.disabled", "禁用")}
              />
            </TableCell>
            <TableCell className="text-right">
              <div className="flex justify-end gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleEditClick(ep)}
                  title="编辑配置"
                >
                  <Settings className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setDeleteEndpointConfirm({ open: true, id: ep.id, name: ep.name })}
                  className="text-destructive hover:text-destructive"
                  title="删除"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
