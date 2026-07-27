import { useTranslation } from "react-i18next";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { FormField } from "@/components/FormField";
import { Shield } from "lucide-react";

interface SecuritySettingsProps {
  settings: Record<string, string>;
  updateSetting: (key: string, value: string) => void;
  updateBoolean: (key: string, value: boolean) => void;
}

export function SecuritySettings({ settings, updateSetting, updateBoolean }: SecuritySettingsProps) {
  const { t } = useTranslation();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Shield className="h-5 w-5" />
          {t("settings.sections.security.title", "安全与网络")}
        </CardTitle>
        <CardDescription>{t("settings.sections.security.desc", "配置安全和网络相关的参数")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <FormField
          label={t("settings.sections.security.cors", "CORS 允许白名单")}
          hint={t("settings.sections.security.corsHint", 'JSON 数组格式。生产环境下包含凭证时不允许使用 ["*"]，请填写真实域名')}
        >
          <Input
            className="font-mono text-sm"
            value={settings.corsAllowlist || ""}
            onChange={(e) => updateSetting("corsAllowlist", e.target.value)}
            placeholder='["https://example.com", "https://app.example.com"]'
          />
        </FormField>

        <div className="flex items-center justify-between gap-4 pt-2">
          <div className="min-w-0">
            <Label htmlFor="trustProxy">{t("settings.sections.security.trustProxy", "信任代理 (Trust Proxy)")}</Label>
            <p className="text-sm text-muted-foreground">
              {t("settings.sections.security.trustProxyDesc", "启用后可以正确获取通过代理服务器访问的真实客户端 IP")}
            </p>
          </div>
          <Switch
            id="trustProxy"
            checked={settings.trustProxy === "true"}
            onCheckedChange={(checked) =>
              updateBoolean("trustProxy", checked)
            }
          />
        </div>
      </CardContent>
    </Card>
  );
}
