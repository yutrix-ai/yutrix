import re

with open("apps/web/src/components/Routes/RouteList.tsx", "r") as f:
    code = f.read()

# Find the Routing features badges section
badge_section_old = r'\{\/\* Routing features badges \*\/.*?\}\)\(\)\}'

new_badge_section = '''{/* Routing features badges */}
                    <div className="flex flex-wrap gap-1.5 mt-2 max-w-xl">
                      {r.strategyRoutingEnabled && renderStrategyBadges(r.strategyRoutingRules, allModels, t)}
                      
                      {(() => {
                        let targetsList = [];
                        if (r.targets) {
                          targetsList = typeof r.targets === 'string' ? JSON.parse(r.targets) : r.targets;
                        } else {
                          const fallbackEnabled = r.activeSchedule ? r.activeSchedule.fallbackEnabled : r.fallbackEnabled;
                          if (fallbackEnabled) {
                            targetsList.push({ isOldFallback: true });
                          }
                        }
                        
                        if (targetsList.length <= 1 && !targetsList[0]?.isOldFallback) return null;
                        
                        return targetsList.map((target: any, idx: number) => {
                          if (idx === 0 && !target.isOldFallback) return null; // skip primary
                          
                          let providerName = "未知";
                          let modelId = "";
                          let matchTarget = false;
                          let strategyEnabled = false;
                          
                          if (target.isOldFallback) {
                            const fallbackProviderId = r.activeSchedule ? r.activeSchedule.fallbackProviderId : r.fallbackProviderId;
                            modelId = r.activeSchedule ? r.activeSchedule.fallbackModelId : r.fallbackModelId;
                            matchTarget = r.activeSchedule ? r.activeSchedule.fallbackMatchTarget : r.fallbackMatchTarget;
                            strategyEnabled = (r as any).fallbackStrategyRoutingEnabled;
                            providerName = providers.find((p: any) => p.id === fallbackProviderId)?.name || "未知";
                          } else {
                            providerName = providers.find((p: any) => p.id === target.providerId)?.name || "未知";
                            modelId = target.modelId;
                            matchTarget = target.bestEffort;
                            strategyEnabled = target.strategyRoutingEnabled;
                          }
                          
                          if (strategyEnabled) {
                            return (
                              <Badge key={idx} variant="secondary" className="bg-indigo-50 text-indigo-700 border border-indigo-200/60 dark:bg-indigo-950/30 dark:text-indigo-300 dark:border-indigo-800/30 gap-1 py-0.5 px-2 text-[10px] font-medium h-5 select-none cursor-help">
                                <Zap className="h-2.5 w-2.5 text-indigo-500 fill-indigo-500/10" />
                                <span>{t("routes.table.fallback", "降级")}: {providerName}</span>
                                <span className="scale-90 text-[8px] bg-indigo-200/50 text-indigo-800 px-0.5 rounded font-normal">{t("routes.strategy.strategyMode", "策略路由")}</span>
                              </Badge>
                            );
                          }

                          return (
                            <Badge key={idx} variant="secondary" className="bg-indigo-50 text-indigo-700 border border-indigo-200/60 dark:bg-indigo-950/30 dark:text-indigo-300 dark:border-indigo-800/30 gap-1 py-0.5 px-2 text-[10px] font-medium h-5 select-none cursor-help">
                              <Zap className="h-2.5 w-2.5 text-indigo-500 fill-indigo-500/10" />
                              <span>{t("routes.table.fallback", "降级")}: {modelId}</span>
                              {matchTarget && <span className="scale-90 text-[8px] bg-indigo-200/50 text-indigo-800 px-0.5 rounded font-normal">Auto</span>}
                            </Badge>
                          );
                        });
                      })()}'''

code = re.sub(badge_section_old, new_badge_section, code, flags=re.DOTALL)

with open("apps/web/src/components/Routes/RouteList.tsx", "w") as f:
    f.write(code)

