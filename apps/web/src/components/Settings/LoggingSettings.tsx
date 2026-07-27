import { useTranslation } from "react-i18next";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { FormField } from "@/components/FormField";
import { FileText, X } from "lucide-react";

interface LoggingSettingsProps {
  settings: Record<string, string>;
  updateSetting: (key: string, value: string) => void;
  updateBoolean: (key: string, value: boolean) => void;
  routes: any[];
  users: any[];
}

export function LoggingSettings({ settings, updateSetting, updateBoolean, routes, users }: LoggingSettingsProps) {
  const { t } = useTranslation();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileText className="h-5 w-5" />
          {t("settings.sections.logging.title", "日志与运维")}
        </CardTitle>
        <CardDescription>{t("settings.sections.logging.desc", "配置日志记录和运维相关的参数")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          <FormField label={t("settings.sections.logging.level", "日志级别")}>
            <Select
              value={settings.logLevel || "info"}
              onValueChange={(value) => updateSetting("logLevel", value)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="debug">Debug</SelectItem>
                <SelectItem value="info">Info</SelectItem>
                <SelectItem value="warn">Warn</SelectItem>
                <SelectItem value="error">Error</SelectItem>
              </SelectContent>
            </Select>
          </FormField>

          <FormField label={t("settings.sections.logging.retention", "日志保留天数")} hint={t("settings.sections.logging.retentionHint", "超过此天数的日志将被自动清理")}>
            <Input
              type="number"
              value={settings.logRetentionDays || ""}
              onChange={(e) =>
                updateSetting("logRetentionDays", e.target.value)
              }
              placeholder="30"
            />
          </FormField>
        </div>

        <div className="flex items-center justify-between gap-4 pt-2">
          <div className="min-w-0">
            <Label htmlFor="realtimeLogsEnabled">{t("settings.sections.logging.realtimeLogs", "启用实时请求日志")}</Label>
            <p className="text-sm text-muted-foreground">
              {t("settings.sections.logging.realtimeLogsDesc", "开启后可以在实时日志页面查看请求流")}
            </p>
          </div>
          <Switch
            id="realtimeLogsEnabled"
            checked={settings.realtimeLogsEnabled === "true"}
            onCheckedChange={(checked) =>
              updateBoolean("realtimeLogsEnabled", checked)
            }
          />
        </div>

        <div className="flex items-center justify-between gap-4 pt-2 border-t">
          <div className="min-w-0">
            <Label htmlFor="sessionSummaryEnabled">{t("settings.sections.logging.sessionSummaryEnabled", "启用会话标题总结")}</Label>
            <p className="text-sm text-muted-foreground">
              {t("settings.sections.logging.sessionSummaryEnabledDesc", "开启后，系统将在每个新会话的首轮对话后，自动调用指定路由进行标题概括")}
            </p>
          </div>
          <Switch
            id="sessionSummaryEnabled"
            checked={settings.sessionSummaryEnabled === "true"}
            onCheckedChange={(checked) =>
              updateBoolean("sessionSummaryEnabled", checked)
            }
          />
        </div>

        {settings.sessionSummaryEnabled === "true" && (
          <div className="pt-2">
            <FormField label={t("settings.sections.logging.sessionSummaryRoute", "总结路由")}>
              <Select
                value={settings.sessionSummaryRoute || ""}
                onValueChange={(value) => updateSetting("sessionSummaryRoute", value)}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t("settings.sections.logging.sessionSummaryRoutePlaceholder", "选择用于总结的路由")} />
                </SelectTrigger>
                <SelectContent>
                  {routes.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.name || r.path} ({r.host})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          </div>
        )}

        <div className="pt-2 border-t">
          <FormField 
            label={t("settings.sections.logging.auditExemptUsers", "免审计用户")} 
            hint={t("settings.sections.logging.auditExemptUsersHint", "选择在此列表中的用户，其对话内容将不会被记录到 LLM 审计日志中，也不会出现在实时日志流中")}
          >
            <div className="space-y-3">
              <Select
                value=""
                onValueChange={(value) => {
                  if (!value) return;
                  const currentExempt = settings.auditExemptUsers ? settings.auditExemptUsers.split(",").filter(Boolean) : [];
                  if (!currentExempt.includes(value)) {
                    updateSetting("auditExemptUsers", [...currentExempt, value].join(","));
                  }
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder={t("settings.sections.logging.auditExemptUsersPlaceholder", "添加免审计用户...")} />
                </SelectTrigger>
                <SelectContent>
                  {users.filter(u => !(settings.auditExemptUsers?.split(",") || []).includes(u.id)).map((u) => (
                    <SelectItem key={u.id} value={u.id}>
                      {u.username}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              
              {settings.auditExemptUsers && settings.auditExemptUsers.split(",").filter(Boolean).length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {settings.auditExemptUsers.split(",").filter(Boolean).map(userId => {
                    const userObj = users.find(u => u.id === userId);
                    return (
                      <Badge key={userId} variant="secondary" className="flex items-center gap-1 py-1 px-2 text-sm">
                        {userObj ? userObj.username : userId}
                        <button
                          type="button"
                          className="ml-1 rounded-full outline-none hover:bg-muted focus:bg-muted"
                          onClick={() => {
                            const newExempt = settings.auditExemptUsers.split(",").filter(id => id !== userId);
                            updateSetting("auditExemptUsers", newExempt.join(","));
                          }}
                        >
                          <X className="h-3 w-3 text-muted-foreground hover:text-foreground" />
                        </button>
                      </Badge>
                    );
                  })}
                </div>
              )}
            </div>
          </FormField>
        </div>
      </CardContent>
    </Card>
  );
}
