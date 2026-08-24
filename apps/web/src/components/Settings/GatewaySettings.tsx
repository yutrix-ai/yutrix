import { useTranslation } from "react-i18next";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { FormField } from "@/components/FormField";
import { MessageSquare } from "lucide-react";

export const LOOP_GUARD_SETTING_UI_DEFAULTS: Record<string, string> = {
  loopGuardEnabled: "true",
  loopGuardIdenticalErrorRepeats: "5",
  loopGuardPingPongHalfCycles: "8",
  loopGuardContinuationCeiling: "400",
  loopGuardContinuationMaxAgeHours: "2",
};

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

        <div className="space-y-4 border-t border-border pt-4">
          <div>
            <h3 className="text-sm font-medium text-foreground">
              {t("settings.sections.gateway.loopGuardTitle", "工具循环熔断")}
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {t(
                "settings.sections.gateway.loopGuardDesc",
                "拦住反复失败的工具续写（相同错误或 A-B 乒乓），避免空转烧 Token。关闭后网关不再硬停。",
              )}
            </p>
          </div>

          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <Label htmlFor="loopGuardEnabled">
                {t("settings.sections.gateway.loopGuardEnabled", "启用工具循环硬停")}
              </Label>
              <p className="text-sm text-muted-foreground">
                {t(
                  "settings.sections.gateway.loopGuardEnabledDesc",
                  "默认开启。关闭后仅记录会话，不再对工具续写做硬停。",
                )}
              </p>
            </div>
            <Switch
              id="loopGuardEnabled"
              checked={settings.loopGuardEnabled !== "false"}
              onCheckedChange={(checked) => updateBoolean("loopGuardEnabled", checked)}
            />
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <FormField
              label={t("settings.sections.gateway.loopGuardIdentical", "相同错误次数")}
              hint={t(
                "settings.sections.gateway.loopGuardIdenticalHint",
                "同一工具错误连续出现多少次后硬停。最低 3，默认 5。",
              )}
            >
              <Input
                id="loopGuardIdenticalErrorRepeats"
                type="number"
                inputMode="numeric"
                value={settings.loopGuardIdenticalErrorRepeats ?? LOOP_GUARD_SETTING_UI_DEFAULTS.loopGuardIdenticalErrorRepeats}
                onChange={(e) => updateSetting("loopGuardIdenticalErrorRepeats", e.target.value)}
                placeholder="5"
              />
            </FormField>
            <FormField
              label={t("settings.sections.gateway.loopGuardPingPong", "乒乓半周期")}
              hint={t(
                "settings.sections.gateway.loopGuardPingPongHint",
                "两个错误来回交替多少个半周期后硬停。最低 6，默认 8。",
              )}
            >
              <Input
                id="loopGuardPingPongHalfCycles"
                type="number"
                inputMode="numeric"
                value={settings.loopGuardPingPongHalfCycles ?? LOOP_GUARD_SETTING_UI_DEFAULTS.loopGuardPingPongHalfCycles}
                onChange={(e) => updateSetting("loopGuardPingPongHalfCycles", e.target.value)}
                placeholder="8"
              />
            </FormField>
            <FormField
              label={t("settings.sections.gateway.loopGuardCeiling", "续写轮数上限")}
              hint={t(
                "settings.sections.gateway.loopGuardCeilingHint",
                "距上次真实用户消息的工具续写轮数。0 关闭该信号。默认 400。",
              )}
            >
              <Input
                id="loopGuardContinuationCeiling"
                type="number"
                inputMode="numeric"
                value={settings.loopGuardContinuationCeiling ?? LOOP_GUARD_SETTING_UI_DEFAULTS.loopGuardContinuationCeiling}
                onChange={(e) => updateSetting("loopGuardContinuationCeiling", e.target.value)}
                placeholder="400"
              />
            </FormField>
            <FormField
              label={t("settings.sections.gateway.loopGuardMaxAge", "续写最长时长（小时）")}
              hint={t(
                "settings.sections.gateway.loopGuardMaxAgeHint",
                "距上次真实用户消息的时长。0 关闭该信号。默认 2。",
              )}
            >
              <Input
                id="loopGuardContinuationMaxAgeHours"
                type="number"
                inputMode="numeric"
                value={settings.loopGuardContinuationMaxAgeHours ?? LOOP_GUARD_SETTING_UI_DEFAULTS.loopGuardContinuationMaxAgeHours}
                onChange={(e) => updateSetting("loopGuardContinuationMaxAgeHours", e.target.value)}
                placeholder="2"
              />
            </FormField>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
