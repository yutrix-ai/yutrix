import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { fetchApi, API_BASE } from "../../lib/api";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import {
  Database,
  Download,
  Server,
  RefreshCw,
  CheckCircle2,
  AlertCircle,
  ArrowRight,
  ShieldAlert,
  Info,
} from "lucide-react";

interface DatabaseInfo {
  driver: "sqlite" | "postgres";
  sqlite?: {
    file: string;
    resolvedPath: string;
    sizeBytes: number;
    sizeFormatted: string;
    exists: boolean;
  };
  postgres?: {
    urlMasked: string;
    database: string;
    connected: boolean;
  };
  maintenance: boolean;
}

interface MigrateStatus {
  inProgress: boolean;
  stage: string;
  currentTable?: string;
  totalRows: number;
  copiedRows: number;
  error?: string;
  completedAt?: string;
}

export function DatabaseSettings() {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [dbInfo, setDbInfo] = useState<DatabaseInfo | null>(null);

  // SQLite backup download state
  const [backupPassword, setBackupPassword] = useState("");
  const [downloadingBackup, setDownloadingBackup] = useState(false);

  // PostgreSQL migration state
  const [targetPgUrl, setTargetPgUrl] = useState("");
  const [testingConnection, setTestingConnection] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message?: string; error?: string } | null>(null);
  const [migrating, setMigrating] = useState(false);
  const [migrateStatus, setMigrateStatus] = useState<MigrateStatus | null>(null);
  const [migrationSuccess, setMigrationSuccess] = useState(false);

  const loadDatabaseInfo = async () => {
    try {
      setLoading(true);
      const data = await fetchApi("/settings/database");
      setDbInfo(data);
    } catch (err: any) {
      toast.error(t("settings.database.loadFailed", "加载数据库信息失败") + ": " + err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadDatabaseInfo();
  }, []);

  // Poll migration progress if migrating
  useEffect(() => {
    let interval: any = null;
    if (migrating) {
      interval = setInterval(async () => {
        try {
          const status: MigrateStatus = await fetchApi("/settings/database/migrate-status");
          setMigrateStatus(status);
          if (!status.inProgress) {
            setMigrating(false);
            if (status.stage === "completed") {
              setMigrationSuccess(true);
              toast.success(t("settings.database.migrateSuccess", "迁移到 PostgreSQL 成功！请重启服务。"));
              loadDatabaseInfo();
            } else if (status.stage === "failed") {
              toast.error(t("settings.database.migrateFailed", "迁移失败") + ": " + (status.error || "未知错误"));
            }
          }
        } catch {
          // Ignore polling errors
        }
      }, 1000);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [migrating, t]);

  const handleDownloadBackup = async () => {
    if (!backupPassword) {
      toast.error(t("settings.database.backupPasswordRequired", "请输入备份下载密码 (DB_BACKUP_PASSWORD)"));
      return;
    }

    setDownloadingBackup(true);
    try {
      const token = localStorage.getItem("token") || sessionStorage.getItem("token");
      const res = await fetch(`${API_BASE}/admin/database/download`, {
        headers: {
          Authorization: token ? `Bearer ${token}` : "",
          "x-backup-password": backupPassword,
        },
      });

      if (!res.ok) {
        let errMsg = "下载备份失败";
        try {
          const data = await res.json();
          errMsg = data.error || errMsg;
        } catch {
          // ignore
        }
        throw new Error(errMsg);
      }

      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `promptgate_backup_${new Date().toISOString().slice(0, 10)}.sqlite`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
      toast.success(t("settings.database.backupDownloadSuccess", "SQLite 备份下载已启动"));
      setBackupPassword("");
    } catch (err: any) {
      toast.error(err.message || t("settings.database.backupDownloadFailed", "下载失败"));
    } finally {
      setDownloadingBackup(false);
    }
  };

  const handleTestPgConnection = async () => {
    if (!targetPgUrl.trim()) {
      toast.error(t("settings.database.pgUrlRequired", "请输入 PostgreSQL 连接串"));
      return;
    }

    setTestingConnection(true);
    setTestResult(null);
    try {
      const res = await fetchApi("/settings/database/test", {
        method: "POST",
        body: JSON.stringify({ databaseUrl: targetPgUrl.trim() }),
      });
      setTestResult({ ok: true, message: res.message || "连接测试成功" });
      toast.success(res.message || "PostgreSQL 连接测试成功");
    } catch (err: any) {
      setTestResult({ ok: false, error: err.message || "连接失败" });
      toast.error(err.message || "PostgreSQL 连接测试失败");
    } finally {
      setTestingConnection(false);
    }
  };

  const handleStartMigration = async () => {
    if (!targetPgUrl.trim()) {
      toast.error(t("settings.database.pgUrlRequired", "请输入 PostgreSQL 连接串"));
      return;
    }

    const confirmed = window.confirm(
      t(
        "settings.database.confirmMigrate",
        "确定要开始迁移到 PostgreSQL 吗？\n\n系统将自动进入维护模式并排空运行中的请求，完成所有数据表的结构与全量数据拷贝。迁移完成后需要手动重启服务进程生效。原 SQLite 数据库文件将原样保留。"
      )
    );
    if (!confirmed) return;

    setMigrating(true);
    setMigrationSuccess(false);
    setMigrateStatus({
      inProgress: true,
      stage: "preparing",
      totalRows: 0,
      copiedRows: 0,
    });

    try {
      fetchApi("/settings/database/migrate-to-pg", {
        method: "POST",
        body: JSON.stringify({ databaseUrl: targetPgUrl.trim() }),
      }).catch((err: any) => {
        setMigrating(false);
        toast.error(err.message || "迁移启动失败");
      });
    } catch (err: any) {
      setMigrating(false);
      toast.error(err.message || "迁移启动失败");
    }
  };

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Database className="w-5 h-5 text-primary" />
            {t("settings.database.title", "数据库管理")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-sm text-muted-foreground">{t("common.loading", "加载中...")}</div>
        </CardContent>
      </Card>
    );
  }

  const isSqlite = dbInfo?.driver === "sqlite";

  return (
    <Card className="min-w-0">
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg flex items-center gap-2">
            <Database className="w-5 h-5 text-primary" />
            {t("settings.database.title", "数据库管理")}
          </CardTitle>
          <Badge variant={isSqlite ? "secondary" : "default"} className="uppercase font-mono">
            {dbInfo?.driver || "UNKNOWN"}
          </Badge>
        </div>
        <CardDescription>
          {t("settings.database.desc", "查看当前数据库存储引擎、备份配置及单向迁移操作。")}
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-6">
        {/* Current Database Info */}
        <div className="rounded-lg border bg-muted/30 p-4 space-y-3">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">{t("settings.database.driverLabel", "当前驱动引擎")}:</span>
            <span className="font-semibold uppercase flex items-center gap-1.5">
              <Server className="w-4 h-4 text-primary" />
              {dbInfo?.driver}
            </span>
          </div>

          {isSqlite && dbInfo?.sqlite && (
            <>
              <div className="flex items-center justify-between text-sm border-t pt-2">
                <span className="text-muted-foreground">{t("settings.database.filePath", "SQLite 数据库文件")}:</span>
                <span className="font-mono text-xs text-foreground font-medium">
                  {dbInfo.sqlite.file}
                </span>
              </div>
              <div className="flex items-center justify-between text-sm border-t pt-2">
                <span className="text-muted-foreground">{t("settings.database.fileSize", "文件大小")}:</span>
                <span className="font-mono text-xs text-foreground font-medium">
                  {dbInfo.sqlite.sizeFormatted}
                </span>
              </div>
            </>
          )}

          {!isSqlite && dbInfo?.postgres && (
            <>
              <div className="flex items-center justify-between text-sm border-t pt-2">
                <span className="text-muted-foreground">{t("settings.database.pgDbName", "数据库名称")}:</span>
                <span className="font-mono text-xs text-foreground font-medium">
                  {dbInfo.postgres.database}
                </span>
              </div>
              <div className="flex items-center justify-between text-sm border-t pt-2">
                <span className="text-muted-foreground">{t("settings.database.pgConnection", "连接地址")}:</span>
                <span className="font-mono text-xs text-foreground font-medium">
                  {dbInfo.postgres.urlMasked}
                </span>
              </div>
            </>
          )}
        </div>

        {/* PostgreSQL Active Notice */}
        {!isSqlite && (
          <div className="rounded-lg border border-blue-200 bg-blue-50 dark:border-blue-900 dark:bg-blue-950/40 p-4 flex gap-3 text-sm text-blue-800 dark:text-blue-300">
            <Info className="w-5 h-5 flex-shrink-0 text-blue-600 dark:text-blue-400 mt-0.5" />
            <div className="space-y-1">
              <p className="font-medium">
                {t("settings.database.pgBackupNoticeTitle", "PostgreSQL 数据库备份说明")}
              </p>
              <p className="text-xs text-blue-700 dark:text-blue-400">
                {t(
                  "settings.database.pgBackupNotice",
                  "系统当前运行于 PostgreSQL 引擎上。PostgreSQL 数据库备份请使用标准的 pg_dump 工具（如 pg_dump -U yutrix -d yutrix > backup.sql）或云服务商的自动快照备份功能。"
                )}
              </p>
            </div>
          </div>
        )}

        {/* SQLite Backup Download (Only visible when driver is SQLite) */}
        {isSqlite && (
          <div className="border rounded-lg p-4 space-y-3">
            <h4 className="text-sm font-semibold flex items-center gap-2">
              <Download className="w-4 h-4 text-primary" />
              {t("settings.database.downloadBackupTitle", "下载 SQLite 数据库备份")}
            </h4>
            <p className="text-xs text-muted-foreground">
              {t(
                "settings.database.downloadBackupDesc",
                "需要通过环境变量 DB_BACKUP_PASSWORD 设置密钥以保护下载安全。"
              )}
            </p>
            <div className="flex flex-col sm:flex-row gap-3 items-stretch sm:items-center">
              <Input
                type="password"
                name="db-backup-password"
                autoComplete="off"
                data-lpignore="true"
                data-1p-ignore="true"
                placeholder={t("settings.database.backupPasswordPlaceholder", "输入 DB_BACKUP_PASSWORD")}
                value={backupPassword}
                onChange={(e) => setBackupPassword(e.target.value)}
                className="sm:max-w-xs text-sm"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleDownloadBackup}
                disabled={downloadingBackup}
                className="flex items-center gap-1.5"
              >
                {downloadingBackup ? (
                  <RefreshCw className="w-4 h-4 animate-spin" />
                ) : (
                  <Download className="w-4 h-4" />
                )}
                {t("settings.database.downloadButton", "下载备份")}
              </Button>
            </div>
          </div>
        )}

        {/* SQLite -> PostgreSQL Migration Section (Only visible when driver is SQLite) */}
        {isSqlite && (
          <div className="border rounded-lg p-4 space-y-4 bg-muted/10">
            <div className="space-y-1">
              <h4 className="text-sm font-semibold flex items-center gap-2 text-primary">
                <ArrowRight className="w-4 h-4" />
                {t("settings.database.migrateTitle", "单向迁移到 PostgreSQL")}
              </h4>
              <p className="text-xs text-muted-foreground">
                {t(
                  "settings.database.migrateDesc",
                  "将当前 SQLite 数据完整无缝地拷贝至独立的 PostgreSQL 数据库。迁移过程保持业务字段与密钥不变，原 SQLite 文件完整保留。"
                )}
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="target-pg-url" className="text-xs">
                {t("settings.database.targetPgUrl", "目标 PostgreSQL 连接串 (DATABASE_URL)")}
              </Label>
              <Input
                id="target-pg-url"
                value={targetPgUrl}
                onChange={(e) => setTargetPgUrl(e.target.value)}
                placeholder="postgres://user:password@host:5432/dbname"
                className="font-mono text-xs"
                disabled={migrating}
              />
            </div>

            {/* Test Connection and Action Buttons */}
            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={handleTestPgConnection}
                disabled={testingConnection || migrating}
                className="text-xs"
              >
                {testingConnection && <RefreshCw className="w-3.5 h-3.5 mr-1 animate-spin" />}
                {t("settings.database.testConnection", "测试连接")}
              </Button>

              {testResult && (
                <span
                  className={`text-xs flex items-center gap-1 ${
                    testResult.ok ? "text-green-600 font-medium" : "text-destructive"
                  }`}
                >
                  {testResult.ok ? (
                    <CheckCircle2 className="w-3.5 h-3.5" />
                  ) : (
                    <AlertCircle className="w-3.5 h-3.5" />
                  )}
                  {testResult.ok ? testResult.message : testResult.error}
                </span>
              )}

              <div className="flex-1" />

              <Button
                type="button"
                variant="default"
                size="sm"
                onClick={handleStartMigration}
                disabled={migrating || !targetPgUrl.trim()}
                className="bg-primary text-primary-foreground text-xs"
              >
                {migrating ? (
                  <>
                    <RefreshCw className="w-3.5 h-3.5 mr-1 animate-spin" />
                    {t("settings.database.migrating", "正在迁移中...")}
                  </>
                ) : (
                  <>
                    <ArrowRight className="w-3.5 h-3.5 mr-1" />
                    {t("settings.database.startMigrate", "开始迁移到 PostgreSQL")}
                  </>
                )}
              </Button>
            </div>

            {/* Migration Progress Bar */}
            {migrating && migrateStatus && (
              <div className="rounded-lg border bg-background p-4 space-y-3">
                <div className="flex justify-between text-xs font-medium">
                  <span>
                    {migrateStatus.stage === "preparing" && "准备迁移环境与连接目标库..."}
                    {migrateStatus.stage === "migrating_pg" && "正在目标 PostgreSQL 建立数据表与索引..."}
                    {migrateStatus.stage === "copying_tables" &&
                      `正在复制数据表 [${migrateStatus.currentTable || ""}]...`}
                    {migrateStatus.stage === "verifying" && "正在校验行数与数据一致性..."}
                  </span>
                  <span>
                    {migrateStatus.copiedRows} / {migrateStatus.totalRows} 行
                  </span>
                </div>
                <div className="w-full bg-muted rounded-full h-2.5 overflow-hidden">
                  <div
                    className="bg-primary h-2.5 rounded-full transition-all duration-300"
                    style={{
                      width: `${
                        migrateStatus.totalRows > 0
                          ? Math.min(100, Math.round((migrateStatus.copiedRows / migrateStatus.totalRows) * 100))
                          : 10
                      }%`,
                    }}
                  />
                </div>
              </div>
            )}

            {/* Success Alert */}
            {migrationSuccess && (
              <div className="rounded-lg border border-green-300 bg-green-50 dark:border-green-800 dark:bg-green-950/40 p-4 space-y-2 text-sm text-green-900 dark:text-green-200">
                <div className="flex items-center gap-2 font-semibold">
                  <CheckCircle2 className="w-5 h-5 text-green-600 dark:text-green-400" />
                  {t("settings.database.migrateCompleteTitle", "数据迁移圆满完成！")}
                </div>
                <p className="text-xs text-green-800 dark:text-green-300 leading-relaxed">
                  {t(
                    "settings.database.migrateCompleteNotice",
                    "所有数据表及配置已成功导入 PostgreSQL，新配置已写入 data/yutrix.config.json。请立即重启服务端进程（例如 docker restart yutrix 或 pm2 restart）以正式启用 PostgreSQL。"
                  )}
                </p>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
