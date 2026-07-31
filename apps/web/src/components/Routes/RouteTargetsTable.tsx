import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Trash2, Plus, ArrowUp, ArrowDown, Search, Check, ChevronDown, HelpCircle } from "lucide-react";
import { STRATEGY_TASKS } from "./strategyRoutingConfig";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";

interface RouteTargetsTableProps {
  targets: any[];
  onChange: (targets: any[]) => void;
  providers: any[];
  allModels: any[];
  policies: any[];
  incomingProtocol: string;
  getProviderProtocolForSelection: (protocol: string, provider: any) => string;
}

export function RouteTargetsTable({
  targets,
  onChange,
  providers,
  allModels,
  incomingProtocol,
  getProviderProtocolForSelection
}: RouteTargetsTableProps) {
  const { t } = useTranslation();

  const normalizeTarget = (target: any) => {
    const rules = target.strategyRoutingRules || [];
    const rulesMap = new Map(rules.map((r: any) => [r.taskType, r]));
    
    const normalizedRules = STRATEGY_TASKS.map(task => {
      const existing = rulesMap.get(task.type) as any;
      if (existing) {
        return {
          taskType: task.type,
          providerId: existing.providerId || "",
          providerProtocol: existing.providerProtocol || "openai",
          modelId: existing.modelId || "",
          enabled: existing.enabled !== false
        };
      }
      return {
        taskType: task.type,
        providerId: target.providerId || "",
        providerProtocol: target.providerProtocol || "openai",
        modelId: target.modelId || "",
        enabled: true
      };
    });

    return {
      ...target,
      strategyRoutingEnabled: true,
      strategyRoutingRules: normalizedRules
    };
  };

  const handleAdd = () => {
    const newTarget = {
      providerId: "",
      modelId: "",
      providerProtocol: "openai",
      promptPolicyId: "none",
      bestEffort: false,
      strategyRoutingEnabled: true,
      strategyRoutingRules: STRATEGY_TASKS.map(task => ({
        taskType: task.type,
        providerId: "",
        providerProtocol: "openai",
        modelId: "",
        enabled: true
      }))
    };
    onChange([...targets, newTarget]);
  };

  const handleRemove = (index: number) => {
    const newTargets = [...targets];
    newTargets.splice(index, 1);
    onChange(newTargets);
  };

  const handleCellChange = (
    rowIdx: number, 
    taskType: string, 
    patch: { providerId: string; modelId: string; providerProtocol: string }
  ) => {
    const newTargets = targets.map((t, idx) => {
      if (idx !== rowIdx) return t;
      const normalized = normalizeTarget(t);
      const updatedRules = normalized.strategyRoutingRules.map((rule: any) => {
        if (rule.taskType !== taskType) return rule;
        return {
          ...rule,
          ...patch
        };
      });
      // Synchronize the first available rule to target top level for database backward compatibility
      const firstRule = updatedRules.find((r: any) => r.taskType === "general") || updatedRules[0];
      return {
        ...normalized,
        providerId: firstRule.providerId,
        providerProtocol: firstRule.providerProtocol,
        modelId: firstRule.modelId,
        strategyRoutingRules: updatedRules
      };
    });
    onChange(newTargets);
  };

  const moveTarget = (index: number, dir: number) => {
    if (index + dir < 0 || index + dir >= targets.length) return;
    const newTargets = [...targets];
    const temp = newTargets[index];
    newTargets[index] = newTargets[index + dir];
    newTargets[index + dir] = temp;
    onChange(newTargets);
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <div className="space-y-0.5">
          <h3 className="text-sm font-medium text-zinc-950 dark:text-zinc-50">
            {t("routes.sections.routingTarget", "请求路由转发目标 (漏斗模型)")}
          </h3>
          <p className="text-xs text-muted-foreground/90">
            {t("routes.targets.description", "根据漏斗顺序逐级转发请求，每一行可为各类任务配置特定的执行目标。")}
          </p>
        </div>
        <Button 
          type="button" 
          variant="outline" 
          size="sm" 
          onClick={handleAdd}
          className="border-zinc-200 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900 h-8 text-xs gap-1.5 font-medium shadow-xs"
        >
          <Plus className="w-3.5 h-3.5" />
          {t("routes.actions.addTarget", "添加目标层")}
        </Button>
      </div>

      <div className="border border-zinc-200/80 dark:border-zinc-800 rounded-lg overflow-hidden bg-background shadow-xs">
        <Table className="min-w-full border-collapse">
          <TableHeader className="bg-zinc-50/50 dark:bg-zinc-900/10 border-b border-zinc-200/50 dark:border-zinc-800/50">
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-20 text-center font-medium text-xs text-muted-foreground uppercase tracking-wider">{t("routes.targets.priority", "优先级")}</TableHead>
              {STRATEGY_TASKS.map(task => (
                <TableHead key={task.type} className="min-w-[155px] py-3.5 px-2">
                  <div className="flex flex-col space-y-0.5">
                    <span className="font-semibold text-xs text-zinc-900 dark:text-zinc-50 inline-flex items-center gap-1">
                      {t(task.labelKey, task.fallbackLabel)}
                      {task.helpKey && (
                        <span
                          className="inline-flex items-center cursor-help select-none"
                          title={t(task.helpKey, task.fallbackHelp || "")}
                        >
                          <HelpCircle className="h-3 w-3 text-muted-foreground/70 hover:text-violet-500 transition-colors" />
                        </span>
                      )}
                    </span>
                    <span className="text-[11px] text-muted-foreground/80 leading-normal font-normal">
                      {t(task.descriptionKey, task.fallbackDescription)}
                    </span>
                  </div>
                </TableHead>
              ))}
              <TableHead className="w-24 text-center font-medium text-xs text-muted-foreground uppercase tracking-wider">{t("routes.targets.actions", "操作")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {targets.map((target, idx) => {
              const normalized = normalizeTarget(target);
              return (
                <TableRow key={idx} className="hover:bg-zinc-50/10 dark:hover:bg-zinc-900/5 border-b border-zinc-100 dark:border-zinc-800/30">
                  <TableCell className="text-center py-4">
                    <span className="inline-flex items-center justify-center px-2 py-0.5 rounded-full text-xs font-semibold text-violet-700 dark:text-violet-400 bg-violet-50/80 dark:bg-violet-950/20 border border-violet-100 dark:border-violet-900/30 select-none shadow-xs">
                      L{idx + 1}
                    </span>
                  </TableCell>
                  {STRATEGY_TASKS.map(task => {
                    const rule = normalized.strategyRoutingRules.find((r: any) => r.taskType === task.type) || {
                      providerId: "",
                      modelId: ""
                    };
                    return (
                      <TableCell key={task.type} className="p-1.5 align-middle">
                        <TargetCellPopover
                          providerId={rule.providerId}
                          modelId={rule.modelId}
                          providers={providers}
                          allModels={allModels}
                          onChange={(patch) => handleCellChange(idx, task.type, patch)}
                        />
                      </TableCell>
                    );
                  })}
                  <TableCell className="p-2 align-middle">
                    <div className="flex items-center justify-center gap-0.5">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-zinc-500 hover:text-zinc-950 hover:bg-zinc-100 dark:hover:bg-zinc-900 rounded-md"
                        onClick={() => moveTarget(idx, -1)}
                        disabled={idx === 0}
                      >
                        <ArrowUp className="w-3.5 h-3.5" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-zinc-500 hover:text-zinc-950 hover:bg-zinc-100 dark:hover:bg-zinc-900 rounded-md"
                        onClick={() => moveTarget(idx, 1)}
                        disabled={idx === targets.length - 1}
                      >
                        <ArrowDown className="w-3.5 h-3.5" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-destructive hover:bg-destructive/5 hover:text-destructive rounded-md"
                        onClick={() => handleRemove(idx)}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>

        {targets.length === 0 && (
          <div className="p-12 text-center text-muted-foreground bg-zinc-50/5 flex flex-col items-center justify-center">
            <div className="w-10 h-10 rounded-full bg-zinc-100 dark:bg-zinc-900 flex items-center justify-center text-zinc-400 mb-3 border border-zinc-200/50 dark:border-zinc-800">
              <Plus className="w-5 h-5" />
            </div>
            <p className="text-sm font-medium text-zinc-950 dark:text-zinc-50 mb-1">{t("routes.targets.emptyTitle", "暂无路由目标")}</p>
            <p className="text-xs text-muted-foreground max-w-[280px]">{t("routes.targets.emptyDescription", "点击右上角 \"添加目标层\" 开始构建多级漏斗转发目标规则。")}</p>
          </div>
        )}
      </div>
    </div>
  );
}

interface TargetCellPopoverProps {
  providerId: string;
  modelId: string;
  providers: any[];
  allModels: any[];
  onChange: (patch: { providerId: string; modelId: string; providerProtocol: string }) => void;
}

function TargetCellPopover({
  providerId,
  modelId,
  providers,
  allModels,
  onChange
}: TargetCellPopoverProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const activeProvider = providers.find(p => p.id === providerId);
  const activeModel = allModels.find(m => m.providerId === providerId && m.modelId === modelId);

  // Grouped and filtered list of models
  const groupedList = providers.map(p => {
    const models = allModels.filter(m => 
      m.providerId === p.id && 
      m.enabled !== false &&
      (
        p.name.toLowerCase().includes(search.toLowerCase()) ||
        m.modelId.toLowerCase().includes(search.toLowerCase()) ||
        (m.alias || "").toLowerCase().includes(search.toLowerCase()) ||
        (m.displayName || "").toLowerCase().includes(search.toLowerCase())
      )
    );
    return {
      provider: p,
      models
    };
  }).filter(group => group.models.length > 0);

  const handleSelect = (pId: string, mId: string) => {
    const prov = providers.find(p => p.id === pId);
    const resolvedProto = prov ? (prov.openaiBaseUrl ? "openai" : "anthropic") : "openai";
    onChange({
      providerId: pId,
      modelId: mId,
      providerProtocol: resolvedProto
    });
    setOpen(false);
  };

  const handleClear = () => {
    onChange({
      providerId: "",
      modelId: "",
      providerProtocol: "openai"
    });
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            className={`w-full text-left px-3 py-1.5 rounded-lg border transition-all duration-200 outline-hidden flex items-center justify-between group h-12 shadow-xs cursor-pointer ${
              providerId && modelId
                ? "bg-zinc-50/50 hover:bg-zinc-50 border-zinc-200 hover:border-violet-500/50 dark:bg-zinc-900/10 dark:border-zinc-800 dark:hover:border-violet-500/50"
                : "bg-dashed border-zinc-200 hover:border-zinc-300 text-muted-foreground/70 hover:text-zinc-900 dark:border-zinc-800 dark:hover:border-zinc-700 dark:hover:text-zinc-50 hover:bg-zinc-50/50 dark:hover:bg-zinc-900/30"
            }`}
          >
            <div className="flex flex-col min-w-0 pr-1 select-none">
              {providerId && modelId ? (
                <>
                  <span className="text-xs font-medium text-zinc-900 dark:text-zinc-100 truncate">
                    {activeProvider?.name || providerId}
                  </span>
                  <span className="text-[11px] text-muted-foreground/80 font-normal truncate mt-0.5">
                    {activeModel?.alias || activeModel?.displayName || modelId}
                  </span>
                </>
              ) : (
                <span className="text-xs font-normal text-muted-foreground/60 flex items-center gap-1.5 pl-0.5">
                  <Plus className="w-3.5 h-3.5 opacity-60" />
                  {t("routes.targets.configureTarget", "配置目标")}
                </span>
              )}
            </div>
            <ChevronDown className="w-3.5 h-3.5 shrink-0 opacity-40 group-hover:opacity-85 transition-opacity ml-1" />
          </button>
        }
      />
      
      <PopoverContent className="w-80 p-0 overflow-hidden border border-zinc-200 dark:border-zinc-800 shadow-xl bg-popover rounded-xl" align="start">
        <div className="p-2 border-b border-zinc-100 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-900/30 flex items-center gap-1.5">
          <Search className="w-4 h-4 text-zinc-400 ml-1.5 shrink-0" />
          <Input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={t("routes.targets.searchPlaceholder", "搜索供应商或模型名称...")}
            className="h-8 border-none bg-transparent shadow-none focus-visible:ring-0 text-xs px-1"
          />
        </div>

        <div className="max-h-60 overflow-y-auto p-1.5 space-y-2">
          {groupedList.map(group => (
            <div key={group.provider.id} className="space-y-1">
              <div className="text-[10px] font-semibold text-zinc-400 dark:text-zinc-500 uppercase tracking-wider px-2 py-1">
                {group.provider.name}
              </div>
              {group.models.map(m => {
                const isSelected = providerId === group.provider.id && modelId === m.modelId;
                return (
                  <button
                    key={m.modelId}
                    type="button"
                    onClick={() => handleSelect(group.provider.id, m.modelId)}
                    className={`w-full text-left px-2.5 py-1.5 rounded-lg text-xs flex items-center justify-between transition-colors duration-150 cursor-pointer ${
                      isSelected
                        ? "bg-violet-50 text-violet-800 dark:bg-violet-950/30 dark:text-violet-300 font-semibold"
                        : "hover:bg-zinc-50 dark:hover:bg-zinc-900 text-zinc-700 dark:text-zinc-300"
                    }`}
                  >
                    <div className="flex flex-col min-w-0 pr-2">
                      <span className="truncate">{m.alias || m.displayName || m.modelId}</span>
                      <span className="text-[10px] text-muted-foreground font-normal truncate mt-0.5">{m.modelId}</span>
                    </div>
                    {isSelected && <Check className="w-3.5 h-3.5 text-violet-600 dark:text-violet-400 shrink-0" />}
                  </button>
                );
              })}
            </div>
          ))}

          {groupedList.length === 0 && (
            <div className="text-center py-6 text-xs text-muted-foreground">
              {t("routes.targets.noResults", "未找到匹配的供应商或模型")}
            </div>
          )}
        </div>

        {(providerId || modelId) && (
          <div className="border-t border-zinc-100 dark:border-zinc-800 p-1.5 bg-zinc-50/30 dark:bg-zinc-900/10">
            <button
              type="button"
              onClick={handleClear}
              className="w-full text-center py-1.5 text-xs text-destructive hover:bg-destructive/5 rounded-lg font-medium transition-colors cursor-pointer"
            >
              {t("routes.targets.clearSelection", "清空所选目标")}
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
