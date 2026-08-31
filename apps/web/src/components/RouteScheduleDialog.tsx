import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { fetchApi } from "@/lib/api";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Plus, Save } from "lucide-react";
import { Provider, ProviderModel, Policy, RouteItem } from "./Routes/types";
import { ScheduleList } from "./Routes/ScheduleList";
import { ScheduleForm } from "./Routes/ScheduleForm";

interface RouteScheduleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  route: RouteItem | null;
  providers: Provider[];
  policies: Policy[];
  allModels: any[];
  onSuccess: () => void;
}

export default function RouteScheduleDialog({
  open,
  onOpenChange,
  route,
  providers,
  policies,
  allModels,
  onSuccess,
}: RouteScheduleDialogProps) {
  const { t } = useTranslation();
  const [activeRoute, setActiveRoute] = useState<RouteItem | null>(null);
  const [isEditingSchedule, setIsEditingSchedule] = useState(false);
  const [dailyStartStr, setDailyStartStr] = useState("00:00");
  const [enableTimeRange, setEnableTimeRange] = useState(false);

  useEffect(() => {
    const loadDailyStart = async () => {
      try {
        const settings = await fetchApi("/admin/settings");
        if (Array.isArray(settings)) {
          const setting = settings.find((s: any) => s.key === "analyticsStartOfDay");
          if (setting && setting.value) {
            setDailyStartStr(setting.value);
          }
        }
      } catch (e) {
        console.error("Failed to load settings:", e);
      }
    };
    loadDailyStart();
  }, []);

  // Form states
  const [scheduleFormData, setScheduleFormData] = useState({
    id: "",
    name: "",
    daysOfWeek: [] as number[],
    startTime: "17:00",
    endTime: "08:00",
    endNextDay: true,
    useDailyStartAsEnd: true,
    targets: [] as any[],
    allowClientModel: false,
  });

  // Option lists
  const [scheduleModels, setScheduleModels] = useState<ProviderModel[]>([]);
  const [scheduleModelsLoading, setScheduleModelsLoading] = useState(false);
  const [scheduleFallbackModels, setScheduleFallbackModels] = useState<ProviderModel[]>([]);
  const [scheduleFallbackModelsLoading, setScheduleFallbackModelsLoading] = useState(false);

  // Keep internal track of the active route to avoid layout flashing
  useEffect(() => {
    if (route) {
      setActiveRoute(route);
    }
  }, [route]);

  const loadScheduleModels = async (providerId: string, isFallback: boolean) => {
    if (!providerId || providerId === "none") {
      if (isFallback) setScheduleFallbackModels([]);
      else setScheduleModels([]);
      return;
    }
    if (isFallback) setScheduleFallbackModelsLoading(true);
    else setScheduleModelsLoading(true);

    try {
      const res = await fetchApi(`/admin/providers/${providerId}/models`);
      if (isFallback) setScheduleFallbackModels(res || []);
      else setScheduleModels(res || []);
    } catch (e) {
      toast.error(t("routes.toasts.modelLoadError", "加载模型失败"));
    } finally {
      if (isFallback) setScheduleFallbackModelsLoading(false);
      else setScheduleModelsLoading(false);
    }
  };

  const hasAnthropicEndpoint = (provider?: Provider) => !!provider?.anthropicBaseUrl;
  const getIncomingProtocol = () => activeRoute?.incomingProtocol || "openai";

  const getProviderProtocolForSelection = (
    incomingProtocol: string,
    provider: Provider | undefined,
  ) => {
    if (incomingProtocol === "anthropic") {
      return hasAnthropicEndpoint(provider) ? "anthropic" : "openai";
    }
    return "openai";
  };

  const handleSaveSchedule = async () => {
    if (!activeRoute) return;
    if (!scheduleFormData.name || !scheduleFormData.targets || scheduleFormData.targets.length === 0 || !scheduleFormData.targets[0].providerId || !scheduleFormData.targets[0].modelId) {
      toast.error(t("routes.toasts.fillRequired", "请填写所有必填项"));
      return;
    }
    if (scheduleFormData.daysOfWeek.length === 0) {
      toast.error(t("routes.schedule.toasts.selectDays", "请选择执行周期"));
      return;
    }
    // Time window validation
    if (enableTimeRange && !scheduleFormData.useDailyStartAsEnd) {
      if (!scheduleFormData.startTime || !scheduleFormData.endTime) {
        toast.error(t("routes.toasts.fillRequired", "请填写所有必填项"));
        return;
      }
      const [sh, sm] = scheduleFormData.startTime.split(":").map(Number);
      const [eh, em] = scheduleFormData.endTime.split(":").map(Number);
      const [dh, dm] = dailyStartStr.split(":").map(Number);

      const sMin = dh * 60 + dm;
      const startMin = sh * 60 + sm;
      const endMin = eh * 60 + em;

      const startOffset = (startMin - sMin + 1440) % 1440;
      const endOffset = (endMin - sMin + 1440) % 1440;

      const isValid = endOffset === 0 || endOffset > startOffset;
      if (!isValid) {
        toast.error(t("routes.schedule.toasts.invalidEndTime", `结束时间必须小于等于每日起始时间 (${dailyStartStr}) 且晚于开始时间`).replace("{{time}}", dailyStartStr));
        return;
      }
    }

    const [sh, sm] = scheduleFormData.startTime.split(":").map(Number);
    const [eh, em] = scheduleFormData.endTime.split(":").map(Number);
    const endNextDayComputed = enableTimeRange 
      ? (scheduleFormData.useDailyStartAsEnd ? true : (eh * 60 + em < sh * 60 + sm))
      : true;

    const newSchedule = {
      ...scheduleFormData,
      id: scheduleFormData.id || crypto.randomUUID(),
      startTime: enableTimeRange ? scheduleFormData.startTime : dailyStartStr,
      endTime: enableTimeRange ? (scheduleFormData.useDailyStartAsEnd ? dailyStartStr : scheduleFormData.endTime) : dailyStartStr,
      useDailyStartAsEnd: enableTimeRange ? scheduleFormData.useDailyStartAsEnd : true,
      endNextDay: endNextDayComputed,
      targets: typeof scheduleFormData.targets === 'string' ? JSON.parse(scheduleFormData.targets) : scheduleFormData.targets,
    };

    const currentSchedules = activeRoute.schedules || [];
    let updatedSchedules = [];
    if (scheduleFormData.id) {
      updatedSchedules = currentSchedules.map((s: any) => s.id === scheduleFormData.id ? newSchedule : s);
    } else {
      updatedSchedules = [...currentSchedules, newSchedule];
    }

    try {
      await fetchApi(`/admin/routes/${activeRoute.id}`, {
        method: "PATCH",
        body: JSON.stringify({ schedules: updatedSchedules }),
      });

      toast.success(t("routes.schedule.saveSuccess", "保存计划成功"));
      
      // Update local state and trigger parent reload
      setActiveRoute({ ...activeRoute, schedules: updatedSchedules });
      onSuccess();
      setIsEditingSchedule(false);
    } catch (e: any) {
      toast.error(t("routes.toasts.saveFailed", "保存失败") + ": " + e.message);
    }
  };

  const handleDeleteSchedule = async (scheduleId: string) => {
    if (!activeRoute) return;
    if (!confirm(t("routes.schedule.deleteConfirm", "确认删除此计划吗？"))) return;

    const currentSchedules = activeRoute.schedules || [];
    const updatedSchedules = currentSchedules.filter((s: any) => s.id !== scheduleId);

    try {
      await fetchApi(`/admin/routes/${activeRoute.id}`, {
        method: "PATCH",
        body: JSON.stringify({ schedules: updatedSchedules }),
      });

      toast.success(t("routes.toasts.deleteSuccess", "删除成功"));
      
      setActiveRoute({ ...activeRoute, schedules: updatedSchedules });
      onSuccess();
    } catch (e: any) {
      toast.error(t("routes.toasts.deleteFailed", "删除失败") + ": " + e.message);
    }
  };

  const openAddSchedule = () => {
    setScheduleFormData({
      id: "",
      name: "",
      daysOfWeek: [],
      startTime: "17:00",
      endTime: "08:00",
      endNextDay: true,
      useDailyStartAsEnd: true,
      targets: [] as any[],
      allowClientModel: false,
    });
    setScheduleModels([]);
    setScheduleFallbackModels([]);
    setEnableTimeRange(false);
    setIsEditingSchedule(true);
  };

  const openEditSchedule = (schedule: any) => {
    const isAllDay = !!schedule.useDailyStartAsEnd && (schedule.startTime === dailyStartStr || !schedule.startTime);
    setScheduleFormData({
      id: schedule.id,
      name: schedule.name || "",
      daysOfWeek: schedule.daysOfWeek || [],
      startTime: schedule.startTime || "09:00",
      endTime: schedule.endTime || "18:00",
      endNextDay: !!schedule.endNextDay,
      useDailyStartAsEnd: !!schedule.useDailyStartAsEnd,
      targets: schedule.targets ? (typeof schedule.targets === 'string' ? JSON.parse(schedule.targets) : schedule.targets) : (() => {
        const t = [{
          providerId: schedule.providerId || "",
          providerProtocol: schedule.providerProtocol || "openai",
          modelId: schedule.modelId || "",
          promptPolicyId: schedule.promptPolicyId || "none",
          bestEffort: false,
          strategyRoutingEnabled: false,
          strategyRoutingRules: []
        }];
        if (schedule.fallbackEnabled && schedule.fallbackProviderId && schedule.fallbackProviderId !== "none") {
          t.push({
            providerId: schedule.fallbackProviderId,
            providerProtocol: schedule.fallbackProviderProtocol || "openai",
            modelId: schedule.fallbackModelId || "",
            promptPolicyId: schedule.fallbackPromptPolicyId || "none",
            bestEffort: !!schedule.fallbackMatchTarget,
            strategyRoutingEnabled: false,
            strategyRoutingRules: []
          });
        }
        return t;
      })(),
      allowClientModel: !!schedule.allowClientModel,
    });

    setEnableTimeRange(!isAllDay);
    setIsEditingSchedule(true);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[95vw] lg:max-w-[90vw] xl:max-w-7xl h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>
            {isEditingSchedule
              ? (scheduleFormData.id ? t("routes.schedule.editTitle", "编辑路由计划") : t("routes.schedule.addTitle", "新建路由计划"))
              : t("routes.schedule.dialogTitle", { name: activeRoute?.name || "" })}
          </DialogTitle>
          <DialogDescription>
            {isEditingSchedule
              ? t("routes.schedule.formDesc", "设置特定时段覆盖默认路由的目标和降级配置")
              : t("routes.schedule.dialogDesc", "为路由添加周期性计划，生效时将自动覆盖默认目标和降级规则")}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="flex-1 overflow-y-auto max-h-[calc(90vh-130px)] pr-1">
          {!isEditingSchedule ? (
            <ScheduleList
              activeRoute={activeRoute}
              providers={providers}
              dailyStartStr={dailyStartStr}
              onEditSchedule={openEditSchedule}
              onDeleteSchedule={handleDeleteSchedule}
            />
          ) : (
            <ScheduleForm
              scheduleFormData={scheduleFormData}
              setScheduleFormData={setScheduleFormData}
              enableTimeRange={enableTimeRange}
              setEnableTimeRange={setEnableTimeRange}
              dailyStartStr={dailyStartStr}
              providers={providers}
              policies={policies}
              getIncomingProtocol={getIncomingProtocol}
              getProviderProtocolForSelection={getProviderProtocolForSelection}
              allModels={allModels}
              routingMode={route?.routingMode || "strategy"}
            />
          )}
        </DialogBody>
        <DialogFooter>
          {!isEditingSchedule ? (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t("common.close", "关闭")}
              </Button>
              <Button variant="default" className="bg-violet-600 hover:bg-violet-700 text-white" onClick={openAddSchedule}>
                <Plus className="w-4 h-4 mr-1.5" />
                {t("routes.schedule.addButton", "添加计划")}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => setIsEditingSchedule(false)}>
                {t("common.cancel", "取消")}
              </Button>
              <Button variant="default" className="bg-violet-600 hover:bg-violet-700 text-white" onClick={handleSaveSchedule}>
                <Save className="w-4 h-4 mr-1.5" />
                {t("common.save", "保存")}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
