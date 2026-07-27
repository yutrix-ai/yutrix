import { useTranslation } from "react-i18next";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/FormField";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Palette } from "lucide-react";

interface AppearanceSettingsProps {
  settings: Record<string, string>;
  updateSetting: (key: string, value: string) => void;
}

export function AppearanceSettings({ settings, updateSetting }: AppearanceSettingsProps) {
  const { t } = useTranslation();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Palette className="h-5 w-5" />
          {t("settings.sections.appearance.title", "外观与主题")}
        </CardTitle>
        <CardDescription>{t("settings.sections.appearance.desc", "自定义控制台的外观和主题设置")}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 md:grid-cols-2">
        <FormField label={t("settings.sections.appearance.theme", "主题")}>
          <Select
            value={settings.theme || "system"}
            onValueChange={(value) => updateSetting("theme", value)}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="system">{t("settings.sections.appearance.themeSystem", "跟随系统")}</SelectItem>
              <SelectItem value="light">{t("settings.sections.appearance.themeLight", "浅色")}</SelectItem>
              <SelectItem value="dark">{t("settings.sections.appearance.themeDark", "深色")}</SelectItem>
            </SelectContent>
          </Select>
        </FormField>

        <FormField label={t("settings.sections.appearance.accentColor", "主色调")} hint={t("settings.sections.appearance.accentColorHint", "输入十六进制颜色代码，如 #3b82f6")}>
          <Input
            value={settings.accentColor || ""}
            onChange={(e) => updateSetting("accentColor", e.target.value)}
            placeholder="#3b82f6"
          />
        </FormField>

        <FormField label={t("settings.sections.appearance.dateFormat", "日期格式")}>
          <Select
            value={settings.dateFormat || "YYYY-MM-DD"}
            onValueChange={(value) => updateSetting("dateFormat", value)}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="YYYY-MM-DD">YYYY-MM-DD</SelectItem>
              <SelectItem value="MM/DD/YYYY">MM/DD/YYYY</SelectItem>
              <SelectItem value="DD/MM/YYYY">DD/MM/YYYY</SelectItem>
            </SelectContent>
          </Select>
        </FormField>

        <FormField label={t("settings.sections.appearance.timeFormat", "时间格式")}>
          <Select
            value={settings.timeFormat || "24h"}
            onValueChange={(value) => updateSetting("timeFormat", value)}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="24h">{t("settings.sections.appearance.timeFormat24h", "24小时制")}</SelectItem>
              <SelectItem value="12h">{t("settings.sections.appearance.timeFormat12h", "12小时制")}</SelectItem>
            </SelectContent>
          </Select>
        </FormField>
      </CardContent>
    </Card>
  );
}
