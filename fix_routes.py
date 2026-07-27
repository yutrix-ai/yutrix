import re

with open("apps/web/src/pages/Routes.tsx", "r") as f:
    code = f.read()

# remove old fallback/provider vars
code = re.sub(r'  const selectedProvider = state\.getProviderById\(state\.formData\.providerId\);.*?const filteredPolicies = .*?;', '', code, flags=re.DOTALL)

# fix contextValue
context_value_old = r'''  const contextValue = \{
    dialogOpen: state\.dialogOpen, setDialogOpen: state\.setDialogOpen, editingId: state\.editingId, handleSave: state\.handleSave, formData: state\.formData, setFormData: state\.setFormData,
    providers: state\.providers, handleProviderChange: state\.handleProviderChange, handlePathChange: state\.handlePathChange, handleProtocolChange: state\.handleProtocolChange,
    filteredModels, loadingModels: state\.loadingModels, primaryModelMessage: state\.primaryModelMessage, setPrimaryModelMessage: state\.setPrimaryModelMessage, showPrimaryAdapterHint,
    filteredPolicies, handleFallbackProviderChange: state\.handleFallbackProviderChange, filteredFallbackModels,
    loadingFallbackModels: state\.loadingFallbackModels, fallbackModelMessage: state\.fallbackModelMessage, setFallbackModelMessage: state\.setFallbackModelMessage, showFallbackAdapterHint,
    groups: state\.groups, usersForSelect: state\.usersForSelect, closeDialog: state\.closeDialog, getProviderProtocolForSelection: state\.getProviderProtocolForSelection, selectedProvider, selectedFallbackProvider,
    allModels: state\.allModels, getDefaultStrategyRules: state\.getDefaultStrategyRules
  \};'''

context_value_new = '''  const contextValue = {
    dialogOpen: state.dialogOpen, setDialogOpen: state.setDialogOpen, editingId: state.editingId, handleSave: state.handleSave, formData: state.formData, setFormData: state.setFormData,
    providers: state.providers, handlePathChange: state.handlePathChange, handleProtocolChange: state.handleProtocolChange,
    policies: state.policies,
    groups: state.groups, usersForSelect: state.usersForSelect, closeDialog: state.closeDialog, getProviderProtocolForSelection: state.getProviderProtocolForSelection,
    allModels: state.allModels, getDefaultStrategyRules: state.getDefaultStrategyRules
  };'''

code = re.sub(context_value_old, context_value_new, code, flags=re.DOTALL)

with open("apps/web/src/pages/Routes.tsx", "w") as f:
    f.write(code)

