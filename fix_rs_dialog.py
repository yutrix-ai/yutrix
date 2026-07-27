import re

with open("apps/web/src/components/RouteScheduleDialog.tsx", "r") as f:
    code = f.read()

# Add allModels to props
code = code.replace("policies: Policy[];", "policies: Policy[];\n  allModels: any[];")
code = code.replace("policies,\n  onSuccess,", "policies,\n  allModels,\n  onSuccess,")

# Update initial state
initial_state_old = '''    providerId: "",
    providerProtocol: "openai",
    modelId: "",
    allowClientModel: false,
    promptPolicyId: "none",
    fallbackEnabled: false,
    fallbackProviderId: "none",
    fallbackProviderProtocol: "openai",
    fallbackModelId: "none",
    fallbackPromptPolicyId: "none",
    fallbackMatchTarget: false,'''
initial_state_new = '''    targets: [],
    allowClientModel: false,'''
code = code.replace(initial_state_old, initial_state_new)

# Update openAddSchedule
openAdd_old = '''      providerId: "",
      providerProtocol: "openai",
      modelId: "",
      allowClientModel: false,
      promptPolicyId: "none",
      fallbackEnabled: false,
      fallbackProviderId: "none",
      fallbackProviderProtocol: "openai",
      fallbackModelId: "none",
      fallbackPromptPolicyId: "none",
      fallbackMatchTarget: false,'''
openAdd_new = '''      targets: [],
      allowClientModel: false,'''
code = code.replace(openAdd_old, openAdd_new)

# Update openEditSchedule
openEdit_old = '''      providerId: schedule.providerId || "",
      providerProtocol: schedule.providerProtocol || "openai",
      modelId: schedule.modelId || "",
      allowClientModel: !!schedule.allowClientModel,
      promptPolicyId: schedule.promptPolicyId || "none",
      fallbackEnabled: !!schedule.fallbackEnabled,
      fallbackProviderId: schedule.fallbackProviderId || "none",
      fallbackProviderProtocol: schedule.fallbackProviderProtocol || "openai",
      fallbackModelId: schedule.fallbackModelId || "none",
      fallbackPromptPolicyId: schedule.fallbackPromptPolicyId || "none",
      fallbackMatchTarget: !!schedule.fallbackMatchTarget,'''
openEdit_new = '''      targets: schedule.targets ? (typeof schedule.targets === 'string' ? JSON.parse(schedule.targets) : schedule.targets) : (() => {
        const t = [{
          providerId: schedule.providerId || "",
          providerProtocol: schedule.providerProtocol || "openai",
          modelId: schedule.modelId || "",
          promptPolicyId: schedule.promptPolicyId || "none",
          bestEffort: false,
          strategyRoutingEnabled: false,
          strategyRoutingRules: []
        }];
        if (schedule.fallbackEnabled && schedule.fallbackProviderId && schedule.fallbackProviderId !== "none") {
          t.push({
            providerId: schedule.fallbackProviderId,
            providerProtocol: schedule.fallbackProviderProtocol || "openai",
            modelId: schedule.fallbackModelId || "",
            promptPolicyId: schedule.fallbackPromptPolicyId || "none",
            bestEffort: !!schedule.fallbackMatchTarget,
            strategyRoutingEnabled: false,
            strategyRoutingRules: []
          });
        }
        return t;
      })(),
      allowClientModel: !!schedule.allowClientModel,'''
code = code.replace(openEdit_old, openEdit_new)

# Remove unused loadScheduleModels calls from openEditSchedule
code = re.sub(r'loadScheduleModels\(schedule\.providerId, false\);[\s\S]*?setIsEditingSchedule\(true\);', 'setIsEditingSchedule(true);', code)

# Update handleSaveSchedule
save_old = '''      endNextDay: endNextDayComputed,
      promptPolicyId: scheduleFormData.promptPolicyId === "none" ? null : scheduleFormData.promptPolicyId,
      fallbackProviderId: scheduleFormData.fallbackProviderId === "none" ? null : scheduleFormData.fallbackProviderId,
      fallbackModelId: scheduleFormData.fallbackModelId === "none" ? null : scheduleFormData.fallbackModelId,
      fallbackPromptPolicyId: scheduleFormData.fallbackPromptPolicyId === "none" ? null : scheduleFormData.fallbackPromptPolicyId,'''
save_new = '''      endNextDay: endNextDayComputed,
      targets: typeof scheduleFormData.targets === 'string' ? scheduleFormData.targets : JSON.stringify(scheduleFormData.targets || []),'''
code = code.replace(save_old, save_new)

# Replace the component props in <ScheduleForm />
form_props_old = '''              scheduleModels={scheduleModels}
              scheduleModelsLoading={scheduleModelsLoading}
              loadScheduleModels={loadScheduleModels}
              scheduleFallbackModels={scheduleFallbackModels}
              scheduleFallbackModelsLoading={scheduleFallbackModelsLoading}'''
form_props_new = '''              allModels={allModels}'''
code = code.replace(form_props_old, form_props_new)

with open("apps/web/src/components/RouteScheduleDialog.tsx", "w") as f:
    f.write(code)

