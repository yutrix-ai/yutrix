import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CalendarDays } from "lucide-react";
import { RouteItem, Provider } from "./types";

interface ScheduleListProps {
  activeRoute: RouteItem | null;
  providers: Provider[];
  dailyStartStr: string;
  onEditSchedule: (schedule: any) => void;
  onDeleteSchedule: (scheduleId: string) => void;
}

export function ScheduleList({
  activeRoute,
  providers,
  dailyStartStr,
  onEditSchedule,
  onDeleteSchedule,
}: ScheduleListProps) {
  const { t } = useTranslation();

  const getDaysSummaryText = (days: number[]) => {
    if (!days || days.length === 0) return "";
    if (days.length === 7) return "每天";
    const sorted = [...days].sort((a, b) => {
      const valA = a === 0 ? 7 : a;
      const valB = b === 0 ? 7 : b;
      return valA - valB;
    });

    const isWeekdays = sorted.length === 5 && [1, 2, 3, 4, 5].every(d => sorted.includes(d));
    if (isWeekdays) return "周一至周五";

    const isWeekends = sorted.length === 2 && [6, 0].every(d => sorted.includes(d));
    if (isWeekends) return "周六、周日";

    const mapDay = (d: number) => {
      switch (d) {
        case 1: return "周一";
        case 2: return "周二";
        case 3: return "周三";
        case 4: return "周四";
        case 5: return "周五";
        case 6: return "周六";
        case 0: return "周日";
        default: return "";
      }
    };
    return sorted.map(mapDay).join("、");
  };

  const getTimeSummaryText = (item: any) => {
    const isAllDay = !!item.useDailyStartAsEnd && (item.startTime === dailyStartStr || !item.startTime);
    if (isAllDay) {
      return t("routes.schedule.allDay", "全天");
    }
    if (item.useDailyStartAsEnd) {
      return `${item.startTime} - ${t("routes.schedule.dailyStartTimeLabel", "次日起始时间")}`;
    }
    return `${item.startTime} - ${item.endNextDay ? `${t("routes.schedule.endNextDay", "次日")} ` : ""}${item.endTime}`;
  };

  if (!activeRoute?.schedules || activeRoute.schedules.length === 0) {
    return (
      <div className="text-center py-8 border border-dashed rounded-lg border-zinc-200 dark:border-zinc-800 flex flex-col items-center justify-center">
        <CalendarDays className="h-10 w-10 text-muted-foreground/60 mb-2" />
        <p className="text-sm text-muted-foreground">{t("routes.schedule.emptyText", "暂无路由计划任务，默认配置将全天生效。")}</p>
      </div>
    );
  }

  return (
    <div className="grid gap-3">
      {activeRoute.schedules.map((item: any) => (
        <Card key={item.id} className="border border-zinc-200 dark:border-zinc-800 shadow-sm hover:border-zinc-300 dark:hover:border-zinc-700 transition-all">
          <CardContent className="p-4 flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
            <div className="space-y-1">
              <div className="font-semibold text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
                <span>{item.name}</span>
                <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4.5 text-violet-700 bg-violet-50 dark:bg-violet-950/20 dark:text-violet-400 border-violet-200/50">
                  {getDaysSummaryText(item.daysOfWeek)} {getTimeSummaryText(item)}
                </Badge>
              </div>
              <div className="text-xs text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 pt-1">
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
            <div className="flex gap-2 self-end md:self-center">
              <Button variant="outline" size="sm" onClick={() => onEditSchedule(item)}>
                {t("common.edit", "编辑")}
              </Button>
              <Button variant="ghost" size="sm" className="text-destructive hover:bg-destructive/5" onClick={() => onDeleteSchedule(item.id)}>
                {t("common.delete", "删除")}
              </Button>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
