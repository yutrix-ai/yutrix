import { useTranslation } from "react-i18next";
import { HelpCircle, Clock, Route as RouteIcon, Zap } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { TimePicker24h } from "@/components/ui/time-picker-24h";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Provider, Policy, ProviderModel } from "./types";
import { RouteTargetsTable } from "./RouteTargetsTable";

const WEEKDAYS = [
  { label: "一", value: 1 },
  { label: "二", value: 2 },
  { label: "三", value: 3 },
  { label: "四", value: 4 },
  { label: "五", value: 5 },
  { label: "六", value: 6 },
  { label: "日", value: 0 },
];

interface ScheduleFormProps {
  scheduleFormData: any;
  setScheduleFormData: (data: any) => void;
  enableTimeRange: boolean;
  setEnableTimeRange: (val: boolean) => void;
  dailyStartStr: string;
  providers: Provider[];
  policies: Policy[];
  getIncomingProtocol: () => string;
  getProviderProtocolForSelection: (incoming: string, provider: Provider | undefined) => string;
  allModels: ProviderModel[];
}

export function ScheduleForm({
  scheduleFormData,
  setScheduleFormData,
  enableTimeRange,
  setEnableTimeRange,
  dailyStartStr,
  providers,
  policies,
  getIncomingProtocol,
  getProviderProtocolForSelection,
  allModels,
}: ScheduleFormProps) {
  const { t } = useTranslation();

  return (
    <div className="space-y-5">
      <div className="space-y-4 border rounded-lg p-4 bg-zinc-50/50 dark:bg-zinc-900/10">
        <div className="font-medium text-sm text-zinc-700 dark:text-zinc-300 border-b pb-1.5 flex items-center gap-1.5">
          <Clock className="w-4 h-4 text-violet-500" />
          <span>{t("routes.schedule.timeConfig", "执行时间与周期")}</span>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2 md:col-span-2">
            <Label htmlFor="schedule-name">{t("routes.schedule.name", "计划名称")}</Label>
            <Input
              id="schedule-name"
              value={scheduleFormData.name}
              onChange={e => setScheduleFormData({ ...scheduleFormData, name: e.target.value })}
              placeholder={t("routes.schedule.namePlaceholder", "例如：工作日晚间降级")}
            />
          </div>

          <div className="space-y-2 md:col-span-2">
            <Label>{t("routes.schedule.daysOfWeek", "执行周期 (星期)")}</Label>
            <div className="flex flex-wrap gap-2 mt-1">
              {WEEKDAYS.map(d => {
                const active = scheduleFormData.daysOfWeek.includes(d.value);
                return (
                  <button
                    key={d.value}
                    type="button"
                    onClick={() => {
                      if (active) {
                        setScheduleFormData({
                          ...scheduleFormData,
                          daysOfWeek: scheduleFormData.daysOfWeek.filter((x: number) => x !== d.value)
                        });
                      } else {
                        setScheduleFormData({
                          ...scheduleFormData,
                          daysOfWeek: [...scheduleFormData.daysOfWeek, d.value]
                        });
                      }
                    }}
                    className={`w-10 h-10 rounded-full border flex items-center justify-center text-sm font-semibold transition-all ${
                      active
                        ? "bg-violet-600 border-violet-600 text-white shadow-sm shadow-violet-500/20"
                        : "bg-background border-input hover:bg-muted text-muted-foreground"
                    }`}
                  >
                    {d.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Switch to enable specific time window */}
          <div className="flex items-center gap-1.5 md:col-span-2 pt-2 pb-1">
            <Switch
              id="schedule-enable-timerange"
              checked={enableTimeRange}
              onCheckedChange={checked => {
                setEnableTimeRange(checked);
                if (!checked) {
                  setScheduleFormData((prev: any) => ({
                    ...prev,
                    useDailyStartAsEnd: true
                  }));
                }
              }}
            />
            <Label htmlFor="schedule-enable-timerange" className="cursor-pointer select-none font-medium text-sm text-zinc-800 dark:text-zinc-200">
              {t("routes.schedule.enableTimeRange", "指定具体时间段")}
            </Label>
            <span
              className="inline-flex items-center ml-0.5 cursor-help select-none"
              title={`${t("routes.schedule.enableTimeRangeDesc", "关闭时默认为选中日期的全天时间段。")}

${t("routes.schedule.helpDesc1", "系统以全局“每日起始时间”（当前设置为 {{time}}）作为一天的分界线。").replace("{{time}}", dailyStartStr)}
• ${t("routes.schedule.helpExample1Title", "全天模式")}: ${t("routes.schedule.helpExample1Desc", "若选择周六周日，时间将从周六 {{time}} 连续执行至下周一 {{time}}。").replace(/\{\{time\}\}/g, dailyStartStr)}
• ${t("routes.schedule.helpExample2Title", "当天时段")}: ${t("routes.schedule.helpExample2Desc", "如开始于 09:00，结束于 18:00，仅在该时间范围内生效。")}
• ${t("routes.schedule.helpExample3Title", "跨子夜时段")}: ${t("routes.schedule.helpExample3Desc", "如开始于 20:00，结束于次日 03:00。自定义结束时间必须小于等于次日每日起始时间 ({{time}})。").replace("{{time}}", dailyStartStr)}`}
            >
              <HelpCircle className="w-4 h-4 text-muted-foreground/80 hover:text-violet-500 transition-colors" />
            </span>
          </div>

          {enableTimeRange && (
            <>
              <div className="space-y-2">
                <Label htmlFor="schedule-start-time" className="text-xs text-muted-foreground">
                  {t("routes.schedule.startTime", "开始时间")}
                </Label>
                <TimePicker24h
                  value={scheduleFormData.startTime}
                  onChange={(val: string) => setScheduleFormData({ ...scheduleFormData, startTime: val })}
                />
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="schedule-end-time" className="text-xs text-muted-foreground">
                    {t("routes.schedule.endTime", "结束时间")}
                  </Label>
                  <div className="flex items-center gap-1.5">
                    <Switch
                      id="schedule-daily-start"
                      checked={scheduleFormData.useDailyStartAsEnd}
                      onCheckedChange={checked => setScheduleFormData({
                        ...scheduleFormData,
                        useDailyStartAsEnd: checked,
                      })}
                    />
                    <Label htmlFor="schedule-daily-start" className="text-[11px] font-normal text-muted-foreground select-none cursor-pointer">
                      {t("routes.schedule.useDailyStartAsEnd", "至次日每日起始时间")}
                    </Label>
                  </div>
                </div>

                {!scheduleFormData.useDailyStartAsEnd && (
                  <div className="flex gap-2 items-center">
                    <TimePicker24h
                      value={scheduleFormData.endTime}
                      onChange={(val: string) => setScheduleFormData({ ...scheduleFormData, endTime: val })}
                    />
                    {scheduleFormData.endTime && scheduleFormData.startTime && scheduleFormData.endTime < scheduleFormData.startTime && (
                      <Badge variant="secondary" className="bg-violet-100 text-violet-800 dark:bg-violet-900/30 dark:text-violet-300 text-[10px] px-1.5 py-1 h-9 shrink-0 select-none">
                        {t("routes.schedule.endNextDay", "次日")}
                      </Badge>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      <div className="space-y-4 border rounded-lg p-4 bg-zinc-50/50 dark:bg-zinc-900/10">
        <RouteTargetsTable
          targets={scheduleFormData.targets || []}
          onChange={(targets: any) => setScheduleFormData({...scheduleFormData, targets})}
          providers={providers}
          allModels={allModels}
          policies={policies || []}
          getProviderProtocolForSelection={getProviderProtocolForSelection}
          incomingProtocol={getIncomingProtocol()}
        />
        
        <div className="flex items-center gap-3 pt-4 border-t mt-6">
          <Switch
            id="schedule-allow-override"
            checked={scheduleFormData.allowClientModel}
            onCheckedChange={(checked: boolean) => setScheduleFormData({ ...scheduleFormData, allowClientModel: checked })}
          />
          <Label htmlFor="schedule-allow-override" className="cursor-pointer select-none font-normal">
            {t("routes.fields.allowClientModel", "允许客户端指定模型")}
          </Label>
        </div>
      </div>
    </div>
  );
}
