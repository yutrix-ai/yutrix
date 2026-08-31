import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Network, SlidersHorizontal } from "lucide-react";
import { Provider, ProviderModel, RouteTaskType, StrategyRoutingRule } from "./types";
import {
  STRATEGY_TASKS,
  completeStrategyRules,
  firstModelForProvider,
  providerProtocolForRule,
  selectableModelsForProvider,
} from "./strategyRoutingConfig";

interface StrategyRoutingEditorProps {
  formData: any;
  setFormData: (value: any) => void;
  providers: Provider[];
  allModels: ProviderModel[];
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** When set, locks all rules to this provider (used for fallback strategy routing) */
  lockedProviderId?: string;
}

function modelLabel(model: ProviderModel | undefined) {
  return model?.displayName || model?.modelId || "";
}

export function StrategyRoutingSummary({
  rules,
  providers,
  allModels,
}: {
  rules: StrategyRoutingRule[];
  providers: Provider[];
  allModels: ProviderModel[];
}) {
  const { t } = useTranslation();
  const visibleRules = STRATEGY_TASKS.map((task) => {
    const rule = rules.find((item) => item.taskType === task.type);
    if (!rule) return null;
    const provider = providers.find((item) => item.id === rule.providerId);
    const model = allModels.find((item) => item.providerId === rule.providerId && item.modelId === rule.modelId);
    return {
      task,
      providerName: provider?.name || rule.providerId,
      modelName: modelLabel(model) || rule.modelId,
    };
  }).filter(Boolean) as Array<{
    task: typeof STRATEGY_TASKS[number];
    providerName: string;
    modelName: string;
  }>;

  return (
    <div className="flex flex-wrap gap-1.5">
      {visibleRules.map((item) => (
        <Badge key={item.task.type} variant="secondary" className="h-6 gap-1 rounded-md bg-emerald-50 text-emerald-700 border border-emerald-200/70 dark:bg-emerald-950/25 dark:text-emerald-300 dark:border-emerald-800/40">
          <span>{t(item.task.labelKey, item.task.fallbackLabel)}</span>
          <span className="text-emerald-600/70 dark:text-emerald-300/70">→</span>
          <span className="max-w-40 truncate">{item.modelName}</span>
        </Badge>
      ))}
    </div>
  );
}

export function StrategyRoutingEditor({
  formData,
  setFormData,
  providers,
  allModels,
  open,
  onOpenChange,
  lockedProviderId,
}: StrategyRoutingEditorProps) {
  const { t } = useTranslation();
  const rules = completeStrategyRules({
    rules: formData.strategyRoutingRules,
    providerId: formData.providerId,
    providerProtocol: formData.providerProtocol,
    modelId: formData.modelId,
  });

  const updateRule = (taskType: RouteTaskType, patch: Partial<StrategyRoutingRule>) => {
    const currentRules = completeStrategyRules({
      rules: formData.strategyRoutingRules,
      providerId: formData.providerId,
      providerProtocol: formData.providerProtocol,
      modelId: formData.modelId,
    });
    const nextRules = currentRules.map((rule) => {
      if (rule.taskType !== taskType) return rule;
      return { ...rule, ...patch, enabled: true };
    });
    setFormData({ ...formData, strategyRoutingRules: nextRules });
  };

  if (open === false) return null;

  return (
    <div className="rounded-md border bg-muted/20">
      <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
            <SlidersHorizontal className="h-4 w-4" />
          </div>
          <div>
            <div className="text-sm font-semibold">{t("routes.strategy.editorTitle", "策略路由配置")}</div>
            <div className="text-xs text-muted-foreground">{t("routes.strategy.editorDesc", "本地规则识别任务类型，毫秒级选择目标模型。")}</div>
          </div>
        </div>
        {onOpenChange && (
          <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {t("common.collapse", "收起")}
          </Button>
        )}
      </div>

      <div className="divide-y">
        {STRATEGY_TASKS.map((task) => {
          const rule = rules.find((item) => item.taskType === task.type);
          const effectiveProviderId = lockedProviderId || rule?.providerId || "";
          const providerModels = effectiveProviderId ? selectableModelsForProvider(allModels, effectiveProviderId) : [];
          const lockedProviderName = lockedProviderId ? providers.find(p => p.id === lockedProviderId)?.name : undefined;
          return (
            <div key={task.type} className={`grid gap-3 px-4 py-3 ${lockedProviderId ? 'md:grid-cols-[1.2fr_1fr] md:items-center' : 'md:grid-cols-[1.2fr_1fr_1fr] md:items-center'}`}>
              <div className="space-y-1">
                <Label className="flex items-center gap-2 text-sm font-medium">
                  <Network className="h-3.5 w-3.5 text-emerald-600" />
                  {t(task.labelKey, task.fallbackLabel)}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t(task.descriptionKey, task.fallbackDescription)}
                </p>
              </div>
              {!lockedProviderId && (
              <Select
                value={rule?.providerId || ""}
                onValueChange={(providerId) => {
                  const provider = providers.find((item) => item.id === providerId);
                  const model = firstModelForProvider(allModels, providerId);
                  updateRule(task.type, {
                    providerId,
                    providerProtocol: providerProtocolForRule(formData.incomingProtocol, provider),
                    modelId: model?.modelId || "",
                  });
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t("routes.placeholders.selectProvider", "选择供应商")} />
                </SelectTrigger>
                <SelectContent>
                  {providers.map((provider) => (
                    <SelectItem key={provider.id} value={provider.id}>{provider.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              )}
              <Select
                key={effectiveProviderId}
                value={rule?.modelId || ""}
                onValueChange={(modelId) => {
                  if (lockedProviderId) {
                    const provider = providers.find((item) => item.id === lockedProviderId);
                    updateRule(task.type, {
                      providerId: lockedProviderId,
                      providerProtocol: providerProtocolForRule(formData.incomingProtocol, provider),
                      modelId,
                    });
                  } else {
                    updateRule(task.type, { modelId });
                  }
                }}
                disabled={!effectiveProviderId || providerModels.length === 0}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t("routes.placeholders.selectModel", "选择模型")} />
                </SelectTrigger>
                <SelectContent>
                  {providerModels.map((model) => (
                    <SelectItem key={model.modelId} value={model.modelId}>
                      {model.displayName || model.modelId}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          );
        })}
      </div>
    </div>
  );
}
