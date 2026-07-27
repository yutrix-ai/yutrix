import re

with open("apps/web/src/components/Routes/ScheduleForm.tsx", "r") as f:
    code = f.read()

# Replace everything from the target section header to the end of the return statement
config_old = r'<div className="space-y-4 border rounded-lg p-4 bg-zinc-50/50 dark:bg-zinc-900/10">\s*<div className="font-medium text-sm text-zinc-700 dark:text-zinc-300 border-b pb-1\.5 flex items-center gap-1\.5">.*?</div>\s*</div>\s*\);\s*\}'

config_new = '''<div className="space-y-4 border rounded-lg p-4 bg-zinc-50/50 dark:bg-zinc-900/10">
        <RouteTargetsTable
          targets={scheduleFormData.targets || []}
          onChange={(targets: any) => setScheduleFormData({...scheduleFormData, targets})}
          providers={providers}
          allModels={allModels}
          policies={policies || []}
          getProviderProtocolForSelection={getProviderProtocolForSelection}
        />
        
        <div className="flex items-center gap-3 pt-4 border-t mt-6">
          <Switch
            id="schedule-allow-override"
            checked={scheduleFormData.allowClientModel}
            onCheckedChange={(checked: boolean) => setScheduleFormData({ ...scheduleFormData, allowClientModel: checked })}
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

