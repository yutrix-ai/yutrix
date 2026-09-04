import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FormField } from "@/components/FormField";
import { Bell } from "lucide-react";
import { fetchApi } from "@/lib/api";
import { toast } from "sonner";

interface DingTalkSettingsProps {
  settings: Record<string, string>;
  updateSetting: (key: string, value: string) => void;
  updateBoolean: (key: string, value: boolean) => void;
  users: any[];
}

export function DingTalkSettings({ settings, updateSetting, updateBoolean, users }: DingTalkSettingsProps) {
  const { t } = useTranslation();
  const [testingDingTalk, setTestingDingTalk] = useState(false);

  const handleTestDingTalk = async () => {
    setTestingDingTalk(true);
    try {
      await fetchApi("/admin/settings/test-dingtalk", { method: "POST", body: JSON.stringify({}) });
      toast.success(t("settings.toasts.saveSuccess", "测试成功"));
    } catch (e: any) {
      toast.error(t("settings.toasts.saveFailed", "测试失败") + ": " + e.message);
    } finally {
      setTestingDingTalk(false);
    }
  };

  const excludeUsersArray = (() => {
    try {
      return JSON.parse(settings.dingTalkExcludeUsers || "[]");
    } catch(e) {
      return [];
    }
  })();

  const toggleExcludeUser = (userId: string, checked: boolean) => {
    let arr = [...excludeUsersArray];
    if (checked) {
      if (!arr.includes(userId)) arr.push(userId);
    } else {
      arr = arr.filter(id => id !== userId);
    }
    updateSetting("dingTalkExcludeUsers", JSON.stringify(arr));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bell className="h-5 w-5" />
          {t("settings.sections.dingtalk.title", "钉钉通知推送")}
        </CardTitle>
        <CardDescription>{t("settings.sections.dingtalk.desc", "配置钉钉群定时推送报表")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-4 pt-2">
          <div className="min-w-0">
            <Label htmlFor="dingTalkEnabled">{t("settings.sections.dingtalk.enable", "启用定时推送")}</Label>
            <p className="text-sm text-muted-foreground">
              {t("settings.sections.dingtalk.enableDesc", "自动向钉钉群发送每日统计数据报表")}
            </p>
          </div>
          <div className="flex items-center gap-4">
            <Button 
              type="button" 
              variant="outline" 
              size="sm" 
              onClick={handleTestDingTalk} 
              disabled={testingDingTalk}
            >
              {testingDingTalk ? t("settings.sections.dingtalk.testingPush", "发送中...") : t("settings.sections.dingtalk.testPush", "手动触发")}
            </Button>
            <Switch
              id="dingTalkEnabled"
              checked={settings.dingTalkEnabled === "true"}
              onCheckedChange={(checked) =>
                updateBoolean("dingTalkEnabled", checked)
              }
            />
          </div>
        </div>

        <div className="flex items-center justify-between gap-4 pt-2">
          <div className="min-w-0">
            <Label htmlFor="dingTalkSkipEmpty">{t("settings.sections.dingtalk.skipEmpty", "无用量不推送")}</Label>
            <p className="text-sm text-muted-foreground">
              {t("settings.sections.dingtalk.skipEmptyDesc", "开启后，只有当非排除名单用户产生至少 1 个 Token 消耗时，才会执行定时推送")}
            </p>
          </div>
          <Switch
            id="dingTalkSkipEmpty"
            checked={settings.dingTalkSkipEmpty === "true"}
            onCheckedChange={(checked) =>
              updateBoolean("dingTalkSkipEmpty", checked)
            }
          />
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <FormField label={t("settings.sections.dingtalk.cron", "Cron 表达式")} hint={t("settings.sections.dingtalk.cronHint", "例如：0 7 * * * 表示每天早上 7 点触发")}>
            <Input
              className="font-mono text-sm"
              value={settings.dingTalkCron || ""}
              onChange={(e) => updateSetting("dingTalkCron", e.target.value)}
              placeholder="0 7 * * *"
              autoComplete="off"
              data-1p-ignore
            />
          </FormField>

          <FormField label={t("settings.sections.dingtalk.webhook", "Webhook 地址")}>
            <Input
              type="text"
              name="dingtalk-webhook"
              value={settings.dingTalkWebhook || ""}
              onChange={(e) => updateSetting("dingTalkWebhook", e.target.value)}
              placeholder={t("settings.sections.dingtalk.webhookPlaceholder", "https://oapi.dingtalk.com/robot/send?access_token=...")}
              autoComplete="off"
              data-lpignore="true"
              data-1p-ignore="true"
              className="[-webkit-text-security:disc]"
            />
          </FormField>
        </div>
        
        <FormField label={t("settings.sections.dingtalk.secret", "安全设置 Secret")}>
          <Input
            type="text"
            name="dingtalk-secret"
            value={settings.dingTalkSecret || ""}
            onChange={(e) => updateSetting("dingTalkSecret", e.target.value)}
            placeholder={t("settings.sections.dingtalk.secretPlaceholder", "SEC...")}
            autoComplete="off"
            data-lpignore="true"
            data-1p-ignore="true"
            className="[-webkit-text-security:disc]"
          />
        </FormField>

        <div className="grid gap-4 md:grid-cols-2">
          <FormField label={t("settings.sections.dingtalk.language", "推送文案语言")} hint={t("settings.sections.dingtalk.languageHint", "设置推送到钉钉的报表语言")}>
            <Select value={settings.dingTalkLanguage || "zh"} onValueChange={(v) => updateSetting("dingTalkLanguage", v)}>
              <SelectTrigger className="h-10 bg-background">
                <SelectValue placeholder="中文" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="zh">中文</SelectItem>
                <SelectItem value="en">English</SelectItem>
              </SelectContent>
            </Select>
          </FormField>

          <FormField label={t("settings.sections.dingtalk.excludeUsers", "不推送名单")} hint={t("settings.sections.dingtalk.excludeUsersHint", "选择在报表中隐藏（不参与用量统计和排行）的用户")}>
            <div className="flex flex-wrap gap-3 max-h-[120px] overflow-y-auto p-2 border rounded-md bg-muted/30 scroll-smooth">
              {users.map(u => (
                <label key={u.id} className="flex items-center gap-2 text-sm cursor-pointer hover:bg-muted/50 p-1.5 rounded-md pr-3 border border-transparent hover:border-border transition-colors">
                  <input 
                    type="checkbox" 
                    className="w-4 h-4 cursor-pointer accent-blue-500 rounded border-gray-300" 
                    checked={excludeUsersArray.includes(u.id)}
                    onChange={(e) => toggleExcludeUser(u.id, e.target.checked)}
                  />
                  <span className="font-medium">{u.username}</span>
                </label>
              ))}
              {users.length === 0 && <span className="text-muted-foreground text-xs p-1">No users</span>}
            </div>
          </FormField>
        </div>
      </CardContent>
    </Card>
  );
}
