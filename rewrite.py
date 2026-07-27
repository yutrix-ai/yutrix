import re

with open("apps/web/src/components/Routes/useRoutesState.ts", "r") as f:
    code = f.read()

# Replace formData init
code = re.sub(
    r'const \[formData, setFormData\] = useState\(\{.*?\}\);',
    r'''const [formData, setFormData] = useState({
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
  });''',
    code,
    flags=re.DOTALL
)

# Replace fallback state declarations
code = re.sub(
    r'const \[fallbackModels, setFallbackModels\].*?setFallbackModelMessage\(""\);',
    '',
    code,
    flags=re.DOTALL
)

# Remove old models declarations
code = re.sub(
    r'const \[models, setModels\].*?setPrimaryModelMessage\(""\);',
    '',
    code,
    flags=re.DOTALL
)

# In handleSave, replace everything from e.preventDefault() to catch
new_handle_save = '''e.preventDefault();
    
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
    }'''
code = re.sub(r'e\.preventDefault\(\);.*?\} catch \(e: any\) \{[^\}]*toast\.error.*?\}', new_handle_save + '\n    } catch (e: any) {\n      toast.error(t("common.saveFailed", "保存失败") + ": " + e.message);\n    }', code, flags=re.DOTALL)

# In openCreate, replace setFormData and following stuff
open_create_repl = '''setEditingId(null);
    setFormData({
      name: "", hostInput: "*", path: "/v1/chat/completions", incomingProtocol: "openai", 
      targets: [], timeoutMs: 0, retryCount: 3, queueTimeoutMs: 0, maxBodyMb: 0,
      enabled: true, allowClientModel: false, authorizedUserIds: [], authorizedGroupIds: [],
    });
    setDialogOpen(true);'''
code = re.sub(r'setEditingId\(null\);.*?setDialogOpen\(true\);', open_create_repl, code, flags=re.DOTALL, count=1)

# In openEdit
open_edit_repl = '''setEditingId(route.id);
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
    setDialogOpen(true);'''
code = re.sub(r'setEditingId\(route\.id\);.*?setDialogOpen\(true\);', open_edit_repl, code, flags=re.DOTALL, count=1)


# remove unused functions: loadModels, loadFallbackModels, handleProviderChange, handleFallbackProviderChange
code = re.sub(r'const loadModels = async.*?finally \{\s*setLoadingModels\(false\);\s*\}\s*\};', '', code, flags=re.DOTALL)
code = re.sub(r'const loadFallbackModels = async.*?finally \{\s*setLoadingFallbackModels\(false\);\s*\}\s*\};', '', code, flags=re.DOTALL)
code = re.sub(r'const handleProviderChange =.*?setModelsProviderId\(""\);\s*\}\s*\};', '', code, flags=re.DOTALL)
code = re.sub(r'const handleFallbackProviderChange =.*?setFallbackModelsProviderId\(""\);\s*\}\s*\};', '', code, flags=re.DOTALL)

# Modify handlePathChange
code = re.sub(r'const handlePathChange = \(val: string\) => \{.*?setFormData\(\{ \.\.\.formData, path: val \}\);\s*\};', r'''const handlePathChange = (val: string) => {
    let proto = formData.incomingProtocol;
    if (val.includes("/v1/messages")) proto = "anthropic";
    else if (val.includes("/v1/chat/completions")) proto = "openai";

    if (proto !== formData.incomingProtocol) {
      handleProtocolChange(proto, val);
      return;
    }
    setFormData({ ...formData, path: val });
  };''', code, flags=re.DOTALL)

# Modify handleProtocolChange
code = re.sub(r'const handleProtocolChange = \(protocol: string, pathOverride\?: string\) => \{.*?\}\)\);\s*\};', r'''const handleProtocolChange = (protocol: string, pathOverride?: string) => {
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
      targets: prev.targets.map(t => ({
        ...t,
        providerProtocol: getProviderProtocolForSelection(protocol, getProviderById(t.providerId)),
        strategyRoutingRules: updateStrategyRuleProtocols(t.strategyRoutingRules || [], protocol),
      }))
    }));
  };''', code, flags=re.DOTALL)

# Safely replace the return block at the end
return_block = '''return {
    t, routes, providers, allModels, policies, groups, usersForSelect, loading, dialogOpen, setDialogOpen, editingId,
    deleteConfirm, setDeleteConfirm, formData, setFormData, scheduleDialogOpen, setScheduleDialogOpen,
    selectedRouteForSchedule,
    openScheduleDialog, loadData, getProviderById, getAvailableModels, hasAnthropicEndpoint,
    hasOpenaiEndpoint, getProviderProtocolForSelection, getSelectableModels, getUnavailableMessage, resolveModelSelection,
    fetchProviderModels, getDefaultStrategyRules, handlePathChange,
    handleProtocolChange, handleSave, closeDialog, openCreate, openEdit, handleDelete, toggleEnable, getReadinessBadge
  };'''

code = re.sub(r'return \{\s*t, routes.*?getReadinessBadge\s*\};\s*\}\s*$', return_block + '\n}', code, flags=re.DOTALL)


with open("apps/web/src/components/Routes/useRoutesState.ts", "w") as f:
    f.write(code)

