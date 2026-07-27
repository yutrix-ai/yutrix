const fs = require('fs');

const path = '/Users/tomwu/IdeaProjects/PromptGate/apps/web/src/components/Routes/useRoutesState.ts';
let code = fs.readFileSync(path, 'utf8');

// Replace formData initialization
code = code.replace(/const \[formData, setFormData\] = useState\(\{[\s\S]*?\}\);/, `const [formData, setFormData] = useState({
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
  });`);

// In openCreate
code = code.replace(/setFormData\(\{\s*name: "", hostInput: "\*", path: "\/v1\/chat\/completions"[\s\S]*?\}\);/, `setFormData({
      name: "", hostInput: "*", path: "/v1/chat/completions", incomingProtocol: "openai", 
      targets: [], timeoutMs: 0, retryCount: 3, queueTimeoutMs: 0, maxBodyMb: 0,
      enabled: true, allowClientModel: false, authorizedUserIds: [], authorizedGroupIds: [],
    });`);

// Remove old openCreate extra states reset
code = code.replace(/setModels\(\[\]\);\s*setFallbackModels\(\[\]\);\s*setPrimaryModelMessage\(""\);\s*setFallbackModelMessage\(""\);\s*if \(providers\.length > 0\) \{\s*loadModels\(providers\[0\]\.id, \{ incomingProtocol: "openai" \} \);\s*\}/, ``);

// In openEdit
code = code.replace(/setFormData\(\{[\s\S]*?authorizedGroupIds: route\.authorizedGroupIds \|\| \[\],\s*\}\);/, `
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
    });`);

// Remove openEdit extra load
code = code.replace(/setPrimaryModelMessage\(""\);\s*setFallbackModelMessage\(""\);\s*await loadModels\([\s\S]*?\}\s*setDialogOpen\(true\);/m, `setDialogOpen(true);`);


// In handleSave
code = code.replace(/const handleSave = async \(e: React\.FormEvent\) => \{[\s\S]*?const closeDialog = \(\) => \{/m, `const handleSave = async (e: React.FormEvent) => {
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
  };

  const closeDialog = () => {`);

fs.writeFileSync(path, code);
