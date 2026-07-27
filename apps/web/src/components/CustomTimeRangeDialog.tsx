import React, { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Calendar as CalendarIcon, Clock, AlertCircle, ArrowRight, Check } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { DateTimePicker } from "@/components/ui/datetime-picker";

interface CustomTimeRangeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialStart: Date | null;
  initialEnd: Date | null;
  onApply: (start: Date, end: Date) => void;
}

export function CustomTimeRangeDialog({
  open,
  onOpenChange,
  initialStart,
  initialEnd,
  onApply,
}: CustomTimeRangeDialogProps) {
  const { t } = useTranslation();

  const [start, setStart] = useState<Date | undefined>();
  const [end, setEnd] = useState<Date | undefined>();
  const [errorMsg, setErrorMsg] = useState("");
  const [activePreset, setActivePreset] = useState<string>("");

  useEffect(() => {
    if (open) {
      const now = new Date();
      setStart(initialStart || new Date(now.getTime() - 24 * 60 * 60 * 1000));
      setEnd(initialEnd || now);
      setErrorMsg("");
      setActivePreset("");
    }
  }, [open, initialStart, initialEnd]);

  const isValid = start && end && start.getTime() <= end.getTime();

  useEffect(() => {
    if (start && end && start.getTime() > end.getTime()) {
      setErrorMsg(t("timeRange.custom.errorRange", "开始时间不能晚于结束时间"));
    } else {
      setErrorMsg("");
    }
  }, [start, end, t]);

  const handlePreset = (preset: "today" | "yesterday" | "last24h" | "last3d" | "last7d" | "last30d") => {
    const now = new Date();
    let newStart = new Date();
    let newEnd = new Date();

    switch (preset) {
      case "today":
        newStart.setHours(0, 0, 0, 0);
        newEnd.setHours(23, 59, 59, 999);
        break;
      case "yesterday":
        newStart.setDate(now.getDate() - 1);
        newStart.setHours(0, 0, 0, 0);
        newEnd.setDate(now.getDate() - 1);
        newEnd.setHours(23, 59, 59, 999);
        break;
      case "last24h":
        newStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        break;
      case "last3d":
        newStart = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
        break;
      case "last7d":
        newStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        break;
      case "last30d":
        newStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        break;
    }

    setStart(newStart);
    setEnd(newEnd);
    setActivePreset(preset);
  };

  const getDurationText = (): string => {
    if (!start || !end || start.getTime() > end.getTime()) return "";
    const diffMs = end.getTime() - start.getTime();
    const diffSecs = Math.floor(diffMs / 1000);
    const days = Math.floor(diffSecs / (24 * 3600));
    const hours = Math.floor((diffSecs % (24 * 3600)) / 3600);
    const minutes = Math.floor((diffSecs % 3600) / 60);
    const seconds = diffSecs % 60;

    const parts = [];
    if (days > 0) parts.push(`${days} ${t("timeRange.duration.days", "天")}`);
    if (hours > 0) parts.push(`${hours} ${t("timeRange.duration.hours", "小时")}`);
    if (minutes > 0) parts.push(`${minutes} ${t("timeRange.duration.minutes", "分钟")}`);
    if (seconds > 0 || parts.length === 0) parts.push(`${seconds} ${t("timeRange.duration.seconds", "秒")}`);

    return `${t("timeRange.duration.selected", "已选周期：")}${parts.join(" ")}`;
  };

  const handleConfirm = () => {
    if (isValid && start && end) {
      onApply(start, end);
      onOpenChange(false);
    }
  };

  const presets = [
    { id: "today", label: t("timeRange.custom.today", "今天全天") },
    { id: "yesterday", label: t("timeRange.custom.yesterday", "昨天全天") },
    { id: "last24h", label: t("timeRange.custom.last24h", "最近24小时") },
    { id: "last3d", label: t("timeRange.custom.last3d", "最近3天") },
    { id: "last7d", label: t("timeRange.custom.last7d", "最近7天") },
    { id: "last30d", label: t("timeRange.custom.last30d", "最近30天") },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg p-0 overflow-hidden rounded-2xl border border-border/30 shadow-2xl bg-background">
        {/* Header */}
        <DialogHeader className="p-5 pb-4 border-b border-border/20">
          <DialogTitle className="text-base font-semibold flex items-center gap-2.5">
            <div className="h-8 w-8 rounded-lg bg-primary/10 flex items-center justify-center">
              <CalendarIcon className="h-4 w-4 text-primary" />
            </div>
            {t("timeRange.custom.title", "自定义时间范围")}
          </DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground mt-1 ml-10.5">
            {t("timeRange.custom.desc", "精确选择需要查询的数据起止时间。")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col">
          {/* Preset Shortcuts - Horizontal Pills */}
          <div className="px-5 pt-4 pb-2">
            <span className="text-xs font-medium text-muted-foreground/70 mb-2.5 block">
              {t("timeRange.custom.presets", "常用范围")}
            </span>
            <div className="flex flex-wrap gap-2">
              {presets.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => handlePreset(preset.id as any)}
                  className={`
                    inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-medium
                    transition-all duration-200 border cursor-pointer
                    ${activePreset === preset.id
                      ? "bg-primary text-primary-foreground border-primary shadow-sm"
                      : "bg-background text-muted-foreground border-border/60 hover:border-primary/30 hover:text-foreground hover:bg-accent/50"
                    }
                  `}
                >
                  {activePreset === preset.id && <Check className="h-3 w-3" />}
                  {preset.label}
                </button>
              ))}
            </div>
          </div>

          {/* Date Picker Form */}
          <div className="px-5 py-4 space-y-4">
            {/* Start Date & Time */}
            <div className="space-y-2">
              <Label className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5">
                <Clock className="h-3.5 w-3.5" />
                {t("timeRange.custom.start", "开始时间")}
              </Label>
              <DateTimePicker
                value={start}
                onChange={setStart}
                className="w-full h-9 rounded-xl border-border/40 text-sm bg-background hover:border-primary/30 transition-colors"
              />
            </div>

            {/* Connected Visual Arrow */}
            <div className="flex justify-center -my-1 select-none">
              <div className="h-6 w-6 rounded-full bg-muted flex items-center justify-center">
                <ArrowRight className="h-3 w-3 text-muted-foreground/60 rotate-90" />
              </div>
            </div>

            {/* End Date & Time */}
            <div className="space-y-2">
              <Label className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5">
                <Clock className="h-3.5 w-3.5" />
                {t("timeRange.custom.end", "结束时间")}
              </Label>
              <DateTimePicker
                value={end}
                onChange={setEnd}
                className="w-full h-9 rounded-xl border-border/40 text-sm bg-background hover:border-primary/30 transition-colors"
              />
            </div>
          </div>

          {/* Helper Info & Validation */}
          <div className="px-5 pb-4">
            {errorMsg ? (
              <div className="flex items-center gap-1.5 text-xs text-destructive font-medium bg-destructive/5 p-2.5 rounded-xl border border-destructive/10">
                <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                <span>{errorMsg}</span>
              </div>
            ) : getDurationText() ? (
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground/80 font-medium bg-muted/30 px-3 py-2 rounded-xl">
                <Clock className="h-3.5 w-3.5 text-muted-foreground/50" />
                <span>{getDurationText()}</span>
              </div>
            ) : null}
          </div>
        </div>

        {/* Footer */}
        <DialogFooter className="p-5 pt-3 border-t border-border/20 flex flex-row items-center justify-end gap-2.5">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="rounded-xl h-9 text-xs font-medium cursor-pointer border-border/50 hover:bg-muted/50"
          >
            {t("common.cancel", "取消")}
          </Button>
          <Button
            type="button"
            onClick={handleConfirm}
            disabled={!isValid}
            className="rounded-xl h-9 text-xs font-medium cursor-pointer bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm"
          >
            {t("common.confirm", "确定")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
