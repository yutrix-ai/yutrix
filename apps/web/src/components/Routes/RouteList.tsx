import React from 'react';
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Edit2, Trash2, CalendarRange, Route as RouteIcon, Clock, SlidersHorizontal, Zap, Copy } from "lucide-react";
import { useTranslation } from "react-i18next";
import { EmptyState } from "@/components/EmptyState";
import { Skeleton } from "@/components/ui/skeleton";
import { STRATEGY_TASKS } from "./strategyRoutingConfig";

function getStrategyModelsText(route: any) {
  if (!route.strategyRoutingRules) return "";
  let rules = route.strategyRoutingRules;
  if (typeof rules === "string") {
    try {
      rules = JSON.parse(rules);
    } catch {
      return "";
    }
  }
  if (!Array.isArray(rules)) return "";
  const activeRules = rules.filter((rule: any) => rule.enabled !== false);
  const uniqueModels = Array.from(new Set(activeRules.map((rule: any) => rule.modelId).filter(Boolean))) as string[];
  if (uniqueModels.length === 0) return "";
  return uniqueModels.join(" / ");
}

function renderStrategyBadges(rules: any, allModels: any[], t: any) {
  if (!rules) return null;
  let parsedRules = rules;
  if (typeof rules === "string") {
    try {
      parsedRules = JSON.parse(rules);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(parsedRules)) return null;

  const visibleRules = STRATEGY_TASKS.map((task) => {
    const rule = parsedRules.find((item: any) => item.taskType === task.type);
    if (!rule || rule.enabled === false) return null;
    const model = allModels.find((item: any) => item.providerId === rule.providerId && item.modelId === rule.modelId);
    const modelName = model?.alias || model?.displayName || rule.modelId || "";
    return {
      task,
      modelName,
    };
  }).filter(Boolean);

  if (visibleRules.length === 0) return null;

  return (
    <>
      {visibleRules.map((item: any) => (
        <Badge
          key={item.task.type}
          variant="secondary"
          className="bg-emerald-50/60 text-emerald-700 border border-emerald-200/50 dark:bg-emerald-950/20 dark:text-emerald-300 dark:border-emerald-800/30 gap-1 py-0.5 px-2 text-[10px] font-medium h-5 select-none"
        >
          <span>{t(item.task.labelKey, item.task.fallbackLabel)}</span>
          <span className="text-emerald-500/70 dark:text-emerald-300/60">→</span>
          <span className="max-w-[120px] truncate" title={item.modelName}>{item.modelName}</span>
        </Badge>
      ))}
    </>
  );
}

export function RouteList({ 
  routes, providers, allModels = [], getReadinessBadge, toggleEnable, 
  openEdit, openCopy, openScheduleDialog, setDeleteConfirm, openCreate, loading = false
}: any) {
  const { t } = useTranslation();

  return (
    <Card>
      <CardContent className={loading ? "p-6" : "p-0"}>
        {loading ? (
          <div className="space-y-3">
            {[...Array(5)].map((_, i) => (
              <Skeleton key={i} className="h-14 w-full" />
            ))}
          </div>
        ) : routes.length === 0 ? (
          <EmptyState
            icon={<RouteIcon className="h-12 w-12" />}
            title={t("routes.empty.title", "暂无路由")}
            description={t("routes.empty.desc", "创建一条路由规则，将外部请求转发到供应商。")}
            action={{ label: t("routes.actions.create", "新建路由"), onClick: openCreate }}
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("routes.table.status", "状态")}</TableHead>
                <TableHead>{t("routes.table.name", "名称")}</TableHead>
                <TableHead>{t("routes.table.protocol", "协议")}</TableHead>
                <TableHead>{t("routes.table.trigger", "触发条件 (Host + Path)")}</TableHead>
                <TableHead>{t("routes.table.targetAndRouting", "目标与路由配置")}</TableHead>
                <TableHead>{t("routes.table.enable", "启用")}</TableHead>
                <TableHead className="text-right">{t("routes.table.actions", "操作")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {routes.map((r: any) => (
                <TableRow key={r.id}>
                  <TableCell>
                    {(() => {
                      const badge = getReadinessBadge(r.readiness, r.errorMessage);
                      return (
                        <Badge variant={badge.variant as any} title={r.errorMessage || badge.label}>
                          {badge.label}
                        </Badge>
                      );
                    })()}
                  </TableCell>
                  <TableCell className="font-medium">{r.name}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className="text-zinc-500">{r.incomingProtocol === 'openai' ? 'OpenAI' : 'Anthropic'}</Badge>
                  </TableCell>
                  <TableCell>
                    <div className="text-sm">{r.host}</div>
                    <div className="text-xs text-muted-foreground">{r.path}</div>
                  </TableCell>
                  <TableCell>
                    {/* Primary Target Info */}
                    {r.activeSchedule ? (
                      <div>
                        <div className="flex items-center gap-1.5 text-sm font-semibold text-violet-600 dark:text-violet-400">
                          <Clock className="h-3.5 w-3.5 animate-pulse text-violet-500" />
                          <span>{providers.find((p: any) => p.id === r.activeSchedule.providerId)?.name || t("routes.table.unknownProvider", "未知")}</span>
                          <Badge variant="secondary" className="bg-violet-100 text-violet-800 dark:bg-violet-900/30 dark:text-violet-300 text-[10px] px-1 py-0 h-4 font-normal scale-90 origin-left">
                            {t("routes.schedule.activeIndicator", "计划中")}
                          </Badge>
                        </div>
                        <div 
                          className="text-xs font-medium text-violet-500/80 dark:text-violet-400/80 mt-0.5 max-w-[240px] truncate cursor-help"
                          title={r.activeSchedule.modelId}
                        >
                          {r.activeSchedule.modelId}
                        </div>
                        <div 
                          className="text-[10px] text-muted-foreground line-through mt-1 max-w-[240px] truncate cursor-help flex items-center gap-1"
                          title={`${t("routes.schedule.defaultLabel", "默认")}: ${r.providerName}${r.strategyRoutingEnabled ? '' : ` / ${r.modelName}`}`}
                        >
                          <span>{t("routes.schedule.defaultLabel", "默认")}: {r.providerName} {!r.strategyRoutingEnabled && `/ ${r.modelName}`}</span>
                        </div>
                      </div>
                    ) : (
                      <div>
                        {(() => {
                          let isStrategy = r.strategyRoutingEnabled;
                          let strategyRules = r.strategyRoutingRules;
                          let providerName = r.providerName;
                          let modelName = r.modelName;

                          const activeSched = r.activeSchedule;
                          const targetsSource = activeSched?.targets || r.targets;
                          if (targetsSource) {
                            try {
                              const parsedTargets = typeof targetsSource === 'string' ? JSON.parse(targetsSource) : targetsSource;
                              if (Array.isArray(parsedTargets) && parsedTargets.length > 0) {
                                const firstTarget = parsedTargets[0];
                                isStrategy = firstTarget.strategyRoutingEnabled;
                                strategyRules = firstTarget.strategyRoutingRules;
                                const firstRule = firstTarget.strategyRoutingRules?.find((rule: any) => rule.taskType === "general") || firstTarget.strategyRoutingRules?.[0];
                                if (firstRule) {
                                  const prov = providers.find((p: any) => p.id === firstRule.providerId);
                                  providerName = prov?.name || firstRule.providerId;
                                  const model = allModels.find((m: any) => m.providerId === firstRule.providerId && m.modelId === firstRule.modelId);
                                  modelName = model?.alias || model?.displayName || firstRule.modelId;
                                }
                              }
                            } catch (e) {}
                          }

                          if (isStrategy) {
                            return (
                              <div className="flex flex-wrap gap-1.5 mt-2 max-w-xl">
                                {renderStrategyBadges(strategyRules, allModels, t)}
                              </div>
                            );
                          }

                          return (
                            <div className="flex items-center gap-1.5 mt-1 animate-in fade-in duration-300">
                              <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 flex items-center gap-1">
                                {providerName}
                              </div>
                              {modelName && (
                                <div
                                  className="text-xs text-muted-foreground mt-0.5 max-w-[240px] truncate cursor-help animate-in fade-in duration-300"
                                  title={modelName}
                                >
                                  {modelName}
                                </div>
                              )}
                            </div>
                          );
                        })()}
                      </div>
                    )}

                    {/* Routing features badges */}
                    <div className="flex flex-wrap gap-1.5 mt-2 max-w-xl">
                      {(() => {
                        let targetsList = [];
                        const activeSched = r.activeSchedule;
                        if (activeSched && activeSched.targets) {
                          targetsList = typeof activeSched.targets === 'string' ? JSON.parse(activeSched.targets) : activeSched.targets;
                        } else if (r.targets) {
                          targetsList = typeof r.targets === 'string' ? JSON.parse(r.targets) : r.targets;
                        } else {
                          const fallbackEnabled = activeSched ? activeSched.fallbackEnabled : r.fallbackEnabled;
                          if (fallbackEnabled) {
                            targetsList.push({ isOldFallback: true });
                          }
                        }
                        
                        if (targetsList.length <= 1 && !targetsList[0]?.isOldFallback) return null;
                        
                        return targetsList.map((target: any, idx: number) => {
                          if (idx === 0 && !target.isOldFallback) return null; // skip primary
                          
                          let summary = t("routes.table.unknownProvider", "未知");
                          let matchTarget = false;
                          
                          if (target.isOldFallback) {
                            const fallbackProviderId = activeSched ? activeSched.fallbackProviderId : r.fallbackProviderId;
                            const modelId = activeSched ? activeSched.fallbackModelId : r.fallbackModelId;
                            matchTarget = activeSched ? activeSched.fallbackMatchTarget : r.fallbackMatchTarget;
                            const providerName = providers.find((p: any) => p.id === fallbackProviderId)?.name || t("routes.table.unknownProvider", "未知");
                            summary = `${providerName} (${modelId})`;
                          } else {
                            if (target.strategyRoutingEnabled) {
                              const rules = target.strategyRoutingRules || [];
                              const uniqueModels = Array.from(new Set(rules.map((rule: any) => {
                                if (rule.enabled === false || !rule.modelId) return null;
                                const model = allModels.find((m: any) => m.providerId === rule.providerId && m.modelId === rule.modelId);
                                return model?.alias || model?.displayName || rule.modelId;
                              }).filter(Boolean))) as string[];
                              summary = uniqueModels.join(" / ");
                            } else {
                              const providerName = providers.find((p: any) => p.id === target.providerId)?.name || t("routes.table.unknownProvider", "未知");
                              summary = `${providerName} (${target.modelId})`;
                            }
                            matchTarget = target.bestEffort;
                          }
                          
                          return (
                            <Badge key={idx} variant="secondary" className="bg-indigo-50 text-indigo-700 border border-indigo-200/60 dark:bg-indigo-950/30 dark:text-indigo-300 dark:border-indigo-800/30 gap-1 py-0.5 px-2 text-[10px] font-medium h-5 select-none cursor-help">
                              <Zap className="h-2.5 w-2.5 text-indigo-500 fill-indigo-500/10" />
                              <span>{t("routes.table.fallback", "降级")} #{idx}: {summary}</span>
                              {(matchTarget || r.fallbackMatchTarget) && <span className="scale-90 text-[8px] bg-indigo-200/50 text-indigo-800 px-0.5 rounded font-normal">Auto</span>}
                            </Badge>
                          );
                        });
                      })()}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Switch checked={r.enabled} onCheckedChange={(checked) => toggleEnable(r.id, checked)} />
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        className={r.schedules && r.schedules.length > 0 ? "text-violet-600 hover:text-violet-700 hover:bg-violet-50 dark:text-violet-400 dark:hover:text-violet-300 dark:hover:bg-violet-950/50 relative" : "text-muted-foreground"}
                        onClick={() => openScheduleDialog(r)}
                        title={t("routes.schedule.title", "计划任务")}
                      >
                        <CalendarRange className="h-4 w-4" />
                        {r.schedules && r.schedules.length > 0 && (
                          <span className="absolute -top-1 -right-1 w-4 h-4 bg-violet-600 text-white rounded-full text-[9px] flex items-center justify-center font-bold">
                            {r.schedules.length}
                          </span>
                        )}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-muted-foreground"
                        onClick={() => openCopy(r)}
                        title={t("routes.actions.copy", "复制")}
                        aria-label={t("routes.actions.copy", "复制")}
                      >
                        <Copy className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => openEdit(r)}>
                        <Edit2 className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="sm" className="text-destructive" onClick={() => setDeleteConfirm({ open: true, id: r.id, name: r.name })}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
