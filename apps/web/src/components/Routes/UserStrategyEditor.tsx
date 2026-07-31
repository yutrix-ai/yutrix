import React from "react";
import { useTranslation } from "react-i18next";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { HelpCircle } from "lucide-react";
import { STRATEGY_TASKS } from "./strategyRoutingConfig";
import { ProviderModel, StrategyRoutingRule, StrategyTaskType } from "./types";

interface UserStrategyEditorProps {
  rules: StrategyRoutingRule[];
  onChange: (rules: StrategyRoutingRule[]) => void;
  models: ProviderModel[];
  providerId: string;
  providerProtocol: "openai" | "anthropic";
}

export function UserStrategyEditor({
  rules,
  onChange,
  models,
  providerId,
  providerProtocol,
}: UserStrategyEditorProps) {
  const { t } = useTranslation();

  const handleModelChange = (taskType: StrategyTaskType, modelId: string) => {
    const newRules = [...rules];
    const existingIndex = newRules.findIndex(r => r.taskType === taskType);
    
    if (existingIndex >= 0) {
      newRules[existingIndex] = { ...newRules[existingIndex], modelId };
    } else {
      newRules.push({
        taskType,
        providerId,
        providerProtocol,
        modelId,
        enabled: true,
      });
    }
    onChange(newRules);
  };

  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-4">
      {STRATEGY_TASKS.map((task) => {
        const rule = rules.find((r) => r.taskType === task.type);
        const currentModelId = rule?.modelId || "";

        return (
          <div key={task.type} className="flex flex-col gap-1.5">
            <Label className="text-xs text-muted-foreground flex items-center justify-between gap-1">
              <span className="inline-flex items-center gap-1">
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
              {task.type === "general" && (
                <span className="text-[10px] text-muted-foreground/60">
                  {t("routes.strategy.generalFallback", "兜底")}
                </span>
              )}
            </Label>
            <Select
              value={currentModelId}
              onValueChange={(val) => handleModelChange(task.type, val)}
            >
              <SelectTrigger className="h-8 text-sm">
                <SelectValue placeholder={t("routes.strategy.selectModel", "选择模型")} />
              </SelectTrigger>
              <SelectContent>
                {models.map((m) => (
                  <SelectItem key={m.modelId} value={m.modelId}>
                    {m.displayName || m.modelId}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        );
      })}
    </div>
  );
}
