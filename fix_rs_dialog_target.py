import re

with open("apps/web/src/components/RouteScheduleDialog.tsx", "r") as f:
    code = f.read()

save_old = '''      targets: typeof scheduleFormData.targets === 'string' ? scheduleFormData.targets : JSON.stringify(scheduleFormData.targets || []),'''
save_new = '''      targets: typeof scheduleFormData.targets === 'string' ? JSON.parse(scheduleFormData.targets) : scheduleFormData.targets,'''

code = code.replace(save_old, save_new)

with open("apps/web/src/components/RouteScheduleDialog.tsx", "w") as f:
    f.write(code)

