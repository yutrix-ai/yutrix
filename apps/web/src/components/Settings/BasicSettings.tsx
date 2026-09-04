import { useTranslation } from "react-i18next";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/FormField";
import { Globe } from "lucide-react";

interface BasicSettingsProps {
  settings: Record<string, string>;
  updateSetting: (key: string, value: string) => void;
}

export function BasicSettings({ settings, updateSetting }: BasicSettingsProps) {
  const { t } = useTranslation();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Globe className="h-5 w-5" />
          {t("settings.sections.basic.title", "基础设置")}
        </CardTitle>
        <CardDescription>{t("settings.sections.basic.desc", "配置域名和网络相关的基础参数")}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 md:grid-cols-2">
        <FormField
          label={t("settings.sections.basic.mainDomain", "主域名")}
          hint={t(
            "settings.sections.basic.mainDomainHint",
            "DNS 区域父域，用作子域后缀与 CORS 同站父域（例如 brtel.link）。这不是控制台/登录主机。",
          )}
        >
          <Input
            value={settings.mainDomain || ""}
            onChange={(e) => updateSetting("mainDomain", e.target.value)}
            placeholder="brtel.link"
          />
        </FormField>

        <FormField
          label={t("settings.sections.basic.adminHost", "控制台主机 (adminHost)")}
          hint={t(
            "settings.sections.basic.adminHostHint",
            "控制台/登录完整域名（例如 token.brtel.link）。留空为零配置：凡未登记为 API 路由主机的 Host 均可打开控制台。",
          )}
        >
          <Input
            value={settings.adminHost || ""}
            onChange={(e) => updateSetting("adminHost", e.target.value)}
            placeholder="token.brtel.link"
          />
        </FormField>

        <FormField label={t("settings.sections.basic.queueTimeout", "默认队列超时时间 (ms)")} hint={t("settings.sections.basic.queueTimeoutHint", "请求在队列中等待的最大时间")}>
          <Input
            type="number"
            value={settings.defaultQueueTimeoutMs || ""}
            onChange={(e) =>
              updateSetting("defaultQueueTimeoutMs", e.target.value)
            }
            placeholder="30000"
          />
        </FormField>
      </CardContent>
    </Card>
  );
}
