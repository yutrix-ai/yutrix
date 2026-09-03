import { useState, useEffect } from "react";
import { fetchApi } from "../lib/api";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import {
  CheckCircle2,
  Database,
  Globe,
  Key,
  ShieldCheck,
  User,
  ArrowRight,
  ArrowLeft,
  RefreshCw,
  Server,
  AlertCircle
} from "lucide-react";

export default function Setup() {
  const { t, i18n } = useTranslation();
  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [testingDb, setTestingDb] = useState(false);
  const [dbTestResult, setDbTestResult] = useState<{ ok: boolean; message?: string; error?: string } | null>(null);

  // Form State
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [mainDomain, setMainDomain] = useState(
    typeof window !== "undefined" ? window.location.host : "localhost:3000"
  );
  const [secret, setSecret] = useState("");
  const [driver, setDriver] = useState<"sqlite" | "postgres">("sqlite");
  const [sqliteFile, setSqliteFile] = useState("data/promptgate.sqlite");
  const [databaseUrl, setDatabaseUrl] = useState("postgres://yutrix:yutrix_test_pass@127.0.0.1:5432/yutrix");
  const [siteTitle, setSiteTitle] = useState("Yutrix");

  // Check setup status on load
  useEffect(() => {
    fetchApi("/setup/status")
      .then((data) => {
        if (!data.fresh) {
          toast.info(t("setup.alreadyCompleted", "系统已完成安装配置，正在跳转到登录页..."));
          setTimeout(() => {
            window.location.href = "/login";
          }, 1000);
        } else if (data.driver) {
          setDriver(data.driver);
        }
      })
      .catch(() => {});
  }, [t]);

  // Generate random 32-byte (64 hex characters) secret
  const generateSecret = () => {
    const array = new Uint8Array(32);
    crypto.getRandomValues(array);
    const hex = Array.from(array)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    setSecret(hex);
    toast.success(t("setup.secretGenerated", "已生成 32 字节安全密钥"));
  };

  useEffect(() => {
    if (!secret) {
      generateSecret();
    }
  }, []);

  const handleTestDatabase = async () => {
    setTestingDb(true);
    setDbTestResult(null);
    try {
      const res = await fetchApi("/setup/test-db", {
        method: "POST",
        body: JSON.stringify({
          driver,
          sqliteFile: driver === "sqlite" ? sqliteFile : undefined,
          databaseUrl: driver === "postgres" ? databaseUrl : undefined,
        }),
      });
      setDbTestResult({ ok: true, message: res.message || "连接成功" });
      toast.success(res.message || "数据库连接测试成功");
    } catch (err: any) {
      setDbTestResult({ ok: false, error: err.message || "连接失败" });
      toast.error(err.message || "数据库连接测试失败");
    } finally {
      setTestingDb(false);
    }
  };

  const validateStep = (currentStep: number): boolean => {
    if (currentStep === 2) {
      if (!username.trim()) {
        toast.error(t("setup.usernameRequired", "请输入管理员用户名"));
        return false;
      }
      if (!password || password.length < 8) {
        toast.error(t("setup.passwordMinLength", "管理员密码至少需要 8 个字符"));
        return false;
      }
      if (password !== confirmPassword) {
        toast.error(t("setup.passwordMismatch", "两次输入的密码不一致"));
        return false;
      }
    }
    if (currentStep === 3) {
      if (!mainDomain.trim()) {
        toast.error(t("setup.domainRequired", "请输入系统主访问域名"));
        return false;
      }
    }
    if (currentStep === 4) {
      if (!secret || secret.length < 16) {
        toast.error(t("setup.secretMinLength", "密钥长度至少需要 16 个字符"));
        return false;
      }
    }
    if (currentStep === 5) {
      if (driver === "postgres" && !databaseUrl.trim()) {
        toast.error(t("setup.pgUrlRequired", "请输入 PostgreSQL 数据库连接串"));
        return false;
      }
    }
    return true;
  };

  const nextStep = () => {
    if (validateStep(step)) {
      setStep((s) => s + 1);
    }
  };

  const prevStep = () => {
    setStep((s) => Math.max(1, s - 1));
  };

  const handleCompleteSetup = async () => {
    if (!validateStep(5)) return;

    setLoading(true);
    try {
      const payload = {
        username: username.trim(),
        password,
        mainDomain: mainDomain.trim(),
        secret: secret.trim(),
        driver,
        sqliteFile: driver === "sqlite" ? sqliteFile.trim() : undefined,
        databaseUrl: driver === "postgres" ? databaseUrl.trim() : undefined,
        siteTitle: siteTitle.trim() || "Yutrix",
      };

      const res = await fetchApi("/setup/complete", {
        method: "POST",
        body: JSON.stringify(payload),
      });

      if (res.token) {
        localStorage.setItem("token", res.token);
      }

      toast.success(t("setup.completeSuccess", "系统初始化完成！即将进入控制台..."));
      setTimeout(() => {
        window.location.href = "/";
      }, 1200);
    } catch (err: any) {
      toast.error(err.message || t("setup.completeFailed", "初始化失败，请检查配置并重试"));
      setLoading(false);
    }
  };

  const stepsHeader = [
    { num: 1, title: t("setup.stepLang", "语言 / Language"), icon: Globe },
    { num: 2, title: t("setup.stepAdmin", "管理员账号"), icon: User },
    { num: 3, title: t("setup.stepDomain", "主域名"), icon: Server },
    { num: 4, title: t("setup.stepSecret", "安全密钥"), icon: Key },
    { num: 5, title: t("setup.stepDatabase", "数据库配置"), icon: Database },
    { num: 6, title: t("setup.stepConfirm", "确认并初始化"), icon: ShieldCheck },
  ];

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-br from-primary/5 via-background to-primary/10 p-4 relative">
      <div className="absolute top-4 right-4">
        <LanguageSwitcher />
      </div>

      <div className="w-full max-w-2xl">
        {/* Title */}
        <div className="text-center mb-6">
          <h1 className="text-3xl font-bold tracking-tight text-primary">Yutrix Setup Wizard</h1>
          <p className="text-muted-foreground mt-1">
            {t("setup.subtitle", "首次安装初始化向导 · 轻松配置您的 AI 智能路由网关")}
          </p>
        </div>

        {/* Step Indicator */}
        <div className="grid grid-cols-6 gap-2 mb-6">
          {stepsHeader.map((s) => {
            const Icon = s.icon;
            const isCompleted = step > s.num;
            const isCurrent = step === s.num;
            return (
              <div
                key={s.num}
                className={`flex flex-col items-center p-2 rounded-lg text-center transition-all ${
                  isCurrent
                    ? "bg-primary text-primary-foreground font-semibold shadow"
                    : isCompleted
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground opacity-50"
                }`}
              >
                <Icon className="w-5 h-5 mb-1" />
                <span className="text-xs hidden sm:inline">{s.title}</span>
              </div>
            );
          })}
        </div>

        {/* Step Content */}
        <Card className="shadow-2xl">
          <CardHeader>
            <CardTitle>{stepsHeader[step - 1].title}</CardTitle>
            <CardDescription>
              {step === 1 && t("setup.descLang", "选择您首选的控制台显示语言。")}
              {step === 2 && t("setup.descAdmin", "设置系统最高权限管理员账号及登录密码。")}
              {step === 3 && t("setup.descDomain", "配置网关主域名，用于路由鉴权与 CORS 跨域安全配置。")}
              {step === 4 && t("setup.descSecret", "设置主加密密钥 PROMPTGATE_SECRET，用于机密配置加密保护。")}
              {step === 5 && t("setup.descDatabase", "选择数据库引擎：嵌入式 SQLite 快速开箱即用，或 PostgreSQL 高并发部署。")}
              {step === 6 && t("setup.descConfirm", "确认所有配置参数，点击立即完成数据库初始化与系统引导。")}
            </CardDescription>
          </CardHeader>

          <CardContent className="space-y-4">
            {/* Step 1: Language */}
            {step === 1 && (
              <div className="space-y-4 py-4">
                <Label>{t("setup.selectLanguage", "选择系统语言 / Select Language")}</Label>
                <div className="grid grid-cols-2 gap-4">
                  <Button
                    type="button"
                    variant={i18n.language.startsWith("zh") ? "default" : "outline"}
                    className="h-20 flex flex-col items-center justify-center space-y-1"
                    onClick={() => i18n.changeLanguage("zh-CN")}
                  >
                    <span className="text-lg font-bold">简体中文</span>
                    <span className="text-xs opacity-75">Chinese (Simplified)</span>
                  </Button>
                  <Button
                    type="button"
                    variant={i18n.language.startsWith("en") ? "default" : "outline"}
                    className="h-20 flex flex-col items-center justify-center space-y-1"
                    onClick={() => i18n.changeLanguage("en-US")}
                  >
                    <span className="text-lg font-bold">English</span>
                    <span className="text-xs opacity-75">English (US)</span>
                  </Button>
                </div>
              </div>
            )}

            {/* Step 2: Admin Account */}
            {step === 2 && (
              <div className="space-y-4 py-2">
                <div className="space-y-2">
                  <Label htmlFor="admin-username">{t("setup.username", "管理员用户名")}</Label>
                  <Input
                    id="admin-username"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="admin"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="admin-password">{t("setup.password", "管理员密码")}</Label>
                  <Input
                    id="admin-password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="admin-confirm-password">{t("setup.confirmPassword", "确认密码")}</Label>
                  <Input
                    id="admin-confirm-password"
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="••••••••"
                  />
                </div>
              </div>
            )}

            {/* Step 3: Main Domain */}
            {step === 3 && (
              <div className="space-y-4 py-2">
                <div className="space-y-2">
                  <Label htmlFor="main-domain">{t("setup.mainDomain", "系统主域名 (Main Domain)")}</Label>
                  <Input
                    id="main-domain"
                    value={mainDomain}
                    onChange={(e) => setMainDomain(e.target.value)}
                    placeholder="e.g. pg.example.com or localhost:3000"
                  />
                  <p className="text-xs text-muted-foreground">
                    {t("setup.mainDomainHint", "用于生成子域名路由与跨域访问校验，例如 gateway.yourdomain.com")}
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="site-title">{t("setup.siteTitle", "站点标题")}</Label>
                  <Input
                    id="site-title"
                    value={siteTitle}
                    onChange={(e) => setSiteTitle(e.target.value)}
                    placeholder="Yutrix AI Gateway"
                  />
                </div>
              </div>
            )}

            {/* Step 4: Secret Key */}
            {step === 4 && (
              <div className="space-y-4 py-2">
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="system-secret">PROMPTGATE_SECRET</Label>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={generateSecret}
                      className="text-xs flex items-center gap-1"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                      {t("setup.regenerateSecret", "重新生成")}
                    </Button>
                  </div>
                  <Input
                    id="system-secret"
                    value={secret}
                    onChange={(e) => setSecret(e.target.value)}
                    placeholder="32-byte hex master encryption secret"
                    className="font-mono text-xs"
                  />
                  <p className="text-xs text-muted-foreground">
                    {t(
                      "setup.secretWarning",
                      "请妥善保存该密钥。系统使用该密钥加密保存上游提供商 API Key。迁移数据库或多实例时必须保持一致。"
                    )}
                  </p>
                </div>
              </div>
            )}

            {/* Step 5: Database */}
            {step === 5 && (
              <div className="space-y-4 py-2">
                <Label>{t("setup.selectDbEngine", "选择数据库引擎")}</Label>
                <div className="grid grid-cols-2 gap-4">
                  <Button
                    type="button"
                    variant={driver === "sqlite" ? "default" : "outline"}
                    className="h-20 flex flex-col items-center justify-center space-y-1"
                    onClick={() => {
                      setDriver("sqlite");
                      setDbTestResult(null);
                    }}
                  >
                    <span className="text-base font-bold">SQLite</span>
                    <span className="text-xs opacity-75">本地轻量级文件存储</span>
                  </Button>
                  <Button
                    type="button"
                    variant={driver === "postgres" ? "default" : "outline"}
                    className="h-20 flex flex-col items-center justify-center space-y-1"
                    onClick={() => {
                      setDriver("postgres");
                      setDbTestResult(null);
                    }}
                  >
                    <span className="text-base font-bold">PostgreSQL</span>
                    <span className="text-xs opacity-75">高并发企业级数据库</span>
                  </Button>
                </div>

                {driver === "sqlite" && (
                  <div className="space-y-2 pt-2">
                    <Label htmlFor="sqlite-file">{t("setup.sqliteFile", "SQLite 文件路径")}</Label>
                    <Input
                      id="sqlite-file"
                      value={sqliteFile}
                      onChange={(e) => setSqliteFile(e.target.value)}
                      placeholder="data/promptgate.sqlite"
                    />
                  </div>
                )}

                {driver === "postgres" && (
                  <div className="space-y-2 pt-2">
                    <Label htmlFor="pg-url">{t("setup.databaseUrl", "PostgreSQL 连接 URL")}</Label>
                    <Input
                      id="pg-url"
                      value={databaseUrl}
                      onChange={(e) => setDatabaseUrl(e.target.value)}
                      placeholder="postgres://user:password@host:5432/dbname"
                    />
                  </div>
                )}

                <div className="flex items-center gap-3 pt-2">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={handleTestDatabase}
                    disabled={testingDb}
                  >
                    {testingDb && <RefreshCw className="w-3.5 h-3.5 mr-1 animate-spin" />}
                    {t("setup.testConnection", "测试连接")}
                  </Button>
                  {dbTestResult && (
                    <span
                      className={`text-xs flex items-center gap-1 ${
                        dbTestResult.ok ? "text-green-600 font-medium" : "text-destructive"
                      }`}
                    >
                      {dbTestResult.ok ? (
                        <CheckCircle2 className="w-4 h-4" />
                      ) : (
                        <AlertCircle className="w-4 h-4" />
                      )}
                      {dbTestResult.ok ? dbTestResult.message : dbTestResult.error}
                    </span>
                  )}
                </div>
              </div>
            )}

            {/* Step 6: Confirm */}
            {step === 6 && (
              <div className="space-y-4 py-2">
                <div className="rounded-lg border bg-muted/40 p-4 space-y-2 text-sm">
                  <div className="flex justify-between border-b pb-2">
                    <span className="text-muted-foreground">{t("setup.adminUser", "管理员账号")}:</span>
                    <span className="font-medium">{username}</span>
                  </div>
                  <div className="flex justify-between border-b pb-2">
                    <span className="text-muted-foreground">{t("setup.mainDomain", "主域名")}:</span>
                    <span className="font-medium">{mainDomain}</span>
                  </div>
                  <div className="flex justify-between border-b pb-2">
                    <span className="text-muted-foreground">{t("setup.dbEngine", "数据库类型")}:</span>
                    <span className="font-medium uppercase">{driver}</span>
                  </div>
                  <div className="flex justify-between border-b pb-2">
                    <span className="text-muted-foreground">{t("setup.targetLocation", "存储位置")}:</span>
                    <span className="font-medium font-mono text-xs">
                      {driver === "sqlite" ? sqliteFile : databaseUrl.replace(/:[^:@]+@/, ":****@")}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{t("setup.secretStatus", "主密钥")}:</span>
                    <span className="font-mono text-xs">
                      {secret.substring(0, 8)}...{secret.substring(secret.length - 8)}
                    </span>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground text-center">
                  {t(
                    "setup.confirmNote",
                    "点击下方按钮将创建数据表、初始化管理员账号并应用安全配置。安装完成后向导将自动关闭。"
                  )}
                </p>
              </div>
            )}
          </CardContent>

          <CardFooter className="flex justify-between border-t pt-4">
            {step > 1 ? (
              <Button type="button" variant="outline" onClick={prevStep} disabled={loading}>
                <ArrowLeft className="w-4 h-4 mr-1" />
                {t("setup.prev", "上一步")}
              </Button>
            ) : (
              <div />
            )}

            {step < 6 ? (
              <Button type="button" onClick={nextStep}>
                {t("setup.next", "下一步")}
                <ArrowRight className="w-4 h-4 ml-1" />
              </Button>
            ) : (
              <Button
                type="button"
                onClick={handleCompleteSetup}
                disabled={loading}
                className="bg-primary text-primary-foreground font-semibold px-6"
              >
                {loading ? (
                  <>
                    <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                    {t("setup.initializing", "正在初始化系统...")}
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="w-4 h-4 mr-1" />
                    {t("setup.completeButton", "完成安装并启动系统")}
                  </>
                )}
              </Button>
            )}
          </CardFooter>
        </Card>
      </div>
    </div>
  );
}
