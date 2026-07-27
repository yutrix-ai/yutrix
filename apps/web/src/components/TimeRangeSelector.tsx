import { useState } from "react";
import { useTimeRange, TimeRange } from "@/contexts/TimeRangeContext";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { useTranslation } from "react-i18next";
import { Calendar } from "lucide-react";
import { cn } from "@/lib/utils";
import { CustomTimeRangeDialog } from "./CustomTimeRangeDialog";
import { useSettings } from "@/contexts/SettingsContext";

const ranges: TimeRange[] = ["day", "week", "month", "year", "all"];

const getFallback = (range: TimeRange) => {
  switch (range) {
    case "day": return "本日";
    case "week": return "本周";
    case "month": return "本月";
    case "year": return "本年";
    case "all": return "全部";
    case "custom": return "自定义";
  }
};

export function TimeRangeSelector() {
  const { timeRange, setTimeRange, customStart, customEnd, setCustomRange } = useTimeRange();
  const { t } = useTranslation();
  const { formatShortDateTime } = useSettings();
  const [dialogOpen, setDialogOpen] = useState(false);

  const formatCustomLabel = () => {
    if (!customStart || !customEnd) return t("timeRange.custom.title", "自定义范围");
    return `${formatShortDateTime(customStart)} - ${formatShortDateTime(customEnd)}`;
  };

  const handleApplyCustom = (start: Date, end: Date) => {
    setCustomRange(start, end);
    setTimeRange("custom");
  };

  return (
    <div className="flex items-center" title={t("timeRange.tooltip", "全局数据统计周期")}>
      <Select value={timeRange} onValueChange={(v) => setTimeRange(v as TimeRange)}>
        <SelectTrigger
          className={cn(
            timeRange === "custom" ? "w-[240px] sm:w-[285px]" : "w-[130px] sm:w-[155px]",
            "h-9 rounded-full px-3.5",
            "border-border/40 bg-accent/40 hover:bg-accent/60 text-foreground font-medium",
            "backdrop-blur-md shadow-sm transition-all duration-200 outline-none select-none",
            "focus:ring-1 focus:ring-primary/40 focus:border-primary/40"
          )}
        >
          <div className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors min-w-0">
            <Calendar className="h-4 w-4 shrink-0 text-muted-foreground/80" />
            <span className="truncate text-sm font-medium">
              {timeRange === "custom" ? formatCustomLabel() : t(`timeRange.${timeRange}`, getFallback(timeRange))}
            </span>
          </div>
        </SelectTrigger>
        <SelectContent align="end" className="rounded-xl border-border/40 bg-popover/90 backdrop-blur-md shadow-md min-w-[120px] p-1">
          {ranges.map((range) => (
            <SelectItem
              key={range}
              value={range}
              className={cn(
                "rounded-lg cursor-pointer text-sm py-1.5 px-2.5 my-0.5",
                "transition-colors duration-150 focus:bg-accent focus:text-accent-foreground"
              )}
            >
              {t(`timeRange.${range}`, getFallback(range))}
            </SelectItem>
          ))}
          {timeRange === "custom" && (
            <SelectItem value="custom" className="hidden">
              {formatCustomLabel()}
            </SelectItem>
          )}
          <div className="my-1 border-t border-border/20" />
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setDialogOpen(true);
            }}
            className="w-full text-left rounded-lg cursor-pointer text-xs font-semibold py-1.5 px-2.5 my-0.5 transition-colors duration-150 hover:bg-accent hover:text-accent-foreground flex items-center gap-1.5 text-zinc-700 dark:text-zinc-300"
          >
            <Calendar className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            {t("timeRange.custom.trigger", "自定义范围...")}
          </button>
        </SelectContent>
      </Select>

      <CustomTimeRangeDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        initialStart={customStart}
        initialEnd={customEnd}
        onApply={handleApplyCustom}
      />
    </div>
  );
}
