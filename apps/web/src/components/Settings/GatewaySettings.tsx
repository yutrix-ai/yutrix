import { useTranslation } from "react-i18next";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { FormField } from "@/components/FormField";
import { MessageSquare } from "lucide-react";

interface GatewaySettingsProps {
  settings: Record<string, string>;
  updateSetting: (key: string, value: string) => void;
  updateBoolean: (key: string, value: boolean) => void;
}

export function GatewaySettings({ settings, updateSetting, updateBoolean }: GatewaySettingsProps) {
  const { t } = useTranslation();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MessageSquare className="h-5 w-5" />
          {t("settings.sections.gateway.title", "会话与网关设置")}
        </CardTitle>
        <CardDescription>{t("settings.sections.gateway.desc", "配置会话管理和网关行为参数")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          <FormField label={t("settings.sections.gateway.conversationHeader", "默认会话 Header 名称")} hint={t("settings.sections.gateway.conversationHeaderHint", "用于识别会话的 HTTP Header")}>
            <Input
              value={settings.defaultConversationHeader || "X-Conversation-Id"}
              onChange={(e) =>
                updateSetting("defaultConversationHeader", e.target.value)
              }
              placeholder="X-Conversation-Id"
            />
          </FormField>

          <FormField label={t("settings.sections.gateway.ttl", "提示词注入记录 TTL (天)")} hint={t("settings.sections.gateway.ttlHint", "会话注入记录的保留时间")}>
            <Input
              type="number"
              value={settings.promptInjectionRecordTtlDays || ""}
              onChange={(e) =>
                updateSetting("promptInjectionRecordTtlDays", e.target.value)
              }
              placeholder="7"
            />
          </FormField>
        </div>

        <div className="space-y-3 pt-2">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <Label htmlFor="strictUsageMode">{t("settings.sections.gateway.strictUsage", "开启严格用量计算")}</Label>
              <p className="text-sm text-muted-foreground">
                {t("settings.sections.gateway.strictUsageDesc", "启用后，所有请求都将精确计算 token 用量")}
              </p>
            </div>
            <Switch
              id="strictUsageMode"
              checked={settings.strictUsageMode === "true"}
              onCheckedChange={(checked) =>
                updateBoolean("strictUsageMode", checked)
              }
            />
          </div>

          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <Label htmlFor="allowUnknownHostFallback">{t("settings.sections.gateway.unknownHostFallback", "允许未知域名回退处理")}</Label>
              <p className="text-sm text-muted-foreground">
                {t("settings.sections.gateway.unknownHostFallbackDesc", "当请求来自未配置的域名时，使用默认路由处理")}
              </p>
            </div>
            <Switch
              id="allowUnknownHostFallback"
              checked={settings.allowUnknownHostFallback === "true"}
              onCheckedChange={(checked) =>
                updateBoolean("allowUnknownHostFallback", checked)
              }
            />
          </div>

        </div>
      </CardContent>
    </Card>
  );
}
