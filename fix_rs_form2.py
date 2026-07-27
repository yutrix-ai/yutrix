import re

with open("apps/web/src/components/Routes/ScheduleForm.tsx", "r") as f:
    code = f.read()

sig_old = '''  scheduleModels,
  scheduleModelsLoading,
  loadScheduleModels,
  scheduleFallbackModels,
  scheduleFallbackModelsLoading,'''
sig_new = '''  allModels,'''

code = code.replace(sig_old, sig_new)

# Also remove any stray mapping code that uses `scheduleModels` inside the file if they still exist.
# Wait, I replaced the whole `config_old` div in my previous script, let's see if there are any remaining `scheduleModels`.
code = re.sub(r'scheduleModels\.filter\(m => m\.enabled !== false\)\.map\(m => \(', 'allModels.filter((m: any) => m.enabled !== false).map((m: any) => (', code)
code = re.sub(r'scheduleFallbackModels\.filter\(m => m\.enabled !== false\)\.map\(m => \(', 'allModels.filter((m: any) => m.enabled !== false).map((m: any) => (', code)

with open("apps/web/src/components/Routes/ScheduleForm.tsx", "w") as f:
    f.write(code)

