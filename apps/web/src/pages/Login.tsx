import { useState } from "react";
import { useAuth } from "../lib/store";
import { fetchApi } from "../lib/api";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/FormField";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { Checkbox } from "@/components/ui/checkbox";
import { useSettings } from "../contexts/SettingsContext";

export default function Login() {
  const { t } = useTranslation();
  const { systemName, systemSlogan, systemLogoUrl } = useSettings();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(true);
  const [loading, setLoading] = useState(false);
  const { setUser } = useAuth();

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      const data = await fetchApi("/auth/login", {
        method: "POST",
        body: JSON.stringify({ username, password }),
      });

      if (rememberMe) {
        localStorage.setItem("token", data.token);
      } else {
        sessionStorage.setItem("token", data.token);
      }
      setUser(data.user);
      toast.success(t("login.success", "登录成功"));
      window.location.href = "/";
    } catch (err: any) {
      toast.error(err.message || t("login.failed", "登录失败，请重试"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-full flex flex-col items-center justify-center bg-gradient-to-br from-primary/5 via-background to-primary/10 p-4 relative">
      <div className="absolute top-4 right-4">
        <LanguageSwitcher />
      </div>
      <Card className="w-full max-w-md shadow-2xl">
        <CardHeader className="space-y-3 text-center">
          <div className="mx-auto flex items-center justify-center mb-2">
            <img src={systemLogoUrl} alt="Logo" className="w-16 h-16" />
          </div>
          <CardTitle className="text-3xl font-bold text-primary">
            {systemName}
          </CardTitle>
          <CardDescription className="text-base">
            {systemSlogan || t("login.subtitle", "轻量级 LLM 网关控制台")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleLogin} className="space-y-5">
            <FormField label={t("login.username", "用户名")} required>
              <Input
                placeholder={t("login.usernamePlaceholder", "请输入用户名")}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                disabled={loading}
                required
                autoFocus
              />
            </FormField>

            <FormField label={t("login.password", "密码")} required>
              <Input
                type="password"
                placeholder={t("login.passwordPlaceholder", "请输入密码")}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={loading}
                required
              />
            </FormField>

            <div className="flex items-center space-x-2">
              <Checkbox
                id="remember"
                checked={rememberMe}
                onCheckedChange={(checked: boolean | "indeterminate") => setRememberMe(checked === true)}
              />
              <Label
                htmlFor="remember"
                className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer"
              >
                {t("login.rememberMe", "保持登录状态")}
              </Label>
            </div>

            <Button
              type="submit"
              className="w-full"
              size="lg"
              disabled={loading}
            >
              {loading ? t("login.loggingIn", "登录中...") : t("login.loginButton", "登录")}
            </Button>
          </form>

          <div className="mt-6 text-center text-sm text-muted-foreground">
            <p>{t("login.contactAdmin", "如需注册账号，请联系管理员获取邀请码")}</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
