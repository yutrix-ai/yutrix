import { useState, useEffect } from "react";
import { fetchApi } from "@/lib/api";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { RouteItem, Provider, ProviderModel, Policy, StrategyRoutingRule } from "./types";
import {
  completeStrategyRules,
  createDefaultStrategyRules,
  firstModelForProvider,
  providerProtocolForRule,
} from "./strategyRoutingConfig";

interface GroupOption {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
}

interface UserOption {
  id: string;
  username: string;
  role: string;
  status: string;
}

export function useRoutesState() {
  const { t } = useTranslation();
  const [routes, setRoutes] = useState<RouteItem[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [allModels, setAllModels] = useState<ProviderModel[]>([]);
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [groups, setGroups] = useState<GroupOption[]>([]);
  const [usersForSelect, setUsersForSelect] = useState<UserOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  
  const [models, setModels] = useState<ProviderModel[]>([]);
  const [modelsProviderId, setModelsProviderId] = useState("");
  const [loadingModels, setLoadingModels] = useState(false);
  const [primaryModelMessage, setPrimaryModelMessage] = useState("");

  const [deleteConfirm, setDeleteConfirm] = useState({ open: false, id: null as string | null, name: "" });

  const [formData, setFormData] = useState({
    name: "",
    hostInput: "",
    path: "",
    incomingProtocol: "openai",
    targets: [] as any[],
    timeoutMs: 0,
    retryCount: 3,
    queueTimeoutMs: 0,
    maxBodyMb: 0,
    enabled: true,
    allowClientModel: false,
    authorizedUserIds: [] as string[],
    authorizedGroupIds: [] as string[],
    fallbackMatchTarget: false,
  });

  const [fallbackModels, setFallbackModels] = useState<ProviderModel[]>([]);
  const [fallbackModelsProviderId, setFallbackModelsProviderId] = useState("");
  const [loadingFallbackModels, setLoadingFallbackModels] = useState(false);
  const [fallbackModelMessage, setFallbackModelMessage] = useState("");

  const [scheduleDialogOpen, setScheduleDialogOpen] = useState(false);
  const [selectedRouteForSchedule, setSelectedRouteForSchedule] = useState<RouteItem | null>(null);

  useEffect(() => {
    if (selectedRouteForSchedule && routes.length > 0) {
      const updated = routes.find(r => r.id === selectedRouteForSchedule.id);
      if (updated) {
        setSelectedRouteForSchedule(updated);
      }
    }
  }, [routes]);

  const openScheduleDialog = (route: RouteItem) => {
    setSelectedRouteForSchedule(route);
    setScheduleDialogOpen(true);
  };

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      const [rData, pData, polData, gData, uData, mData] = await Promise.all([
        fetchApi("/admin/routes"),
        fetchApi("/admin/providers"),
        fetchApi("/admin/policies"),
        fetchApi("/admin/groups"),
        fetchApi("/admin/groups/users-for-select"),
        fetchApi("/admin/models"),
      ]);
      setRoutes(rData);
      setProviders(pData);
      setPolicies(polData);
      setGroups(gData);
      setAllModels(Array.isArray(mData) ? mData : []);
      setUsersForSelect(uData.filter((u: UserOption) => u.role === "user" && u.status !== "deleted"));
    } catch (e: any) {
      toast.error(t("routes.toasts.loadFailed", "加载失败") + ": " + e.message);
    } finally {
      setLoading(false);
    }
  };

  const getProviderById = (providerId: string) => providers.find(p => p.id === providerId);

  const getAvailableModels = (sourceModels: ProviderModel[]) => {
    const uniqueModels = new Map<string, ProviderModel>();
    for (const model of sourceModels) {
      if (model.enabled === false || uniqueModels.has(model.modelId)) continue;
      uniqueModels.set(model.modelId, model);
    }
    return Array.from(uniqueModels.values());
  };

  const hasAnthropicEndpoint = (provider?: Provider) => !!provider?.anthropicBaseUrl;
  const hasOpenaiEndpoint = (provider?: Provider) => !!provider?.openaiBaseUrl;

  const getProviderProtocolForSelection = (incomingProtocol: string, provider: Provider | undefined) => {
    if (incomingProtocol === "anthropic") {
      return hasAnthropicEndpoint(provider) ? "anthropic" : "openai";
    }
    return "openai";
  };

  const getDefaultStrategyRules = (
    providerId = "",
    incomingProtocol = formData.incomingProtocol,
    fallbackModelId = "",
  ) => {
    const provider = getProviderById(providerId);
    const firstModel = firstModelForProvider(allModels, providerId);
    const modelId = firstModel?.modelId || fallbackModelId;
    return createDefaultStrategyRules({
      providerId,
      providerProtocol: providerProtocolForRule(incomingProtocol, provider),
      modelId,
    });
  };

  const updateStrategyRuleProtocols = (rules: StrategyRoutingRule[], incomingProtocol: string) => {
    return rules.map((rule) => ({
      ...rule,
      providerProtocol: providerProtocolForRule(incomingProtocol, getProviderById(rule.providerId)),
    }));
  };

  const getSelectableModels = (sourceModels: ProviderModel[]) => getAvailableModels(sourceModels);

  const getUnavailableMessage = (label = "供应商") => {
    return label === "降级供应商"
      ? t("routes.toasts.fallbackModelUnavailable", "降级供应商没有可用模型。")
      : t("routes.toasts.modelUnavailable", "供应商没有可用模型。");
  };

  const resolveModelSelection = ({
    providerId, incomingProtocol, sourceModels, preferredModelId, preserveUnavailable = false, currentProviderProtocol = "openai", label = "供应商",
  }: any) => {
    const provider = getProviderById(providerId);
    const selectableModels = getSelectableModels(sourceModels);
    const selectedModel = preferredModelId ? selectableModels.find(m => m.modelId === preferredModelId) : undefined;

    if (selectedModel) {
      return { modelId: selectedModel.modelId, providerProtocol: getProviderProtocolForSelection(incomingProtocol, provider), message: "" };
    }
    if (preserveUnavailable && preferredModelId) {
      return { modelId: preferredModelId, providerProtocol: currentProviderProtocol, message: t("routes.toasts.modelUnavailable", "当前模型不再可用，请重新选择模型") };
    }
    if (selectableModels.length > 0) {
      const firstModel = selectableModels[0];
      return { modelId: firstModel.modelId, providerProtocol: getProviderProtocolForSelection(incomingProtocol, provider), message: "" };
    }
    return { modelId: "", providerProtocol: getProviderProtocolForSelection(incomingProtocol, provider), message: getUnavailableMessage(label) };
  };

  const fetchProviderModels = async (providerId: string): Promise<ProviderModel[]> => fetchApi(`/admin/providers/${providerId}/models`);

  const loadModels = async (providerId: string, options: any = {}) => {
    setLoadingModels(true);
    try {
      const res = await fetchProviderModels(providerId);
      setModels(res);
      setModelsProviderId(providerId);

      const selection = resolveModelSelection({
        providerId, incomingProtocol: options.incomingProtocol || formData.incomingProtocol, sourceModels: res, preferredModelId: options.preferredModelId, preserveUnavailable: options.preserveUnavailable, currentProviderProtocol: options.currentProviderProtocol,
      });

      setPrimaryModelMessage(selection.message);
      setFormData(prev => ({ ...prev, modelId: selection.modelId, providerProtocol: selection.providerProtocol }));
    } catch (e: any) {
      toast.error(t("routes.toasts.loadModelsFailed", "加载模型失败") + ": " + e.message);
      setModels([]);
      setModelsProviderId("");
      setPrimaryModelMessage(t("routes.toasts.modelLoadError", "模型加载失败，请稍后重试"));
    } finally {
      setLoadingModels(false);
    }
  };

  const loadFallbackModels = async (providerId: string, options: any = {}) => {
    setLoadingFallbackModels(true);
    try {
      const res = await fetchProviderModels(providerId);
      setFallbackModels(res);
      setFallbackModelsProviderId(providerId);

      const selection = resolveModelSelection({
        providerId, incomingProtocol: options.incomingProtocol || formData.incomingProtocol, sourceModels: res, preferredModelId: options.preferredModelId, preserveUnavailable: options.preserveUnavailable, currentProviderProtocol: options.currentProviderProtocol, label: "降级供应商",
      });

      setFallbackModelMessage(selection.message);
      setFormData(prev => ({ ...prev, fallbackModelId: selection.modelId, fallbackProviderProtocol: selection.providerProtocol }));
    } catch (e: any) {
      toast.error(t("routes.toasts.loadFallbackModelsFailed", "加载降级模型失败") + ": " + e.message);
      setFallbackModels([]);
      setFallbackModelsProviderId("");
      setFallbackModelMessage(t("routes.toasts.fallbackModelLoadError", "降级模型加载失败，请稍后重试"));
    } finally {
      setLoadingFallbackModels(false);
    }
  };

  const handleProviderChange = (providerId: string) => {
    setPrimaryModelMessage("");
    setFormData(prev => ({ ...prev, providerId, modelId: "", providerProtocol: "openai" }));
    if (providerId) {
      loadModels(providerId, { incomingProtocol: formData.incomingProtocol });
    } else {
      setModels([]);
      setModelsProviderId("");
    }
  };

  const handleFallbackProviderChange = (providerId: string) => {
    setFallbackModelMessage("");
    setFormData(prev => ({ ...prev, fallbackProviderId: providerId, fallbackModelId: "", fallbackProviderProtocol: "openai" }));
    if (providerId && providerId !== "none") {
      loadFallbackModels(providerId, { incomingProtocol: formData.incomingProtocol });
    } else {
      setFallbackModels([]);
      setFallbackModelsProviderId("");
    }
  };

  const handlePathChange = (val: string) => {
    let proto = formData.incomingProtocol;
    if (val.includes("/v1/messages")) proto = "anthropic";
    else if (val.includes("/v1/chat/completions")) proto = "openai";

    if (proto !== formData.incomingProtocol) {
      handleProtocolChange(proto, val);
      return;
    }
    setFormData({ ...formData, path: val });
  };

  const handleProtocolChange = (protocol: string, pathOverride?: string) => {
    let newPath = formData.path;
    if (pathOverride !== undefined) {
      newPath = pathOverride;
    } else if (!newPath || newPath === "/v1/chat/completions" || newPath === "/v1/messages") {
      newPath = protocol === "openai" ? "/v1/chat/completions" : "/v1/messages";
    }

    setFormData(prev => ({
      ...prev,
      incomingProtocol: protocol,
      path: newPath,
      targets: prev.targets.map((t: any) => ({
        ...t,
        providerProtocol: getProviderProtocolForSelection(protocol, getProviderById(t.providerId)),
        strategyRoutingRules: updateStrategyRuleProtocols(t.strategyRoutingRules || [], protocol),
      }))
    }));
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.hostInput || !formData.path || formData.targets.length === 0) {
      toast.error(t("routes.toasts.fillRequired", "请填写所有必填项（包含至少一个目标）"));
      return;
    }
    try {
      const dataToSave = {
        name: formData.name,
        hostInput: formData.hostInput,
        path: formData.path,
        incomingProtocol: formData.incomingProtocol,
        targets: formData.targets.map((t: any) => ({
          ...t,
          promptPolicyId: t.promptPolicyId === "none" ? null : t.promptPolicyId
        })),
        timeoutMs: formData.timeoutMs,
        retryCount: formData.retryCount,
        queueTimeoutMs: formData.queueTimeoutMs,
        maxBodyMb: formData.maxBodyMb,
        enabled: formData.enabled,
        allowClientModel: formData.allowClientModel,
        authorizedUserIds: formData.authorizedUserIds,
        authorizedGroupIds: formData.authorizedGroupIds,
        fallbackMatchTarget: formData.fallbackMatchTarget,
      };

      if (editingId) {
        await fetchApi(`/admin/routes/${editingId}`, { method: "PATCH", body: JSON.stringify(dataToSave) });
        toast.success(t("routes.toasts.updateSuccess", "路由规则已更新"));
      } else {
        await fetchApi("/admin/routes", { method: "POST", body: JSON.stringify(dataToSave) });
        toast.success(t("routes.toasts.createSuccess", "路由规则已创建"));
      }
      closeDialog();
      loadData();
    } catch (e: any) {
      toast.error(t("common.saveFailed", "保存失败") + ": " + e.message);
    }
  };

  const closeDialog = () => {
    setDialogOpen(false);
    setEditingId(null);
  };

  const openCreate = () => {
    setEditingId(null);
    setFormData({
      name: "", hostInput: "*", path: "/v1/chat/completions", incomingProtocol: "openai", 
      targets: [], timeoutMs: 0, retryCount: 3, queueTimeoutMs: 0, maxBodyMb: 0,
      enabled: true, allowClientModel: false, authorizedUserIds: [], authorizedGroupIds: [],
      fallbackMatchTarget: false,
    });
    setDialogOpen(true);
  };

  const openEdit = async (route: RouteItem) => {
    setEditingId(route.id);
    let hostInput = route.host;
    if (hostInput === "all" || hostInput === "*") hostInput = "*";
    const epProto = route.incomingProtocol || "openai";

    let parsedTargets: any[] = [];
    if (route.targets) {
      parsedTargets = typeof route.targets === 'string' ? JSON.parse(route.targets) : route.targets;
    } else {
      parsedTargets = [{
        providerId: route.providerId,
        providerProtocol: route.providerProtocol || "openai",
        modelId: route.modelId,
        promptPolicyId: route.promptPolicyId || "none",
        strategyRoutingEnabled: route.strategyRoutingEnabled || false,
        strategyRoutingRules: route.strategyRoutingRules || []
      }];
      if (route.fallbackEnabled && route.fallbackProviderId && route.fallbackProviderId !== "none") {
        parsedTargets.push({
          providerId: route.fallbackProviderId,
          providerProtocol: route.fallbackProviderProtocol || "openai",
          modelId: route.fallbackModelId || "",
          promptPolicyId: route.fallbackPromptPolicyId || "none",
          bestEffort: route.fallbackMatchTarget,
          strategyRoutingEnabled: route.fallbackStrategyRoutingEnabled || false,
          strategyRoutingRules: route.fallbackStrategyRoutingRules || []
        });
      }
    }

    setFormData({
      name: route.name, hostInput, path: route.path, incomingProtocol: epProto,
      targets: parsedTargets,
      timeoutMs: route.timeoutMs, retryCount: route.retryCount ?? 3, queueTimeoutMs: route.queueTimeoutMs, maxBodyMb: route.maxBodyMb,
      enabled: route.enabled,
      allowClientModel: route.allowClientModel || false, authorizedUserIds: route.authorizedUserIds || [], authorizedGroupIds: route.authorizedGroupIds || [],
      fallbackMatchTarget: route.fallbackMatchTarget || false,
    });
    setDialogOpen(true);
  };

  const handleDelete = async () => {
    if (!deleteConfirm.id) return;
    try {
      await fetchApi(`/admin/routes/${deleteConfirm.id}`, { method: "DELETE" });
      toast.success(t("routes.toasts.deleteSuccess", "路由规则已删除"));
      loadData();
    } catch (e: any) {
      toast.error(t("routes.toasts.deleteFailed", "删除失败") + ": " + e.message);
    } finally {
      setDeleteConfirm({ open: false, id: null, name: "" });
    }
  };

  const toggleEnable = async (id: string, checked: boolean) => {
    try {
      await fetchApi(`/admin/routes/${id}`, { method: "PATCH", body: JSON.stringify({ enabled: checked }) });
      toast.success(checked ? t("routes.toasts.routeEnabled", "路由已启用") : t("routes.toasts.routeDisabled", "路由已禁用"));
      loadData();
    } catch (e: any) {
      toast.error(t("routes.toasts.updateFailed", "更新失败") + ": " + e.message);
      loadData();
    }
  };

  const getReadinessBadge = (readiness: string, errorMessage?: string) => {
    switch (readiness) {
      case "ready": return { variant: "default", label: t("routes.readiness.ready", "正常") };
      case "disabled": return { variant: "secondary", label: t("routes.readiness.disabled", "已停用") };
      case "error": return { variant: "destructive", label: t("routes.readiness.error", "异常") };
      case "incomplete": return { variant: "warning", label: t("routes.readiness.incomplete", "配置缺失") };
      default: return { variant: "outline", label: t("routes.readiness.unknown", "未知") };
    }
  };

  return {
    t, routes, providers, allModels, policies, groups, usersForSelect, loading, dialogOpen, setDialogOpen, editingId,
    models, modelsProviderId, loadingModels, primaryModelMessage, setPrimaryModelMessage,
    deleteConfirm, setDeleteConfirm, formData, setFormData, fallbackModels, fallbackModelsProviderId,
    loadingFallbackModels, fallbackModelMessage, setFallbackModelMessage, scheduleDialogOpen, setScheduleDialogOpen,
    selectedRouteForSchedule,
    openScheduleDialog, loadData, getProviderById, getAvailableModels, hasAnthropicEndpoint,
    hasOpenaiEndpoint, getProviderProtocolForSelection, getSelectableModels, getUnavailableMessage, resolveModelSelection,
    fetchProviderModels, loadModels, loadFallbackModels, getDefaultStrategyRules, handleProviderChange, handleFallbackProviderChange, handlePathChange,
    handleProtocolChange, handleSave, closeDialog, openCreate, openEdit, handleDelete, toggleEnable, getReadinessBadge
  };
}
