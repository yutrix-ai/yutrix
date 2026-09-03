import { useState, useEffect, useRef } from "react";
import { fetchEventSource } from "@microsoft/fetch-event-source";
import { getAuthHeaders } from "@/lib/api";
import { useAuth } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Play, Pause, Trash2, Download, Terminal, Copy, SlidersHorizontal } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { renderActionLogLine } from "@/utils/actionLogRenderer";
import { cn } from "@/lib/utils";

type LogLevel = "信息" | "警告" | "错误";

type ActionLogEntry = {
  timestamp: string;
  level: LogLevel | "INFO" | "WARN" | "ERROR";
  line?: string;
  serverLine?: string;
  requestId?: string;
  code?: string;
  params?: any;
};

function parseLegacyLog(line: string): ActionLogEntry {
  const match = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) (信息|警告|错误) /);
  return {
    timestamp: match?.[1] || new Date().toISOString(),
    level: (match?.[2] as LogLevel) || "信息",
    line,
    requestId: line.match(/\brequestId=([^\s]+)/)?.[1],
  };
}

export default function Logs() {
  const { user } = useAuth();
  const [logs, setLogs] = useState<ActionLogEntry[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [showServerRaw, setShowServerRaw] = useState(false);
  const [filter, setFilter] = useState("");
  const [requestIdFilter, setRequestIdFilter] = useState("");
  const [levelFilter, setLevelFilter] = useState<"全部" | LogLevel | "INFO" | "WARN" | "ERROR">("全部");
  const [maxLogs, setMaxLogs] = useState(1000);
  const [streamError, setStreamError] = useState("");
  const [disabledMessage, setDisabledMessage] = useState("");
  const [showMobileFilters, setShowMobileFilters] = useState(false);
  const { t } = useTranslation();
  const terminalRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    startStreaming();
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!autoScroll || !terminalRef.current) return;

    const frame = requestAnimationFrame(() => {
      if (terminalRef.current) {
        terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
      }
    });

    return () => cancelAnimationFrame(frame);
  }, [logs, autoScroll, filter, requestIdFilter, levelFilter]);

  const appendLog = (entry: ActionLogEntry) => {
    setLogs((prev) => {
      const next = [...prev, entry];
      return next.length > maxLogs ? next.slice(next.length - maxLogs) : next;
    });
  };

  const startStreaming = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setStreamError("");
    setDisabledMessage("");

    const ctrl = new AbortController();
    abortControllerRef.current = ctrl;
    setIsStreaming(true);

    // Native EventSource cannot set Authorization headers and relies solely on cookies,
    // which fail behind Docker / reverse proxies. Using fetchEventSource ensures Bearer
    // token from localStorage/sessionStorage is sent along with credentials: 'include'.
    void fetchEventSource("/api/admin/logs/stream", {
      method: "GET",
      headers: getAuthHeaders(),
      credentials: "include",
      signal: ctrl.signal,
      openWhenHidden: true,
      async onopen(response) {
        if (response.ok && response.headers.get("content-type")?.startsWith("text/event-stream")) {
          setStreamError("");
        } else {
          setStreamError(t("logs.actions.streamFailed", "实时日志连接失败，请检查服务是否运行或重新登录。"));
          setIsStreaming(false);
          throw new Error("Failed to connect to SSE stream");
        }
      },
      onmessage(msg) {
        if (ctrl.signal.aborted) return;
        if (msg.event === "disabled") {
          try {
            const data = JSON.parse(msg.data);
            setDisabledMessage(data.message || t("logs.actions.streamDisabled", "实时日志已关闭"));
          } catch {
            setDisabledMessage(t("logs.actions.streamDisabled", "实时日志已关闭"));
          }
          setIsStreaming(false);
          ctrl.abort();
          return;
        }

        if (msg.event === "ping") {
          setStreamError("");
          return;
        }

        try {
          const data = JSON.parse(msg.data);
          if (data.line || data.serverLine || data.code) {
            appendLog(data);
          } else if (data.text) {
            appendLog(parseLegacyLog(data.text));
          }
        } catch {
          appendLog(parseLegacyLog(msg.data));
        }
      },
      onerror(err) {
        if (ctrl.signal.aborted) return;
        setStreamError(t("logs.actions.streamFailed", "实时日志连接失败，请检查服务是否运行或重新登录。"));
        setIsStreaming(false);
        throw err;
      },
    }).catch(() => {
      if (ctrl.signal.aborted) return;
      setIsStreaming(false);
      if (abortControllerRef.current === ctrl) {
        abortControllerRef.current = null;
      }
    });
  };

  const stopStreaming = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setIsStreaming(false);
    toast.info(t("logs.actions.pausedToast", "已暂停实时日志"));
  };

  const clearLogs = () => {
    setLogs([]);
    toast.info(t("logs.actions.clearSuccess", "日志已清空"));
  };

  const copyLogs = async () => {
    await navigator.clipboard.writeText(filteredLogs.map((log) => renderActionLogLine(log, showServerRaw)).join("\n"));
    toast.success(t("logs.actions.copySuccess", "已复制当前筛选日志"));
  };

  const downloadLogs = () => {
    const data = filteredLogs.map((log) => renderActionLogLine(log, showServerRaw)).join("\n");
    const blob = new Blob([data], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `promptgate-logs-${new Date().toISOString()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(t("logs.actions.downloadSuccess", "日志已下载"));
  };



  const filteredLogs = logs.filter((log) => {
    const renderedLine = renderActionLogLine(log, showServerRaw);
    const keywordMatched = !filter || renderedLine.toLowerCase().includes(filter.toLowerCase());
    const levelMatchMap: Record<string, string> = { "全部": "全部", "信息": "INFO", "警告": "WARN", "错误": "ERROR", "INFO": "INFO", "WARN": "WARN", "ERROR": "ERROR" };
    
    let isLevelMatched = false;
    if (levelFilter === "全部") {
      isLevelMatched = true;
    } else {
      const normLogLvl = levelMatchMap[log.level] || "INFO";
      const normFilterLvl = levelMatchMap[levelFilter] || "INFO";
      isLevelMatched = normLogLvl === normFilterLvl;
    }
    
    const reqId = log.params?.requestId || log.requestId;
    const requestIdMatched =
      !requestIdFilter ||
      (reqId || renderedLine).toLowerCase().includes(requestIdFilter.toLowerCase());
    return keywordMatched && isLevelMatched && requestIdMatched;
  });

  const getLogColor = (log: ActionLogEntry) => {
    const renderedLine = renderActionLogLine(log, showServerRaw);
    if (log.level === "错误" || log.level === "ERROR") return "text-red-400";
    if (log.level === "警告" || log.level === "WARN" || renderedLine.includes("触发降级") || renderedLine.includes("Fallback triggered")) return "text-yellow-400";
    if (renderedLine.includes("请求完成") || renderedLine.includes("Request completed")) return "text-green-400";
    if (renderedLine.includes("请求入队") || renderedLine.includes("请求出队") || renderedLine.includes("queued") || renderedLine.includes("dequeued")) return "text-blue-400";
    return "text-gray-300";
  };

  const emptyText = disabledMessage
    ? disabledMessage
    : streamError || t("logs.actions.noLogsText", "暂无实时日志。触发一次请求后，这里会显示系统动作。");

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-hidden">
      <Card className="shrink-0">
        <CardContent className="grid gap-3 p-3 xl:grid-cols-[minmax(200px,1fr)_140px_180px_auto_auto_auto_auto] xl:items-center">
          <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between xl:contents">
            <div className="flex flex-1 gap-2">
              <Input
                placeholder={t("logs.filters.keywordPlaceholder", "关键词过滤")}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                className="flex-1"
              />
              <Button
                variant="outline"
                onClick={() => setShowMobileFilters(!showMobileFilters)}
                className="xl:hidden shrink-0 h-9 px-3"
                title={t("logs.filters.moreFilters", "更多筛选")}
              >
                <SlidersHorizontal className="h-4 w-4 mr-1.5" />
                {showMobileFilters ? t("logs.filters.hideFilters", "收起") : t("logs.filters.moreFilters", "筛选")}
              </Button>
            </div>

            <div className="flex items-center justify-between xl:justify-end gap-2 w-full xl:w-auto">
              <div className="flex items-center gap-2 w-full xl:w-auto">
                <Button
                  size="sm"
                  variant={isStreaming ? "destructive" : "default"}
                  onClick={isStreaming ? stopStreaming : startStreaming}
                  className="flex-1 xl:flex-none h-9"
                >
                  {isStreaming ? (
                    <>
                      <Pause className="h-4 w-4 mr-1.5" />
                      {t("logs.actions.stop", "停止")}
                    </>
                  ) : (
                    <>
                      <Play className="h-4 w-4 mr-1.5" />
                      {t("logs.actions.start", "开始")}
                    </>
                  )}
                </Button>
                <div className="flex gap-1 shrink-0">
                  <Button variant="outline" size="sm" onClick={clearLogs} className="h-9 w-9 p-0" title={t("logs.actions.clear", "清空日志")}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                  <Button variant="outline" size="sm" onClick={copyLogs} className="h-9 w-9 p-0" title={t("logs.actions.copy", "复制当前筛选日志")}>
                    <Copy className="h-4 w-4" />
                  </Button>
                  <Button variant="outline" size="sm" onClick={downloadLogs} className="h-9 w-9 p-0" title={t("logs.actions.download", "下载当前筛选日志")}>
                    <Download className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </div>
          </div>

          <div className={cn(
            "grid gap-3 grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:contents",
            showMobileFilters ? "grid" : "hidden xl:contents"
          )}>
            <Select value={levelFilter} onValueChange={(value) => setLevelFilter(value as typeof levelFilter)}>
              <SelectTrigger>
                <SelectValue placeholder={t("logs.filters.level", "级别")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="全部">{t("logs.filters.allLevels", "全部级别")}</SelectItem>
                <SelectItem value="信息">{t("logs.filters.info", "信息")}</SelectItem>
                <SelectItem value="警告">{t("logs.filters.warn", "警告")}</SelectItem>
                <SelectItem value="错误">{t("logs.filters.error", "错误")}</SelectItem>
              </SelectContent>
            </Select>

            <Input
              placeholder={t("logs.filters.requestIdPlaceholder", "requestId 搜索")}
              value={requestIdFilter}
              onChange={(e) => setRequestIdFilter(e.target.value)}
            />

            <div className="flex items-center gap-2 border rounded-md px-3 h-9 bg-background/50">
              <Switch
                id="autoScroll"
                checked={autoScroll}
                onCheckedChange={setAutoScroll}
              />
              <Label htmlFor="autoScroll" className="cursor-pointer select-none flex-1 text-sm font-medium">{t("logs.filters.autoScroll", "自动滚动")}</Label>
            </div>

            <div className="flex items-center gap-2 border rounded-md px-3 h-9 bg-background/50">
              <Switch
                id="showServerRaw"
                checked={showServerRaw}
                onCheckedChange={setShowServerRaw}
              />
              <Label htmlFor="showServerRaw" className="cursor-pointer select-none flex-1 text-sm font-medium">{t("logs.filters.serverLogs", "服务器日志")}</Label>
            </div>

            <div className="flex items-center gap-2 border rounded-md px-3 h-9 bg-background/50">
              <Label className="whitespace-nowrap text-sm font-medium text-muted-foreground">{t("logs.filters.keep", "保留")}</Label>
              <Input
                type="number"
                min="100"
                max="10000"
                value={maxLogs}
                onChange={(e) => setMaxLogs(parseInt(e.target.value) || 1000)}
                className="h-7 border-none bg-transparent focus-visible:ring-0 focus-visible:ring-offset-0 px-1 py-0 flex-1 text-right font-mono"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950 shadow-xl">
        <div className="bg-zinc-900 border-b border-zinc-800 px-4 py-2 flex items-center gap-2 shrink-0">
          <div className="flex gap-1.5">
            <div className="w-3 h-3 rounded-full bg-red-500/80"></div>
            <div className="w-3 h-3 rounded-full bg-yellow-500/80"></div>
            <div className="w-3 h-3 rounded-full bg-green-500/80"></div>
          </div>
          <div className="text-xs text-zinc-500 font-mono ml-2">actionLogger ~ stream</div>
        </div>
        <div
          ref={terminalRef}
          className="min-h-0 flex-1 overflow-y-auto p-4 font-mono text-xs md:text-sm leading-relaxed"
        >
          {filteredLogs.length === 0 ? (
            <div className="text-zinc-500 h-full flex flex-col items-center justify-center gap-2 text-center">
              <Terminal className="h-12 w-12 opacity-50" />
              <p>{emptyText}</p>
            </div>
          ) : (
            <div className="flex flex-col gap-1 whitespace-pre-wrap break-all">
              {filteredLogs.map((log, index) => (
                <div key={`${log.timestamp}-${index}`} className={`${getLogColor(log)} hover:bg-white/5 px-1 rounded transition-colors`}>
                  {renderActionLogLine(log, showServerRaw)}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
