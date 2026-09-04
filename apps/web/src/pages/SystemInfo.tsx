import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { fetchApi } from "../lib/api";
import { CpuCard, MemoryCard, DiskCard, NetworkCard, SoftwareEnvCard, DatabaseCard, OpenCodeCard } from "@/components/SystemInfo/SystemInfoCards";
import { API_BASE } from "../lib/api";

interface HistoryPoint {
  time: string;
  cpuUsage: number;
  memoryUsedPct: number;
  speeds: Record<string, { rxSpeed: number; txSpeed: number }>;
  networkRaw: Record<string, { bytesIn: number; bytesOut: number }>;
  timestamp: number;
}

export default function SystemInfo() {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [dbInfo, setDbInfo] = useState<{ path: string; size: number; sizeFormatted: string; isBackupPasswordSet: boolean } | null>(null);
  const [systemInfo, setSystemInfo] = useState<any>(null);
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const [opencodeStatus, setOpencodeStatus] = useState<any>(null);
  const [installingOpencode, setInstallingOpencode] = useState(false);

  const fetchOpencodeStatus = async () => {
    try {
      const res = await fetchApi("/api/admin/opencode/status");
      setOpencodeStatus(res);
    } catch (e) {
      console.error(e);
    }
  };

  const handleInstallOpencode = async () => {
    try {
      setInstallingOpencode(true);
      await fetchApi("/api/admin/opencode/download", { method: "POST" });
      await fetchOpencodeStatus();
    } catch (e) {
      console.error(e);
    } finally {
      setInstallingOpencode(false);
    }
  };

  const handleSaveOpencodeProxy = async (proxyUrl: string) => {
    try {
      await fetchApi("/api/admin/opencode/settings", { 
        method: "POST",
        body: JSON.stringify({ proxyUrl }) 
      });
      await fetchOpencodeStatus();
    } catch (e) {
      console.error(e);
    }
  };
  const [selectedInterface, setSelectedInterface] = useState<string>("");
  const [backupPassword, setBackupPassword] = useState("");
  const [downloading, setDownloading] = useState(false);

  const loadData = async (isFirst = false) => {
    try {
      if (isFirst) setLoading(true);
      const [dbInfoRes, sysInfoRes] = await Promise.all([
        fetchApi("/admin/database/info").catch(() => null),
        fetchApi("/admin/database/system-info").catch(() => null)
      ]);
      
      if (dbInfoRes) {
        setDbInfo(dbInfoRes);
      }
      if (sysInfoRes) {
        setSystemInfo(sysInfoRes);
        
        if (sysInfoRes.system?.network && !selectedInterface) {
          const interfaces = Object.keys(sysInfoRes.system.network);
          if (interfaces.length > 0) {
            setSelectedInterface(interfaces[0]);
          }
        }
        
        // Add to history
        const now = Date.now();
        const timeLabel = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
        const cpuVal = sysInfoRes.system?.cpuUsage ?? 0;
        
        const sysTotalMem = sysInfoRes.system?.totalMemory || 1;
        const sysFreeMem = sysInfoRes.system?.freeMemory || 0;
        const sysUsedMem = sysTotalMem - sysFreeMem;
        const sysMemPct = Math.min(100, Math.round((sysUsedMem / sysTotalMem) * 100));
        
        const currentNet = sysInfoRes.system?.network || {};

        setHistory((prevHistory) => {
          const lastPoint = prevHistory[prevHistory.length - 1];
          const speeds: Record<string, { rxSpeed: number; txSpeed: number }> = {};
          
          if (lastPoint) {
            const timeDiffSec = (now - lastPoint.timestamp) / 1000;
            if (timeDiffSec > 0) {
              Object.keys(currentNet).forEach((iface) => {
                const currentInterface = currentNet[iface];
                const lastInterface = lastPoint.networkRaw[iface];
                if (lastInterface) {
                  const rxDiff = currentInterface.bytesIn - lastInterface.bytesIn;
                  const txDiff = currentInterface.bytesOut - lastInterface.bytesOut;
                  speeds[iface] = {
                    rxSpeed: rxDiff >= 0 ? rxDiff / timeDiffSec : 0,
                    txSpeed: txDiff >= 0 ? txDiff / timeDiffSec : 0,
                  };
                } else {
                  speeds[iface] = { rxSpeed: 0, txSpeed: 0 };
                }
              });
            }
          } else {
            Object.keys(currentNet).forEach((iface) => {
              speeds[iface] = { rxSpeed: 0, txSpeed: 0 };
            });
          }

          const newPoint: HistoryPoint = {
            time: timeLabel,
            cpuUsage: cpuVal,
            memoryUsedPct: sysMemPct,
            speeds,
            networkRaw: currentNet,
            timestamp: now,
          };

          const updated = [...prevHistory, newPoint];
          if (updated.length > 20) {
            return updated.slice(updated.length - 20);
          }
          return updated;
        });
      }
    } catch (e: any) {
      if (isFirst) {
        // toast.error(t("settings.toasts.loadFailed", "加载系统信息失败") + ": " + e.message);
      }
    } finally {
      if (isFirst) setLoading(false);
    }
  };

  useEffect(() => {
    loadData(true);
    fetchOpencodeStatus();
    const interval = setInterval(() => {
      loadData(false);
    }, 3000);
    return () => clearInterval(interval);
  }, []);

  const formatBytes = (bytes: number) => {
    if (!bytes) return "0 B";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  };

  const formatSpeed = (bytesPerSec: number) => {
    if (bytesPerSec === 0) return "0 B/s";
    const k = 1024;
    const sizes = ["B/s", "KB/s", "MB/s", "GB/s"];
    const i = Math.floor(Math.log(bytesPerSec) / Math.log(k));
    return parseFloat((bytesPerSec / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
  };

  const formatUptime = (seconds: number) => {
    const days = Math.floor(seconds / (3600 * 24));
    const hours = Math.floor((seconds % (3600 * 24)) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${days}d ${hours}h ${minutes}m`;
  };

  if (loading) {
    return <div>Loading...</div>;
  }

  return (
    <div className="space-y-4 pb-4 w-full max-w-[1600px] mx-auto">
      <div className="grid gap-6 md:grid-cols-2">
        <CpuCard systemInfo={systemInfo} history={history} />
        <MemoryCard systemInfo={systemInfo} history={history} formatBytes={formatBytes} />
        <DiskCard systemInfo={systemInfo} formatBytes={formatBytes} />
        <NetworkCard 
          networkInterfaces={Object.keys(systemInfo?.system?.network || {})}
          selectedInterface={selectedInterface} 
          setSelectedInterface={setSelectedInterface} 
          activeNetInfo={systemInfo?.system?.network?.[selectedInterface]} 
          history={history} 
          formatBytes={formatBytes} 
          formatSpeed={formatSpeed} 
        />
        <SoftwareEnvCard systemInfo={systemInfo} />
        <OpenCodeCard opencodeStatus={opencodeStatus} onInstall={handleInstallOpencode} installing={installingOpencode} onSaveProxy={handleSaveOpencodeProxy} />
        <DatabaseCard 
          dbInfo={dbInfo} 
          backupPassword={backupPassword} 
          setBackupPassword={setBackupPassword} 
          downloading={downloading} 
          setDownloading={setDownloading} 
        />
      </div>
    </div>
  );
}
