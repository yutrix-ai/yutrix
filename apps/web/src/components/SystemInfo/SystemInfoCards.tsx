import { useState, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { HardDrive, Cpu, MemoryStick, Box, Database, Network } from "lucide-react";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from "recharts";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Download, Loader2 } from "lucide-react";
import { API_BASE } from "@/lib/api";
import { toast } from "sonner";

export function CpuCard({ systemInfo, history }: any) {
  const { t } = useTranslation();
  const cpuModel = systemInfo?.system?.cpuModel || "Unknown";
  const cpuCores = systemInfo?.system?.cpuCores || 1;
  const cpuUsage = systemInfo?.system?.cpuUsage ?? 0;

  return (
    <Card className="shadow-sm flex flex-col h-[310px]">
      <CardHeader className="pb-1.5 pt-4 border-b border-border/50">
        <CardTitle className="flex items-center justify-between text-base">
          <span className="flex items-center gap-1.5">
            <Cpu className="h-4 w-4 text-purple-500" />
            {t("settings.sections.systemInfo.cpu", "处理器 (CPU)")}
          </span>
          <Badge variant="outline" className="text-purple-600 dark:text-purple-400 border-purple-200 dark:border-purple-900/50 text-xs py-0 px-1.5">
            {cpuUsage}%
          </Badge>
        </CardTitle>
        <CardDescription className="text-xs truncate mt-0.5" title={cpuModel}>
          {cpuModel} • {cpuCores} Cores
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-3 pb-3 flex-1 flex flex-col min-h-0">
        {history.length > 0 ? (
          <div className="flex-1 min-h-0 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={history} margin={{ top: 5, right: 5, left: -25, bottom: 0 }}>
                <defs>
                  <linearGradient id="cpuGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#8b5cf6" stopOpacity={0.25} />
                    <stop offset="95%" stopColor="#8b5cf6" stopOpacity={0.01} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-border)" />
                <XAxis dataKey="time" tick={{ fontSize: 10, fill: "#64748b" }} axisLine={false} tickLine={false} />
                <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: "#64748b" }} axisLine={false} tickLine={false} />
                <Tooltip
                  contentStyle={{ background: "var(--color-popover)", border: "1px solid var(--color-border)", borderRadius: "6px", fontSize: "12px", color: "var(--color-foreground)" }}
                  labelClassName="text-xs font-semibold text-slate-500 dark:text-slate-400"
                  formatter={(val: any) => [`${val}%`, t("settings.sections.systemInfo.utilization", "利用率")]}
                />
                <Area type="monotone" dataKey="cpuUsage" stroke="#8b5cf6" strokeWidth={1.5} fill="url(#cpuGrad)" dot={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
            {t("settings.sections.systemInfo.waitingForData", "等待数据收集...")}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function MemoryCard({ systemInfo, formatBytes }: any) {
  const { t } = useTranslation();
  const totalMem = systemInfo?.system?.totalMemory || 1;
  const freeMem = systemInfo?.system?.freeMemory || 0;
  const usedMem = totalMem - freeMem;
  const memUsagePct = Math.min(100, Math.round((usedMem / totalMem) * 100));

  const memPieData = [
    { name: t("settings.sections.systemInfo.usedMemory", "已用内存"), value: usedMem, color: "#10b981" },
    { name: t("settings.sections.systemInfo.freeMemory", "空闲内存"), value: freeMem, color: "#e2e8f0" },
  ];

  return (
    <Card className="shadow-sm flex flex-col h-[310px]">
      <CardHeader className="pb-1.5 pt-4 border-b border-border/50">
        <CardTitle className="flex items-center justify-between text-base">
          <span className="flex items-center gap-1.5">
            <MemoryStick className="h-4 w-4 text-emerald-500" />
            {t("settings.sections.systemInfo.memory", "内存 (Memory)")}
          </span>
          <Badge variant="outline" className="text-emerald-600 border-emerald-200 text-xs py-0 px-1.5">
            {memUsagePct}%
          </Badge>
        </CardTitle>
        <CardDescription className="text-xs mt-0.5 truncate">
          {t("settings.sections.systemInfo.usedTotal", "已用: {{used}} / 总量: {{total}}", { used: formatBytes(usedMem), total: formatBytes(totalMem) })}
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-3 pb-3 flex-1 flex flex-col items-center justify-center relative min-h-0">
        <div className="w-full h-[130px] flex items-center justify-center relative">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={memPieData} cx="50%" cy="50%" innerRadius={40} outerRadius={55} paddingAngle={3} dataKey="value">
                {memPieData.map((entry, index) => <Cell key={`cell-${index}`} fill={entry.color} />)}
              </Pie>
            </PieChart>
          </ResponsiveContainer>
          <div className="absolute flex flex-col items-center justify-center">
            <span className="text-xl font-bold text-slate-800 dark:text-slate-200 leading-none">{memUsagePct}%</span>
            <span className="text-xs text-muted-foreground font-semibold mt-0.5">{t("settings.sections.systemInfo.used", "已使用")}</span>
          </div>
        </div>
        <div className="w-full grid grid-cols-2 gap-2 mt-1 border-t pt-2 text-center">
          <div>
            <span className="text-xs font-semibold text-muted-foreground block uppercase">{t("settings.sections.systemInfo.used", "已使用")}</span>
            <span className="text-sm font-bold text-emerald-600 dark:text-emerald-400">{formatBytes(usedMem)}</span>
          </div>
          <div>
            <span className="text-xs font-semibold text-muted-foreground block uppercase">{t("settings.sections.systemInfo.free", "空闲量")}</span>
            <span className="text-sm font-bold text-slate-500 dark:text-slate-400">{formatBytes(freeMem)}</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function DiskCard({ systemInfo, formatBytes }: any) {
  const { t } = useTranslation();
  const diskTotal = systemInfo?.system?.disk?.total || 1;
  const diskUsed = systemInfo?.system?.disk?.used || 0;
  const diskFree = systemInfo?.system?.disk?.free || 0;
  const diskUsagePct = Math.min(100, Math.round((diskUsed / diskTotal) * 100));

  const diskPieData = [
    { name: t("settings.sections.systemInfo.usedDisk", "已用磁盘"), value: diskUsed, color: "#f59e0b" },
    { name: t("settings.sections.systemInfo.freeDisk", "空闲磁盘"), value: diskFree, color: "#e2e8f0" },
  ];

  return (
    <Card className="shadow-sm flex flex-col h-[310px]">
      <CardHeader className="pb-1.5 pt-4 border-b border-border/50">
        <CardTitle className="flex items-center justify-between text-base">
          <span className="flex items-center gap-1.5">
            <HardDrive className="h-4 w-4 text-amber-500" />
            {t("settings.sections.systemInfo.disk", "磁盘 (Disk)")}
          </span>
          <Badge variant="outline" className="text-amber-600 dark:text-amber-400 border-amber-200 dark:border-amber-900/50 text-xs py-0 px-1.5">
            {diskUsagePct}%
          </Badge>
        </CardTitle>
        <CardDescription className="text-xs mt-0.5 truncate">
          {t("settings.sections.systemInfo.usedTotal", "已用: {{used}} / 总量: {{total}}", { used: formatBytes(diskUsed), total: formatBytes(diskTotal) })}
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-3 pb-3 flex-1 flex flex-col items-center justify-center relative min-h-0">
        <div className="w-full h-[130px] flex items-center justify-center relative">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={diskPieData} cx="50%" cy="50%" innerRadius={40} outerRadius={55} paddingAngle={3} dataKey="value">
                {diskPieData.map((entry, index) => <Cell key={`cell-${index}`} fill={entry.color} />)}
              </Pie>
            </PieChart>
          </ResponsiveContainer>
          <div className="absolute flex flex-col items-center justify-center">
            <span className="text-xl font-bold text-slate-800 dark:text-slate-200 leading-none">{diskUsagePct}%</span>
            <span className="text-xs text-muted-foreground font-semibold mt-0.5">{t("settings.sections.systemInfo.used", "已使用")}</span>
          </div>
        </div>
        <div className="w-full grid grid-cols-2 gap-2 mt-1 border-t pt-2 text-center">
          <div>
            <span className="text-xs font-semibold text-muted-foreground block uppercase">{t("settings.sections.systemInfo.used", "已使用")}</span>
            <span className="text-sm font-bold text-amber-600 dark:text-amber-400">{formatBytes(diskUsed)}</span>
          </div>
          <div>
            <span className="text-xs font-semibold text-muted-foreground block uppercase">{t("settings.sections.systemInfo.free", "空闲量")}</span>
            <span className="text-sm font-bold text-slate-500 dark:text-slate-400">{formatBytes(diskFree)}</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function NetworkCard({ networkInterfaces, selectedInterface, setSelectedInterface, activeNetInfo, history, formatBytes, formatSpeed }: any) {
  const { t } = useTranslation();
  const networkChartData = history.map((pt: any) => ({
    time: pt.time,
    rxSpeed: pt.speeds[selectedInterface]?.rxSpeed ?? 0,
    txSpeed: pt.speeds[selectedInterface]?.txSpeed ?? 0,
  }));

  return (
    <Card className="shadow-sm flex flex-col h-[310px]">
      <CardHeader className="pb-1.5 pt-4 border-b border-border/50">
        <CardTitle className="flex items-center justify-between text-base">
          <span className="flex items-center gap-1.5">
            <Network className="h-4 w-4 text-sky-500" />
            {t("settings.sections.systemInfo.network", "网络 (Network)")}
          </span>
          {networkInterfaces.length > 0 && (
            <div className="w-28 shrink-0">
              <Select value={selectedInterface} onValueChange={setSelectedInterface}>
                <SelectTrigger className="h-7 text-xs py-0.5 px-2">
                  <SelectValue placeholder={t("settings.sections.systemInfo.selectInterface", "选择网卡")} />
                </SelectTrigger>
                <SelectContent>
                  {networkInterfaces.map((iface: string) => (
                    <SelectItem key={iface} value={iface} className="text-xs">{iface}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </CardTitle>
        <CardDescription className="text-xs mt-0.5 truncate">
          {activeNetInfo ? (
            <span>{t("settings.sections.systemInfo.networkTotal", "发送: {{sent}} • 接收: {{received}}", { sent: formatBytes(activeNetInfo.bytesOut), received: formatBytes(activeNetInfo.bytesIn) })}</span>
          ) : t("settings.sections.systemInfo.noNetworkData", "暂无网卡数据")}
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-3 pb-3 flex-1 flex flex-col min-h-0">
        {activeNetInfo && history.length > 0 ? (
          <div className="flex-1 min-h-0 w-full flex flex-col">
            <div className="flex justify-between items-center gap-2 mb-1.5 text-xs font-mono px-1">
              <div className="flex items-center gap-1">
                <div className="h-1.5 w-1.5 rounded-full bg-sky-500" />
                <span>In: {formatSpeed(history[history.length - 1]?.speeds[selectedInterface]?.rxSpeed ?? 0)}</span>
              </div>
              <div className="flex items-center gap-1">
                <div className="h-1.5 w-1.5 rounded-full bg-rose-500" />
                <span>Out: {formatSpeed(history[history.length - 1]?.speeds[selectedInterface]?.txSpeed ?? 0)}</span>
              </div>
            </div>
            <div className="flex-1 min-h-0 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={networkChartData} margin={{ top: 5, right: 5, left: -25, bottom: 0 }}>
                  <defs>
                    <linearGradient id="rxGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#3b82f6" stopOpacity={0.2} /><stop offset="95%" stopColor="#3b82f6" stopOpacity={0.01} /></linearGradient>
                    <linearGradient id="txGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#f43f5e" stopOpacity={0.2} /><stop offset="95%" stopColor="#f43f5e" stopOpacity={0.01} /></linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-border)" />
                  <XAxis dataKey="time" tick={{ fontSize: 10, fill: "#64748b" }} axisLine={false} tickLine={false} />
                  <YAxis tickFormatter={formatSpeed} tick={{ fontSize: 10, fill: "#64748b" }} axisLine={false} tickLine={false} />
                  <Tooltip
                    contentStyle={{ background: "var(--color-popover)", border: "1px solid var(--color-border)", borderRadius: "6px", fontSize: "12px", color: "var(--color-foreground)" }}
                    labelClassName="text-xs font-semibold text-slate-500 dark:text-slate-400"
                    formatter={(val: any, name?: any) => [formatSpeed(val), name === "rxSpeed" ? t("settings.sections.systemInfo.downloadSpeed", "下载速率") : t("settings.sections.systemInfo.uploadSpeed", "上传速率")]}
                  />
                  <Area type="monotone" dataKey="rxSpeed" stroke="#3b82f6" strokeWidth={1.5} fill="url(#rxGrad)" dot={false} />
                  <Area type="monotone" dataKey="txSpeed" stroke="#f43f5e" strokeWidth={1.5} fill="url(#txGrad)" dot={false} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">{t("settings.sections.systemInfo.waitingForData", "等待数据收集...")}</div>
        )}
      </CardContent>
    </Card>
  );
}

export function SoftwareEnvCard({ systemInfo }: any) {
  const { t } = useTranslation();
  return (
    <Card className="shadow-sm flex flex-col h-[310px]">
      <CardHeader className="pb-1.5 pt-4 border-b border-border/50">
        <CardTitle className="flex items-center gap-1.5 text-base">
          <Box className="h-4 w-4 text-indigo-500" />
          {t("settings.sections.systemInfo.softwareEnv", "软件环境 (Software Env)")}
        </CardTitle>
        <CardDescription className="text-xs mt-0.5">
          {t("settings.sections.systemInfo.softwareEnvDesc", "运行系统及 Runtime 属性")}
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-3 pb-3 flex-1 flex flex-col justify-center min-h-0 text-sm">
        <div className="space-y-2.5">
          <div className="flex justify-between items-center py-1 border-b border-dashed border-border/80">
            <span className="font-semibold text-muted-foreground">{t("settings.sections.systemInfo.os", "操作系统")}</span>
            <span className="font-medium font-mono text-slate-700 dark:text-slate-300 capitalize">
              {systemInfo.system.platform} ({systemInfo.system.arch})
            </span>
          </div>
          <div className="flex justify-between items-center py-1 border-b border-dashed border-border/80">
            <span className="font-semibold text-muted-foreground">{t("settings.sections.systemInfo.osRelease", "系统内核版本")}</span>
            <span className="font-medium font-mono text-slate-700 dark:text-slate-300 max-w-[180px] truncate" title={systemInfo.system.osRelease}>{systemInfo.system.osRelease}</span>
          </div>
          <div className="flex justify-between items-center py-1 border-b border-dashed border-border/80">
            <span className="font-semibold text-muted-foreground">{t("settings.sections.systemInfo.nodeVersion", "Node.js 版本")}</span>
            <span className="font-bold text-indigo-600 dark:text-indigo-400 font-mono">{systemInfo.app.nodeVersion}</span>
          </div>
          <div className="flex justify-between items-center py-1 border-b border-dashed border-border/80">
            <span className="font-semibold text-muted-foreground">{t("settings.sections.systemInfo.runMode", "运行模式")}</span>
            <Badge variant="secondary" className="capitalize text-[10px] font-semibold py-0 px-1.5">{systemInfo.app.environment}</Badge>
          </div>
          <div className="flex justify-between items-center py-1 border-b border-dashed border-border/80">
            <span className="font-semibold text-muted-foreground">{t("settings.sections.systemInfo.hostname", "主机名")}</span>
            <span className="font-medium font-mono text-slate-700 dark:text-slate-300 truncate max-w-[180px]" title={systemInfo.system.hostname}>{systemInfo.system.hostname}</span>
          </div>
          <div className="flex justify-between items-center py-1">
            <span className="font-semibold text-muted-foreground">{t("settings.sections.systemInfo.runUser", "当前运行用户")}</span>
            <span className="font-medium text-slate-700 dark:text-slate-300 font-mono">{systemInfo.system.user}</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function DatabaseCard({ dbInfo, backupPassword, setBackupPassword, downloading, setDownloading }: any) {
  const { t } = useTranslation();
  return (
    <Card className="shadow-sm flex flex-col h-[310px]">
      <CardHeader className="pb-1.5 pt-4 border-b border-border/50">
        <CardTitle className="flex items-center gap-1.5 text-base">
          <Database className="h-4 w-4 text-blue-500" />
          {t("settings.sections.systemInfo.dbInfo", "数据库信息 (Database Info)")}
        </CardTitle>
        <CardDescription className="text-xs mt-0.5">
          {t("settings.sections.systemInfo.dbInfoDesc", "本地 SQLite 数据库状态")}
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-3 pb-3 flex-1 flex flex-col justify-between min-h-0 text-sm">
        {dbInfo ? (
          <div className="flex flex-col h-full justify-between">
            <div className="flex justify-between items-center bg-slate-50 dark:bg-slate-900/40 p-2 rounded border border-slate-100 dark:border-slate-800/60">
              <div>
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-0.5">{t("settings.sections.systemInfo.dbSize", "数据库容量")}</p>
                <p className="text-2xl font-black text-slate-800 dark:text-slate-100 leading-none">{dbInfo.sizeFormatted}</p>
              </div>
              <Badge className="bg-blue-50 dark:bg-blue-950/40 text-blue-600 dark:text-blue-400 border-blue-200 dark:border-blue-900/50 py-0.5 px-1.5 text-xs font-semibold" variant="outline">SQLite 3</Badge>
            </div>
            <div className="space-y-1 mt-2">
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider block">{t("settings.sections.systemInfo.dbPath", "物理存储路径")}</span>
              <div className="flex items-center gap-2 bg-slate-50 dark:bg-slate-900/40 p-2 rounded border border-slate-100 dark:border-slate-800/60">
                <div className="relative flex h-1.5 w-1.5 shrink-0"><span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span><span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-500"></span></div>
                <p className="text-xs font-mono truncate text-slate-600 dark:text-slate-300 flex-1" title={dbInfo.path}>{dbInfo.path}</p>
              </div>
            </div>
            {dbInfo.isBackupPasswordSet ? (
              <div className="pt-2 space-y-1.5">
                <Input type="password" placeholder={t("settings.sections.systemInfo.dbBackupPasswordPlaceholder", "输入验证密码以激活下载")} value={backupPassword} onChange={(e) => setBackupPassword(e.target.value)} className="h-8 text-xs bg-slate-50/50 dark:bg-slate-900/20 border-slate-200/80 dark:border-slate-800/80 focus-visible:ring-1 focus-visible:ring-blue-500" />
                <Button className="w-full bg-blue-600 hover:bg-blue-700 text-white shadow-sm h-8 font-medium text-xs" disabled={downloading || !backupPassword.trim()} onClick={async () => {
                  try {
                    setDownloading(true);
                    const token = localStorage.getItem("token") || sessionStorage.getItem("token");
                    const res = await fetch(`${API_BASE}/admin/database/download`, { headers: { Authorization: `Bearer ${token}`, "x-backup-password": backupPassword } });
                    if (!res.ok) {
                      if (res.status === 401) throw new Error(t("settings.sections.systemInfo.dbBackupPasswordInvalid", "密码验证失败，请重新输入"));
                      let errMsg = `HTTP error! status: ${res.status}`;
                      try { const errJson = await res.json(); if (errJson && errJson.error) errMsg = errJson.error; } catch (e) {}
                      throw new Error(errMsg);
                    }
                    const blob = await res.blob();
                    const url = window.URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url; a.download = "promptgate.sqlite";
                    document.body.appendChild(a); a.click(); window.URL.revokeObjectURL(url); document.body.removeChild(a);
                    toast.success(t("settings.sections.database.downloadSuccess", "数据库文件下载成功"));
                  } catch(e: any) { toast.error(t("settings.sections.database.downloadFailed", "下载失败") + ": " + e.message); } finally { setDownloading(false); }
                }}>
                  <Download className="h-3.5 w-3.5 mr-1" />
                  {downloading ? t("settings.sections.systemInfo.downloading", "正在下载...") : t("settings.sections.systemInfo.downloadBackup", "下载数据库备份")}
                </Button>
              </div>
            ) : (
              <div className="mt-2 bg-amber-50/60 dark:bg-amber-950/20 p-2 rounded border border-amber-200/50 dark:border-amber-900/40 flex flex-col justify-center flex-1">
                <p className="text-xs font-semibold text-amber-800 dark:text-amber-400 mb-0.5 flex items-center gap-1">
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse shrink-0"></span>
                  {t("settings.sections.systemInfo.dbBackupDisabled", "数据库备份下载已禁用。")}
                </p>
                <p className="text-[11px] leading-relaxed text-amber-700/95 dark:text-amber-500/90 font-medium">
                  {t("settings.sections.systemInfo.dbBackupDisabledDesc", "若要启用数据库备份下载，请设置 DB_BACKUP_PASSWORD 环境变量。")}
                </p>
              </div>
            )}
          </div>
        ) : <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">{t("settings.sections.systemInfo.dbUnavailable", "数据库信息不可用")}</div>}
      </CardContent>
    </Card>
  );
}

export function OpenCodeCard({ opencodeStatus, onInstall, installing, onSaveProxy }: any) {
  const { t } = useTranslation();
  const [proxy, setProxy] = useState(opencodeStatus?.proxyUrl || "");
  const [savingProxy, setSavingProxy] = useState(false);

  useEffect(() => {
    if (opencodeStatus?.proxyUrl !== undefined) {
      setProxy(opencodeStatus.proxyUrl);
    }
  }, [opencodeStatus?.proxyUrl]);

  const handleSaveProxy = async () => {
    setSavingProxy(true);
    await onSaveProxy(proxy);
    setSavingProxy(false);
  };

  return (
    <Card className="shadow-sm flex flex-col h-[310px]">
      <CardHeader className="pb-1.5 pt-4 border-b border-border/50">
        <CardTitle className="flex items-center justify-between text-base">
          <span className="flex items-center gap-1.5">
            <Box className="h-4 w-4 text-orange-500" />
            {t("settings.sections.systemInfo.opencode", "OpenCode Sidecar")}
          </span>
          {opencodeStatus?.ready ? (
            <Badge variant="outline" className="text-emerald-600 border-emerald-200">
              {opencodeStatus.running ? "Running" : "Installed (Idle)"}
            </Badge>
          ) : (
            <Badge variant="outline" className="text-muted-foreground">
              Not Installed
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-4 flex-1 flex flex-col">
        <div className="flex-1">
          <p className="text-sm text-muted-foreground mb-4 line-clamp-2">
            {t("settings.sections.systemInfo.opencodeDesc", "OpenCode is an open-source coding agent engine. Yutrix uses a loopback sidecar to route requests natively without modifying client applications.")}
          </p>
          <div className="text-xs text-muted-foreground mb-4 space-y-1">
            <div>Version: {opencodeStatus?.version || "N/A"} ({opencodeStatus?.arch || "N/A"})</div>
          </div>
          <div className="flex items-center gap-2 mb-4">
            <Input 
              value={proxy} 
              onChange={e => setProxy(e.target.value)} 
              placeholder="HTTP Proxy (Optional)" 
              className="text-xs h-8"
            />
            <Button size="sm" variant="outline" onClick={handleSaveProxy} disabled={savingProxy} className="h-8">
              {savingProxy ? <Loader2 className="h-3 w-3 animate-spin" /> : "Save Proxy"}
            </Button>
          </div>
        </div>
        <Button onClick={onInstall} disabled={installing} className="w-full shrink-0">
          {installing ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Download className="h-4 w-4 mr-2" />}
          {opencodeStatus?.ready ? t("settings.sections.systemInfo.updateOpencode", "Reinstall / Update") : t("settings.sections.systemInfo.installOpencode", "Install Sidecar")}
        </Button>
      </CardContent>
    </Card>
  );
}
