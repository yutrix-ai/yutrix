import re

with open("apps/web/src/components/RouteScheduleDialog.tsx", "r") as f:
    code = f.read()

save_old = '''    if (!scheduleFormData.name || !scheduleFormData.providerId || !scheduleFormData.modelId) {
      toast.error(t("routes.toasts.fillRequired", "请填写所有必填项"));
      return;
    }'''

save_new = '''    if (!scheduleFormData.name || !scheduleFormData.targets || scheduleFormData.targets.length === 0 || !scheduleFormData.targets[0].providerId || !scheduleFormData.targets[0].modelId) {
      toast.error(t("routes.toasts.fillRequired", "请填写所有必填项"));
      return;
    }'''

code = code.replace(save_old, save_new)

with open("apps/web/src/components/RouteScheduleDialog.tsx", "w") as f:
    f.write(code)

