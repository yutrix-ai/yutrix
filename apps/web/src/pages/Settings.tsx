import { useState, useEffect } from "react";
import { fetchApi } from "../lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { useTranslation } from "react-i18next";
import { Skeleton } from "@/components/ui/skeleton";
import { Save } from "lucide-react";
import { toast } from "sonner";
import { useSettings } from "../contexts/SettingsContext";

import { BrandingSettings } from "@/components/Settings/BrandingSettings";
import { AppearanceSettings } from "@/components/Settings/AppearanceSettings";
import { BasicSettings } from "@/components/Settings/BasicSettings";
import { AnalyticsSettings } from "@/components/Settings/AnalyticsSettings";
import { GatewaySettings, LOOP_GUARD_SETTING_UI_DEFAULTS } from "@/components/Settings/GatewaySettings";
import { LoggingSettings } from "@/components/Settings/LoggingSettings";
import { SecuritySettings } from "@/components/Settings/SecuritySettings";
import { DingTalkSettings } from "@/components/Settings/DingTalkSettings";
import { DatabaseSettings } from "@/components/Settings/DatabaseSettings";

export default function Settings() {
  const { t } = useTranslation();
  const { refreshSettings } = useSettings();
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [users, setUsers] = useState<any[]>([]);
  const [routes, setRoutes] = useState<any[]>([]);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      const [res, usersRes, routesRes] = await Promise.all([
        fetchApi("/admin/settings"),
        fetchApi("/admin/users").catch(() => []), // fallback if error
        fetchApi("/admin/routes").catch(() => [])
      ]);
      const map: any = {};
      res.forEach((s: any) => {
        map[s.key] = s.value;
      });
      setSettings({ ...LOOP_GUARD_SETTING_UI_DEFAULTS, ...map });
      if (usersRes && Array.isArray(usersRes)) {
        setUsers(usersRes);
      }
      if (routesRes && Array.isArray(routesRes)) {
        setRoutes(routesRes);
      }
    } catch (e: any) {
      toast.error(t("settings.toasts.loadFailed", "加载设置失败") + ": " + e.message);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const updates = Object.keys(settings).map((key) => ({
        key,
        value: settings[key],
      }));
      await fetchApi("/admin/settings", {
        method: "POST",
        body: JSON.stringify({ settings: updates }),
      });
      toast.success(t("settings.toasts.saveSuccess", "设置保存成功"));
      refreshSettings();
      loadData();
    } catch (e: any) {
      toast.error(t("settings.toasts.saveFailed", "保存失败") + ": " + e.message);
    } finally {
      setSaving(false);
    }
  };

  const updateSetting = (key: string, value: string) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  const updateBoolean = (key: string, value: boolean) => {
    updateSetting(key, value ? "true" : "false");
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="grid gap-6 md:grid-cols-2">
          {[...Array(4)].map((_, i) => (
            <Card key={i}>
              <CardHeader>
                <Skeleton className="h-6 w-32" />
                <Skeleton className="h-4 w-48" />
              </CardHeader>
              <CardContent className="space-y-4">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="min-w-0 space-y-6">
      <form onSubmit={handleSave} className="min-w-0 space-y-6" autoComplete="off">
        <BrandingSettings settings={settings} updateSetting={updateSetting} updateBoolean={updateBoolean} />
        <AppearanceSettings settings={settings} updateSetting={updateSetting} />
        <BasicSettings settings={settings} updateSetting={updateSetting} />
        <AnalyticsSettings settings={settings} updateSetting={updateSetting} />
        <GatewaySettings settings={settings} updateSetting={updateSetting} updateBoolean={updateBoolean} />
        <LoggingSettings settings={settings} updateSetting={updateSetting} updateBoolean={updateBoolean} routes={routes} users={users} />
        <SecuritySettings settings={settings} updateSetting={updateSetting} updateBoolean={updateBoolean} />
        <DingTalkSettings settings={settings} updateSetting={updateSetting} updateBoolean={updateBoolean} users={users} />

        <div className="sticky bottom-0 z-10 -mx-4 md:-mx-8 -mb-4 md:-mb-8 flex justify-end border-t bg-background/95 px-4 md:px-8 py-4 backdrop-blur supports-[backdrop-filter]:bg-background/80">
          <Button type="submit" size="lg" disabled={saving}>
            <Save className="h-4 w-4 mr-2" />
            {saving ? t("settings.actions.saving", "保存中...") : t("settings.actions.saveAll", "保存所有设置")}
          </Button>
        </div>
      </form>
      <DatabaseSettings />
    </div>
  );
}
