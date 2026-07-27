import { useTranslation } from "react-i18next";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FormField } from "@/components/FormField";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TimePicker24h } from "@/components/ui/time-picker-24h";
import { Globe } from "lucide-react";

interface AnalyticsSettingsProps {
  settings: Record<string, string>;
  updateSetting: (key: string, value: string) => void;
}

export function AnalyticsSettings({ settings, updateSetting }: AnalyticsSettingsProps) {
  const { t } = useTranslation();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Globe className="h-5 w-5" />
          {t("settings.sections.analytics.title", "数据统计设置")}
        </CardTitle>
        <CardDescription>
          {t("settings.sections.analytics.desc", "配置系统全局统计数据的聚合边界，例如每日的起始时间与每周的起始日")}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 md:grid-cols-2">
        <FormField 
          label={t("settings.sections.analytics.startOfDay", "每日起始时间")} 
          hint={t("settings.sections.analytics.startOfDayHint", "例如 08:00 代表每天的 8 点作为新的一天的开始")}
        >
          <TimePicker24h
            value={settings.analyticsStartOfDay || "00:00"}
            onChange={(val) => updateSetting("analyticsStartOfDay", val)}
          />
        </FormField>

        <FormField label={t("settings.sections.analytics.startOfWeek", "每周起始日")}>
          <Select
            value={settings.analyticsStartOfWeek || "1"}
            onValueChange={(value) => updateSetting("analyticsStartOfWeek", value)}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="1">{t("settings.sections.analytics.weekStartMonday", "周一")}</SelectItem>
              <SelectItem value="0">{t("settings.sections.analytics.weekStartSunday", "周日")}</SelectItem>
            </SelectContent>
          </Select>
        </FormField>

        <FormField label={t("settings.sections.analytics.tokenDisplayUnit", "Token 统计单位")}>
          <Select
            value={settings.tokenDisplayUnit || "raw"}
            onValueChange={(value) => updateSetting("tokenDisplayUnit", value)}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="raw">{t("settings.sections.analytics.unitRaw", "原始值")}</SelectItem>
              <SelectItem value="K">K</SelectItem>
              <SelectItem value="M">M</SelectItem>
            </SelectContent>
          </Select>
        </FormField>
      </CardContent>
    </Card>
  );
}
