const fs = require('fs');

const path = '/Users/tomwu/IdeaProjects/PromptGate/apps/web/src/components/Routes/useRoutesState.ts';
let code = fs.readFileSync(path, 'utf8');

// Replace formData state
const formDataOld = `  const [formData, setFormData] = useState({
    name: "",
    hostInput: "",
    path: "",
    incomingProtocol: "openai",
    providerId: "",
    providerProtocol: "openai",
    modelId: "",
    promptPolicyId: "none",
    timeoutMs: 0,
    retryCount: 3,
    queueTimeoutMs: 0,
    maxBodyMb: 0,
    fallbackEnabled: false,
    fallbackProviderId: "none",
    fallbackProviderProtocol: "openai",
    fallbackModelId: "none",
    fallbackPromptPolicyId: "none",
    fallbackMatchTarget: false,
    fallbackStrategyRoutingEnabled: false,
    fallbackStrategyRoutingRules: [] as StrategyRoutingRule[],
    strategyRoutingEnabled: false,
    strategyRoutingRules: [] as StrategyRoutingRule[],
    enabled: true,
    allowClientModel: false,
    authorizedUserIds: [] as string[],
    authorizedGroupIds: [] as string[],
  });`;

const formDataNew = `  const [formData, setFormData] = useState({
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
  });`;
code = code.replace(formDataOld, formDataNew);

// In handleSave
const handleSaveOld = `  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    
    let currentProviderId = formData.providerId;
    let currentModelId = formData.modelId;

    if (formData.strategyRoutingEnabled) {
      const rules = completeStrategyRules({
        rules: formData.strategyRoutingRules,
        providerId: formData.providerId,
        providerProtocol: formData.providerProtocol,
        modelId: formData.modelId,
      });
      const generalRule = rules.find(r => r.taskType === "general");
      if (generalRule) {
        currentProviderId = generalRule.providerId;
        currentModelId = generalRule.modelId;
      }
    }

    if (!formData.hostInput || !formData.path || !currentProviderId || !currentModelId) {
      toast.error(t("routes.toasts.fillRequired", "请填写所有必填项"));
      return;
    }

    let primaryModelsForSave = models;
    if (modelsProviderId !== currentProviderId) {
      try {
        primaryModelsForSave = await fetchProviderModels(currentProviderId);
        setModels(primaryModelsForSave);
        setModelsProviderId(currentProviderId);
      } catch (e: any) {
        toast.error(t("routes.toasts.loadModelsFailed", "加载模型失败") + ": " + e.message);
        return;
      }
    }

    const provider = getProviderById(currentProviderId);
    const selectableModels = getSelectableModels(primaryModelsForSave);
    const selectedModel = selectableModels.find(m => m.modelId === currentModelId);
    if (!selectedModel) {
      const message = primaryModelMessage || t("routes.toasts.modelUnavailable", "当前模型不再可用，请重新选择模型");
      setPrimaryModelMessage(message);
      toast.error(message);
      return;
    }

    let resolvedFallbackProviderProtocol: string | null = null;
    if (formData.fallbackEnabled) {
      if (formData.fallbackProviderId === "none") {
        toast.error(t("routes.toasts.fallbackRequired", "启用降级时必须选择降级供应商和降级模型"));
        return;
      }
      if (!formData.fallbackStrategyRoutingEnabled && !formData.fallbackModelId) {
        toast.error(t("routes.toasts.fallbackRequired", "启用降级时必须选择降级供应商和降级模型"));
        return;
      }
      let fallbackModelsForSave = fallbackModels;
      if (fallbackModelsProviderId !== formData.fallbackProviderId) {
        try {
          fallbackModelsForSave = await fetchProviderModels(formData.fallbackProviderId);
          setFallbackModels(fallbackModelsForSave);
          setFallbackModelsProviderId(formData.fallbackProviderId);
        } catch (e: any) {
          toast.error(t("routes.toasts.loadFallbackModelsFailed", "加载降级模型失败") + ": " + e.message);
          return;
        }
      }

      const selectedFallbackProvider = getProviderById(formData.fallbackProviderId);
      const selectableFallbackModels = getSelectableModels(fallbackModelsForSave);
      if (!formData.fallbackStrategyRoutingEnabled) {
        const selectedFallbackModel = selectableFallbackModels.find(m => m.modelId === formData.fallbackModelId);
        if (!selectedFallbackModel) {
          const message = fallbackModelMessage || t("routes.toasts.fallbackModelUnavailable", "当前降级模型不再可用，请重新选择");
          setFallbackModelMessage(message);
          toast.error(message);
          return;
        }
      }
      resolvedFallbackProviderProtocol = getProviderProtocolForSelection(formData.incomingProtocol, selectedFallbackProvider);
    }

    try {
      const resolvedProviderProtocol = getProviderProtocolForSelection(formData.incomingProtocol, provider);
      const strategyRoutingRules = formData.strategyRoutingEnabled
        ? completeStrategyRules({
            rules: formData.strategyRoutingRules,
            providerId: currentProviderId,
            providerProtocol: resolvedProviderProtocol,
            modelId: currentModelId,
          })
        : [];
      const dataToSave = {
        name: formData.name,
        hostInput: formData.hostInput,
        path: formData.path,
        incomingProtocol: formData.incomingProtocol,
        providerId: currentProviderId,
        providerProtocol: resolvedProviderProtocol,
        modelId: currentModelId,
        promptPolicyId: formData.promptPolicyId === "none" ? null : formData.promptPolicyId,
        timeoutMs: formData.timeoutMs,
        retryCount: formData.retryCount,
        queueTimeoutMs: formData.queueTimeoutMs,
        maxBodyMb: formData.maxBodyMb,
        fallbackEnabled: formData.fallbackEnabled,
        fallbackProviderId: formData.fallbackEnabled && formData.fallbackProviderId !== "none" ? formData.fallbackProviderId : null,
        fallbackProviderProtocol: resolvedFallbackProviderProtocol,
        fallbackModelId: formData.fallbackEnabled ? formData.fallbackModelId : null,
        fallbackPromptPolicyId: formData.fallbackEnabled && formData.fallbackPromptPolicyId !== "none" ? formData.fallbackPromptPolicyId : null,
        fallbackMatchTarget: formData.fallbackMatchTarget,
        fallbackStrategyRoutingEnabled: formData.fallbackStrategyRoutingEnabled,
        fallbackStrategyRoutingRules: formData.fallbackStrategyRoutingEnabled
          ? completeStrategyRules({
              rules: formData.fallbackStrategyRoutingRules,
              providerId: formData.fallbackProviderId !== "none" ? formData.fallbackProviderId : currentProviderId,
              providerProtocol: resolvedFallbackProviderProtocol || resolvedProviderProtocol,
              modelId: formData.fallbackModelId || currentModelId,
            })
          : [],
        strategyRoutingEnabled: formData.strategyRoutingEnabled,
        strategyRoutingRules,
        enabled: formData.enabled,
        allowClientModel: formData.allowClientModel,
        authorizedUserIds: formData.authorizedUserIds,
        authorizedGroupIds: formData.authorizedGroupIds,
      };

      if (editingId) {
        await fetchApi(\`/admin/routes/\${editingId}\`, { method: "PATCH", body: JSON.stringify(dataToSave) });
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
  };`;

const handleSaveNew = `  const handleSave = async (e: React.FormEvent) => {
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
      };

      if (editingId) {
        await fetchApi(\`/admin/routes/\${editingId}\`, { method: "PATCH", body: JSON.stringify(dataToSave) });
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
  };`;
code = code.replace(handleSaveOld, handleSaveNew);

// In openCreate
const openCreateOld = `  const openCreate = () => {
    setEditingId(null);
    setFormData({
      name: "", hostInput: "*", path: "/v1/chat/completions", incomingProtocol: "openai", providerId: providers[0]?.id || "", providerProtocol: "openai",
      modelId: "", promptPolicyId: "none", timeoutMs: 0, retryCount: 3, queueTimeoutMs: 0, maxBodyMb: 0, fallbackEnabled: false, fallbackProviderId: "none",
      fallbackProviderProtocol: "openai", fallbackModelId: "none", fallbackPromptPolicyId: "none", fallbackMatchTarget: false,
      fallbackStrategyRoutingEnabled: false, fallbackStrategyRoutingRules: [],
      strategyRoutingEnabled: false, strategyRoutingRules: [],
      enabled: true, allowClientModel: false, authorizedUserIds: [], authorizedGroupIds: [],
    });
    setModels([]);
    setFallbackModels([]);
    setPrimaryModelMessage("");
    setFallbackModelMessage("");
    if (providers.length > 0) {
      loadModels(providers[0].id, { incomingProtocol: "openai" });
    }
    setDialogOpen(true);
  };`;

const openCreateNew = `  const openCreate = () => {
    setEditingId(null);
    setFormData({
      name: "", hostInput: "*", path: "/v1/chat/completions", incomingProtocol: "openai", 
      targets: [], timeoutMs: 0, retryCount: 3, queueTimeoutMs: 0, maxBodyMb: 0,
      enabled: true, allowClientModel: false, authorizedUserIds: [], authorizedGroupIds: [],
    });
    setDialogOpen(true);
  };`;
code = code.replace(openCreateOld, openCreateNew);

// In openEdit
const openEditOld = `  const openEdit = async (route: RouteItem) => {
    setEditingId(route.id);
    let hostInput = route.host;
    if (hostInput === "all" || hostInput === "*") hostInput = "*";
    const epProto = route.incomingProtocol || "openai";

    setFormData({
      name: route.name, hostInput, path: route.path, incomingProtocol: epProto, providerId: route.providerId,
      providerProtocol: route.providerProtocol || "openai", modelId: route.modelId, promptPolicyId: route.promptPolicyId || "none",
      timeoutMs: route.timeoutMs, retryCount: route.retryCount ?? 3, queueTimeoutMs: route.queueTimeoutMs, maxBodyMb: route.maxBodyMb, fallbackEnabled: route.fallbackEnabled,
      fallbackProviderId: route.fallbackProviderId || "none", fallbackProviderProtocol: route.fallbackProviderProtocol || "openai",
      fallbackModelId: route.fallbackModelId || "none", fallbackPromptPolicyId: route.fallbackPromptPolicyId || "none",
      fallbackMatchTarget: route.fallbackMatchTarget,
      fallbackStrategyRoutingEnabled: route.fallbackStrategyRoutingEnabled || false,
      fallbackStrategyRoutingRules: route.fallbackStrategyRoutingRules || [],
      strategyRoutingEnabled: route.strategyRoutingEnabled || false,
      strategyRoutingRules: route.strategyRoutingRules || [],
      enabled: route.enabled,
      allowClientModel: route.allowClientModel || false, authorizedUserIds: route.authorizedUserIds || [], authorizedGroupIds: route.authorizedGroupIds || [],
    });

    setPrimaryModelMessage("");
    setFallbackModelMessage("");

    await loadModels(route.providerId, { incomingProtocol: epProto, preferredModelId: route.modelId, preserveUnavailable: true, currentProviderProtocol: route.providerProtocol || "openai" });

    if (route.fallbackProviderId && route.fallbackProviderId !== "none") {
      await loadFallbackModels(route.fallbackProviderId, { incomingProtocol: epProto, preferredModelId: route.fallbackModelId || undefined, preserveUnavailable: true, currentProviderProtocol: route.fallbackProviderProtocol || "openai" });
    } else {
      setFallbackModels([]);
    }
    setDialogOpen(true);
  };`;

const openEditNew = `  const openEdit = async (route: RouteItem) => {
    setEditingId(route.id);
    let hostInput = route.host;
    if (hostInput === "all" || hostInput === "*") hostInput = "*";
    const epProto = route.incomingProtocol || "openai";

    let parsedTargets = [];
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
          modelId: route.fallbackModelId,
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
    });
    setDialogOpen(true);
  };`;
code = code.replace(openEditOld, openEditNew);

const handleProtocolChangeOld = `  const handleProtocolChange = (protocol: string, pathOverride?: string) => {
    let newPath = formData.path;
    if (pathOverride !== undefined) {
      newPath = pathOverride;
    } else if (!newPath || newPath === "/v1/chat/completions" || newPath === "/v1/messages") {
      newPath = protocol === "openai" ? "/v1/chat/completions" : "/v1/messages";
    }

    const selectedProvider = getProviderById(formData.providerId);
    const selectedFallbackProvider = getProviderById(formData.fallbackProviderId);

    setFormData(prev => ({
      ...prev,
      incomingProtocol: protocol,
      path: newPath,
      providerProtocol: prev.providerId ? getProviderProtocolForSelection(protocol, selectedProvider) : prev.providerProtocol,
      fallbackProviderProtocol: prev.fallbackEnabled && prev.fallbackProviderId !== "none" ? getProviderProtocolForSelection(protocol, selectedFallbackProvider) : prev.fallbackProviderProtocol,
      strategyRoutingRules: updateStrategyRuleProtocols(prev.strategyRoutingRules || [], protocol),
    }));
  };`;
const handleProtocolChangeNew = `  const handleProtocolChange = (protocol: string, pathOverride?: string) => {
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
  };`;
code = code.replace(handleProtocolChangeOld, handleProtocolChangeNew);

fs.writeFileSync(path, code);
