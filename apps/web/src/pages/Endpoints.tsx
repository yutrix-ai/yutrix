import { useState, useEffect } from "react";
import { fetchApi } from "../lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useTranslation } from "react-i18next";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { toast } from "sonner";
import { Skeleton } from "@/components/ui/skeleton";
import { EndpointFormDialog, EndpointsTable } from "@/components/Endpoints/EndpointsComponents";

interface Endpoint {
  id: string;
  name: string;
  path: string;
  virtualModelAlias: string | null;
  incomingProtocol: string;
  enabled: boolean;
  timeoutMs: number;
  queueTimeoutMs: number;
  maxBodyMb: number;
}

interface Provider {
  id: string;
  name: string;
  openaiBaseUrl?: string;
  anthropicBaseUrl?: string;
  enabled: boolean;
}

interface ProviderModel {
  id: string;
  providerId: string;
  protocol: string;
  modelId: string;
  displayName: string;
}

interface Subdomain {
  id: string;
  name: string;
  hostname: string;
  enabled: boolean;
}

interface Policy {
  id: string;
  name: string;
  protocol: string;
}

const initialFormData = {
  name: "",
  path: "/v1/chat/completions",
  virtualModelAlias: "",
  incomingProtocol: "openai",
  timeoutMs: 60000,
  queueTimeoutMs: 30000,
  maxBodyMb: 10,
  defaultProviderId: "",
  defaultPromptPolicyId: "none",
};

export default function Endpoints() {
  const { t } = useTranslation();
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [allModels, setAllModels] = useState<ProviderModel[]>([]);
  const [allPolicies, setAllPolicies] = useState<Policy[]>([]);

  const [selectedEndpointId, setSelectedEndpointId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleteEndpointConfirm, setDeleteEndpointConfirm] = useState<{
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
      const [ep, prov, , models, policies] = await Promise.all([
        fetchApi("/admin/endpoints"),
        fetchApi("/admin/providers"),
        fetchApi("/admin/subdomains"),
        fetchApi("/admin/models"),
        fetchApi("/admin/policies"),
      ]);
      setEndpoints(ep);
      setProviders(prov);
      setAllModels(models);
      setAllPolicies(policies);
    } catch (e: any) {
      toast.error(t("endpoints.toasts.loadFailed", "加载数据失败") + ": " + e.message);
    } finally {
      setLoading(false);
    }
  };

  const handleEditClick = async (ep: Endpoint) => {
    setSelectedEndpointId(ep.id);
    try {
      const res = await fetchApi(`/admin/endpoints/${ep.id}/routes`);
      const firstRoute = res[0] || {};
      setFormData({
        name: ep.name,
        path: ep.path,
        virtualModelAlias: ep.virtualModelAlias || "",
        incomingProtocol: ep.incomingProtocol,
        timeoutMs: ep.timeoutMs,
        queueTimeoutMs: ep.queueTimeoutMs,
        maxBodyMb: ep.maxBodyMb,
        defaultProviderId: firstRoute.providerId && firstRoute.providerId !== "setup_required" ? firstRoute.providerId : "",
        defaultPromptPolicyId: firstRoute.promptPolicyId || "none",
      });
      setDialogOpen(true);
    } catch (e: any) {
      toast.error(t("endpoints.toasts.detailsFailed", "加载详情失败") + ": " + e.message);
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    const payload = {
      ...formData,
      defaultPromptPolicyId: formData.defaultPromptPolicyId === "none" ? null : formData.defaultPromptPolicyId,
    };
    try {
      if (selectedEndpointId) {
        await fetchApi(`/admin/endpoints/${selectedEndpointId}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        });
        toast.success(t("endpoints.toasts.updateSuccess", "端点更新成功"));
      } else {
        await fetchApi("/admin/endpoints", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        toast.success(t("endpoints.toasts.createSuccess", "端点创建成功"));
      }
      setDialogOpen(false);
      loadData();
    } catch (e: any) {
      toast.error(t("endpoints.toasts.saveFailed", "保存失败") + ": " + e.message);
    }
  };

  const handleDeleteEndpoint = async () => {
    if (!deleteEndpointConfirm.id) return;
    try {
      await fetchApi(`/admin/endpoints/${deleteEndpointConfirm.id}`, {
        method: "DELETE",
        body: "{}",
      });
      toast.success(t("endpoints.toasts.deleted", "端点已删除"));
      if (selectedEndpointId === deleteEndpointConfirm.id) {
        setSelectedEndpointId(null);
      }
      loadData();
      setDeleteEndpointConfirm({ open: false, id: null, name: "" });
    } catch (e: any) {
      toast.error(t("endpoints.toasts.deleteFailed", "删除失败") + ": " + e.message);
    }
  };

  const getModelsForProviderProtocol = (providerId: string, protocol: string) => {
    return allModels.filter(
      (m) => m.providerId === providerId && m.protocol === protocol
    );
  };

  const availablePolicies = allPolicies.filter(
    (p) => p.protocol === formData.incomingProtocol
  );

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="grid gap-6 lg:grid-cols-3">
          <Card className="lg:col-span-1">
            <CardContent className="p-6">
              <div className="space-y-3">
                {[...Array(3)].map((_, i) => (
                  <Skeleton key={i} className="h-16 w-full" />
                ))}
              </div>
            </CardContent>
          </Card>
          <Card className="lg:col-span-2">
            <CardContent className="p-6">
              <Skeleton className="h-64 w-full" />
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-end items-center">
        <EndpointFormDialog
          dialogOpen={dialogOpen}
          setDialogOpen={setDialogOpen}
          selectedEndpointId={selectedEndpointId}
          setSelectedEndpointId={setSelectedEndpointId}
          formData={formData}
          setFormData={setFormData}
          handleSave={handleSave}
          providers={providers}
          getModelsForProviderProtocol={getModelsForProviderProtocol}
          availablePolicies={availablePolicies}
          initialFormData={initialFormData}
        />
      </div>

      {/* Main Endpoints Table */}
      <Card>
        <CardHeader>
          <CardTitle>{t("endpoints.tableCard.title", "端点列表")}</CardTitle>
          <CardDescription>{t("endpoints.tableCard.subtitle", "管理所有的 API 端点")}</CardDescription>
        </CardHeader>
        <CardContent>
          <EndpointsTable
            endpoints={endpoints}
            handleEditClick={handleEditClick}
            setDeleteEndpointConfirm={setDeleteEndpointConfirm}
            setSelectedEndpointId={setSelectedEndpointId}
            setFormData={setFormData}
            setDialogOpen={setDialogOpen}
            initialFormData={initialFormData}
          />
        </CardContent>
      </Card>

      {/* Delete Endpoint Confirmation Dialog */}
      <ConfirmDialog
        open={deleteEndpointConfirm.open}
        onOpenChange={(open) => setDeleteEndpointConfirm({ ...deleteEndpointConfirm, open })}
        title={t("endpoints.deleteConfirm.title", "确认删除端点")}
        description={t("endpoints.deleteConfirm.description", "确定要删除 \"{{name}}\" 及其所有路由吗？此操作不可恢复。", { name: deleteEndpointConfirm.name })}
        confirmLabel={t("common.delete", "删除")}
        variant="destructive"
        onConfirm={handleDeleteEndpoint}
      />
    </div>
  );
}
