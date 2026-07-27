import re

with open("apps/web/src/components/Routes/ScheduleForm.tsx", "r") as f:
    code = f.read()

# Add import
if "RouteTargetsTable" not in code:
    code = code.replace('import { Provider, ProviderModel, Policy } from "./types";', 'import { Provider, ProviderModel, Policy } from "./types";\nimport { RouteTargetsTable } from "./RouteTargetsTable";')

# Fix props
props_old = '''  scheduleModels: ProviderModel[];
  scheduleModelsLoading: boolean;
  loadScheduleModels: (providerId: string, isFallback: boolean) => Promise<void>;
  scheduleFallbackModels: ProviderModel[];
  scheduleFallbackModelsLoading: boolean;'''
props_new = '''  allModels: ProviderModel[];'''
code = code.replace(props_old, props_new)

# Replace the big config div
config_old = r'<div className="grid gap-4 md:grid-cols-2 pt-2">.*?</div>\s*</div>\s*</div>\s*</div>'
config_new = '''<RouteTargetsTable
          targets={scheduleFormData.targets || []}
          onChange={targets => setScheduleFormData({...scheduleFormData, targets})}
          providers={providers}
          allModels={allModels}
          policies={policies || []}
          getProviderProtocolForSelection={getProviderProtocolForSelection}
        />
        
        <div className="flex items-center gap-3 pt-4 border-t mt-6">
          <Switch
            id="schedule-allow-override"
            checked={scheduleFormData.allowClientModel}
            onCheckedChange={checked => setScheduleFormData({ ...scheduleFormData, allowClientModel: checked })}
          />
          <Label htmlFor="schedule-allow-override" className="cursor-pointer select-none font-normal">
            {t("routes.fields.allowClientModel", "允许客户端指定模型")}
          </Label>
        </div>
      </div>
    </div>
  );
}'''

code = re.sub(config_old, config_new, code, flags=re.DOTALL)

with open("apps/web/src/components/Routes/ScheduleForm.tsx", "w") as f:
    f.write(code)

