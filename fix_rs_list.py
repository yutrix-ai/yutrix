import re

with open("apps/web/src/components/Routes/ScheduleList.tsx", "r") as f:
    code = f.read()

# Replace the text-xs div
old_div = r'<div className="text-xs text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 pt-1">.*?</div>\s*</div>\s*</div>\s*<div className="flex gap-2 self-end md:self-center">'
new_div = '''<div className="text-xs text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 pt-1">
                {(() => {
                  let targetsList = [];
                  if (item.targets) {
                    targetsList = typeof item.targets === 'string' ? JSON.parse(item.targets) : item.targets;
                  } else {
                    targetsList.push({
                      providerId: item.providerId,
                      modelId: item.modelId
                    });
                    if (item.fallbackEnabled) {
                      targetsList.push({
                        providerId: item.fallbackProviderId,
                        modelId: item.fallbackModelId,
                        bestEffort: item.fallbackMatchTarget
                      });
                    }
                  }
                  
                  return targetsList.map((target: any, idx: number) => {
                    const providerName = providers.find(p => p.id === target.providerId)?.name || target.providerId;
                    return (
                      <div key={idx} className="flex items-center gap-1">
                        <span className="font-medium text-zinc-700 dark:text-zinc-300">
                          {idx === 0 ? t("routes.fields.targetProvider", "主要目标") : t("routes.table.fallback", "降级")}:
                        </span>{" "}
                        {providerName} ({target.modelId})
                        {target.bestEffort && <span className="ml-1 text-[10px] text-indigo-500 font-semibold">({t("routes.badges.bestEffort", "尽力而为")})</span>}
                      </div>
                    );
                  });
                })()}
              </div>
            </div>
            <div className="flex gap-2 self-end md:self-center">'''

code = re.sub(old_div, new_div, code, flags=re.DOTALL)

with open("apps/web/src/components/Routes/ScheduleList.tsx", "w") as f:
    f.write(code)

