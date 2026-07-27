import re

with open("apps/web/src/components/Routes/RouteDialog.tsx", "r") as f:
    code = f.read()

# Replace the useRouteForm imports to remove old variables
imports_old = r'''const \{
    dialogOpen, setDialogOpen, editingId, handleSave, formData, setFormData,
    providers, handleProviderChange, handlePathChange, handleProtocolChange,
    filteredModels, loadingModels, primaryModelMessage, setPrimaryModelMessage, showPrimaryAdapterHint,
    filteredPolicies, handleFallbackProviderChange, filteredFallbackModels,
    loadingFallbackModels, fallbackModelMessage, setFallbackModelMessage, showFallbackAdapterHint,
    groups, usersForSelect, closeDialog, getProviderProtocolForSelection, selectedProvider, selectedFallbackProvider,
    allModels, getDefaultStrategyRules
  \} = useRouteForm\(\);'''

imports_new = '''const {
    dialogOpen, setDialogOpen, editingId, handleSave, formData, setFormData,
    providers, handlePathChange, handleProtocolChange,
    policies,
    groups, usersForSelect, closeDialog, getProviderProtocolForSelection,
    allModels, getDefaultStrategyRules
  } = useRouteForm();'''
code = re.sub(imports_old, imports_new, code)

# Add RouteTargetsTable import
if 'RouteTargetsTable' not in code:
    code = code.replace('import { StrategyRoutingEditor, StrategyRoutingSummary } from "./StrategyRoutingEditor";',
        'import { StrategyRoutingEditor, StrategyRoutingSummary } from "./StrategyRoutingEditor";\nimport { RouteTargetsTable } from "./RouteTargetsTable";')

# Remove setStrategyRoutingEnabled and buildDefaultStrategyRules since it's no longer used at the top level
code = re.sub(r'const buildDefaultStrategyRules =.*?setShowStrategyPanel\(enabled\);\s*\};\s*', '', code, flags=re.DOTALL)


# Replace everything from ` {/* 转发目标与路由模式 */}` down to just before ` {/* 运行时配置 */}`
targets_section_old = r'\{\/\* 转发目标与路由模式 \*\/.*?\{\/\* 运行时配置 \*\/\}'
targets_section_new = '''{/* 转发目标与路由模式 */}
              <div className="border-t pt-4">
                <RouteTargetsTable
                  targets={formData.targets || []}
                  onChange={targets => setFormData({...formData, targets})}
                  providers={providers}
                  allModels={allModels}
                  policies={policies}
                  incomingProtocol={formData.incomingProtocol}
                  getProviderProtocolForSelection={getProviderProtocolForSelection}
                />
              </div>

              {/* 运行时配置 */}'''

code = re.sub(targets_section_old, targets_section_new, code, flags=re.DOTALL)


# Remove the fallback section entirely (from {/* 降级配置 */} to the end of the form)
fallback_section_old = r'\{\/\* 降级配置 \*\/.*?<\/DialogBody>'
fallback_section_new = r'''</DialogBody>'''
code = re.sub(fallback_section_old, fallback_section_new, code, flags=re.DOTALL)

with open("apps/web/src/components/Routes/RouteDialog.tsx", "w") as f:
    f.write(code)

