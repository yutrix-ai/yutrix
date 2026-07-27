import { useState } from "react";
import { fetchApi } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FormField } from "@/components/FormField";
import { useAuth } from "@/lib/store";
import { Lock, Save } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";

export default function ChangePassword() {
  const { logout } = useAuth();
  const { t } = useTranslation();
  const [formData, setFormData] = useState({
    currentPassword: "",
    newPassword: "",
    confirmPassword: "",
  });
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!formData.currentPassword) {
      toast.error(t("changePassword.errorEmptyCurrent"));
      return;
    }

    if (formData.newPassword !== formData.confirmPassword) {
      toast.error(t("changePassword.errorMismatch"));
      return;
    }

    if (formData.newPassword.length < 8) {
      toast.error(t("changePassword.errorLength"));
      return;
    }

    setSaving(true);
    try {
      await fetchApi("/auth/change-password", {
        method: "POST",
        body: JSON.stringify({
          oldPassword: formData.currentPassword,
          newPassword: formData.newPassword,
        }),
      });

      toast.success(t("changePassword.success"));
      setTimeout(() => {
        logout();
      }, 1500);
    } catch (e: any) {
      toast.error(t("changePassword.failed") + ": " + e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Lock className="h-5 w-5" />
            {t("changePassword.cardTitle")}
          </CardTitle>
          <CardDescription>
            {t("changePassword.cardDesc")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4" noValidate autoComplete="off">
            <FormField label={t("changePassword.currentPassword")} required>
              <Input
                type="password"
                autoComplete="current-password"
                placeholder={t("changePassword.currentPasswordPlaceholder")}
                value={formData.currentPassword}
                onChange={(e) =>
                  setFormData({ ...formData, currentPassword: e.target.value })
                }
                required
                autoFocus
              />
            </FormField>

            <FormField label={t("changePassword.newPassword")} required hint={t("changePassword.newPasswordHint")}>
              <Input
                type="password"
                autoComplete="new-password"
                placeholder={t("changePassword.newPasswordPlaceholder")}
                value={formData.newPassword}
                onChange={(e) =>
                  setFormData({ ...formData, newPassword: e.target.value })
                }
                required
                minLength={8}
              />
            </FormField>

            <FormField label={t("changePassword.confirmPassword")} required>
              <Input
                type="password"
                autoComplete="new-password"
                placeholder={t("changePassword.confirmPasswordPlaceholder")}
                value={formData.confirmPassword}
                onChange={(e) =>
                  setFormData({ ...formData, confirmPassword: e.target.value })
                }
                required
                minLength={8}
              />
            </FormField>

            <div className="flex justify-end gap-2 pt-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setFormData({
                    currentPassword: "",
                    newPassword: "",
                    confirmPassword: "",
                  });
                }}
              >
                {t("changePassword.resetBtn")}
              </Button>
              <Button type="submit" disabled={saving}>
                <Save className="h-4 w-4 mr-2" />
                {saving ? t("changePassword.savingBtn") : t("changePassword.saveBtn")}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
