import { useState, useEffect, type FormEvent } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { HardDrive, Cpu, MemoryStick, Box, Network } from "lucide-react";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from "recharts";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Download, Loader2 } from "lucide-react";

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

function savedOpencodeProxy(proxyUrl: unknown): string {
  return typeof proxyUrl === "string" ? proxyUrl.trim() : "";
}

export function OpenCodeCard({ opencodeStatus, onInstall, installing, onSaveProxy, onSaveAutoUpdate }: any) {
  const { t } = useTranslation();
  const [proxy, setProxy] = useState(() => savedOpencodeProxy(opencodeStatus?.proxyUrl));
  const [savingProxy, setSavingProxy] = useState(false);
  const [savingAutoUpdate, setSavingAutoUpdate] = useState(false);
  const autoUpdate = opencodeStatus?.autoUpdate !== false;

  useEffect(() => {
    setProxy(savedOpencodeProxy(opencodeStatus?.proxyUrl));
  }, [opencodeStatus?.proxyUrl]);

  const handleSaveProxy = async (event?: FormEvent) => {
    event?.preventDefault();
    setSavingProxy(true);
    try {
      await onSaveProxy(proxy.trim());
    } finally {
      setSavingProxy(false);
    }
  };

  const handleAutoUpdateChange = async (enabled: boolean) => {
    if (!onSaveAutoUpdate) return;
    setSavingAutoUpdate(true);
    try {
      await onSaveAutoUpdate(enabled);
    } finally {
      setSavingAutoUpdate(false);
    }
  };

  const statusLabel = !opencodeStatus?.ready
    ? t("settings.sections.systemInfo.opencodeNotInstalled", "未安装")
    : opencodeStatus.running
      ? t("settings.sections.systemInfo.opencodeRunning", "运行中")
      : t("settings.sections.systemInfo.opencodeReadyIdle", "已就绪（空闲）");

  return (
    <Card className="shadow-sm flex flex-col min-h-[310px]">
      <CardHeader className="pb-1.5 pt-4 border-b border-border/50">
        <CardTitle className="flex items-center justify-between text-base">
          <span className="flex items-center gap-1.5">
            <Box className="h-4 w-4 text-orange-500" />
            {t("settings.sections.systemInfo.opencode", "OpenCode Sidecar")}
          </span>
          <Badge variant="outline" className={opencodeStatus?.ready ? "text-emerald-600 border-emerald-200" : "text-muted-foreground"}>
            {statusLabel}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-4 flex-1 flex flex-col min-h-0">
        <div className="flex-1 min-h-0">
          <p className="text-sm text-muted-foreground mb-3 line-clamp-2">
            {t("settings.sections.systemInfo.opencodeDesc", "Yutrix 管理一个 loopback OpenCode sidecar，用于兼容通道；API 客户端不会看到 OpenCode。")}
          </p>
          <div className="text-xs text-muted-foreground mb-2 space-y-0.5">
            <div>{t("settings.sections.systemInfo.opencodeVersion", "版本")}: {opencodeStatus?.version || "N/A"} ({opencodeStatus?.arch || "N/A"})</div>
          </div>
          <div className="flex items-center justify-between gap-3 mb-2">
            <div className="min-w-0">
              <Label htmlFor="opencode-auto-update" className="text-xs">
                {t("settings.sections.systemInfo.opencodeAutoUpdate", "自动更新 Sidecar")}
              </Label>
              <p className="text-[11px] text-muted-foreground leading-snug">
                {t("settings.sections.systemInfo.opencodeAutoUpdateDesc", "默认开启；关闭后仅手动安装/更新")}
              </p>
            </div>
            <Switch
              id="opencode-auto-update"
              checked={autoUpdate}
              disabled={savingAutoUpdate}
              onCheckedChange={handleAutoUpdateChange}
            />
          </div>
          {opencodeStatus?.lastError && (
            <p className="text-[11px] text-rose-600 dark:text-rose-400 mb-2 line-clamp-2" title={opencodeStatus.lastError}>
              {t("settings.sections.systemInfo.opencodeLastError", "最近错误")}: {opencodeStatus.lastError}
            </p>
          )}
          <form
            className="flex items-center gap-2 mb-3"
            autoComplete="off"
            onSubmit={handleSaveProxy}
          >
            <Input
              type="url"
              name="opencode-download-proxy"
              autoComplete="off"
              value={proxy}
              onChange={(e) => setProxy(e.target.value)}
              placeholder={t("settings.sections.systemInfo.opencodeProxyPlaceholder", "下载 HTTP 代理（可选）")}
              className="text-xs h-8"
            />
            <Button type="submit" size="sm" variant="outline" disabled={savingProxy} className="h-8">
              {savingProxy ? <Loader2 className="h-3 w-3 animate-spin" /> : t("settings.sections.systemInfo.opencodeSaveProxy", "保存代理")}
            </Button>
          </form>
        </div>
        <Button onClick={onInstall} disabled={installing} className="w-full shrink-0">
          {installing ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Download className="h-4 w-4 mr-2" />}
          {opencodeStatus?.ready ? t("settings.sections.systemInfo.updateOpencode", "更新/重装 Sidecar") : t("settings.sections.systemInfo.installOpencode", "安装 Sidecar")}
        </Button>
      </CardContent>
    </Card>
  );
}
