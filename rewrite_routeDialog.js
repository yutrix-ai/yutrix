const fs = require('fs');

const path = '/Users/tomwu/IdeaProjects/PromptGate/apps/web/src/components/Routes/RouteDialog.tsx';
let code = fs.readFileSync(path, 'utf8');

const importsOld = `  const {
    dialogOpen, setDialogOpen, editingId, handleSave, formData, setFormData,
    providers, handleProviderChange, handlePathChange, handleProtocolChange,
    filteredModels, loadingModels, primaryModelMessage, setPrimaryModelMessage, showPrimaryAdapterHint,
    filteredPolicies, handleFallbackProviderChange, filteredFallbackModels,
    loadingFallbackModels, fallbackModelMessage, setFallbackModelMessage, showFallbackAdapterHint,
    groups, usersForSelect, closeDialog, getProviderProtocolForSelection, selectedProvider, selectedFallbackProvider,
    allModels, getDefaultStrategyRules
  } = useRouteForm();`;
const importsNew = `  const {
    dialogOpen, setDialogOpen, editingId, handleSave, formData, setFormData,
    providers, handlePathChange, handleProtocolChange,
    policies,
    groups, usersForSelect, closeDialog, getProviderProtocolForSelection,
    allModels, getDefaultStrategyRules
  } = useRouteForm();`;
code = code.replace(importsOld, importsNew);

const useRouteFormImport = `import { useRouteForm } from "./RouteFormContext";`;
const useRouteFormImportNew = `import { useRouteForm } from "./RouteFormContext";\nimport { RouteTargetsTable } from "./RouteTargetsTable";`;
if (!code.includes("RouteTargetsTable")) {
  code = code.replace(useRouteFormImport, useRouteFormImportNew);
}

// target section replace
const targetStart = `{/* 转发目标与路由模式 */}`;
const targetEnd = `{/* 运行时配置 */}`;
const targetFullMatch = code.substring(code.indexOf(targetStart), code.indexOf(targetEnd));

const newTargetSection = `{/* 转发目标与路由模式 */}
              <div className="border-t pt-4">
                <RouteTargetsTable
                  targets={formData.targets || []}
                  onChange={targets => setFormData({...formData, targets})}
                  providers={providers}
                  allModels={allModels}
                  policies={policies || []}
                  incomingProtocol={formData.incomingProtocol}
                  getProviderProtocolForSelection={getProviderProtocolForSelection}
                />
              </div>

              `;
code = code.replace(targetFullMatch, newTargetSection);

// fallback section replace
const fallbackStart = `{/* 降级配置 */}`;
const fallbackEnd = `</DialogBody>`;
const fallbackFullMatch = code.substring(code.indexOf(fallbackStart), code.indexOf(fallbackEnd));
code = code.replace(fallbackFullMatch, "");

fs.writeFileSync(path, code);
