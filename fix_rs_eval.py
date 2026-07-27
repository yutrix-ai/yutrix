import re

with open("apps/server/src/utils/scheduleEvaluator.ts", "r") as f:
    code = f.read()

# Add targets to the return value of resolveActiveRouteProperties
old_return = '''    ...route,
    providerId: activeSchedule.providerId,
    providerProtocol: activeSchedule.providerProtocol,
    modelId: activeSchedule.modelId,
    promptPolicyId: activeSchedule.promptPolicyId || null,
    allowClientModel: !!activeSchedule.allowClientModel,
    fallbackEnabled: !!activeSchedule.fallbackEnabled,
    fallbackProviderId: activeSchedule.fallbackProviderId || null,
    fallbackProviderProtocol: activeSchedule.fallbackProviderProtocol || null,
    fallbackModelId: activeSchedule.fallbackModelId || null,
    fallbackPromptPolicyId: activeSchedule.fallbackPromptPolicyId || null,
    fallbackMatchTarget: !!activeSchedule.fallbackMatchTarget,
    strategyRoutingEnabled: false,'''
new_return = '''    ...route,
    targets: activeSchedule.targets ? (typeof activeSchedule.targets === 'string' ? activeSchedule.targets : JSON.stringify(activeSchedule.targets)) : route.targets,
    providerId: activeSchedule.providerId,
    providerProtocol: activeSchedule.providerProtocol,
    modelId: activeSchedule.modelId,
    promptPolicyId: activeSchedule.promptPolicyId || null,
    allowClientModel: !!activeSchedule.allowClientModel,
    fallbackEnabled: !!activeSchedule.fallbackEnabled,
    fallbackProviderId: activeSchedule.fallbackProviderId || null,
    fallbackProviderProtocol: activeSchedule.fallbackProviderProtocol || null,
    fallbackModelId: activeSchedule.fallbackModelId || null,
    fallbackPromptPolicyId: activeSchedule.fallbackPromptPolicyId || null,
    fallbackMatchTarget: !!activeSchedule.fallbackMatchTarget,
    strategyRoutingEnabled: false,'''

code = code.replace(old_return, new_return)

with open("apps/server/src/utils/scheduleEvaluator.ts", "w") as f:
    f.write(code)

