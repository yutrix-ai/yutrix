import { Card } from "@/components/ui/card";
import { MessagesSquare } from "lucide-react";
import { cn } from "@/lib/utils";
import { renderClientBadge, extractPromptSummary, formatRelativeTime } from "./ChatLogUtils";

export function ChatLogSidebar({
  sessions,
  selectedSessionId,
  setSelectedSessionId,
  setSelectedTurnId,
  isLoadingMore,
  handleScroll,
  availableUsers,
  t,
  conversationScrollRef,
  scrollPositionsRef,
  autoScrollEnabledRef
}: any) {
  return (
    <Card className="col-span-1 md:col-span-3 flex flex-col overflow-hidden shadow-sm border-muted">
      <div className="p-3 border-b bg-muted/30 font-semibold text-sm flex items-center gap-2 text-muted-foreground">
        <MessagesSquare className="w-4 h-4" /> {t("chatLogs.sessions")}
      </div>
      <div className="flex-1 p-2 overflow-y-auto custom-scrollbar" onScroll={handleScroll}>
        <div className="flex flex-col gap-1">
          <div 
            onClick={() => {
              setSelectedSessionId("LIVE");
              setSelectedTurnId(null);
              setTimeout(() => {
                if (conversationScrollRef.current) {
                  const savedPosition = scrollPositionsRef.current["LIVE"];
                  if (autoScrollEnabledRef.current) {
                    conversationScrollRef.current.scrollTop = 0;
                  } else if (savedPosition !== undefined) {
                    conversationScrollRef.current.scrollTop = savedPosition;
                  } else {
                    conversationScrollRef.current.scrollTop = 0;
                  }
                }
              }, 50);
            }}
            className={cn(
              "p-3 rounded-lg cursor-pointer transition-colors border border-transparent",
              selectedSessionId === "LIVE" ? "bg-red-50 text-red-900 border-red-100 dark:bg-red-950/30 dark:text-red-200 dark:border-red-900/50" : "hover:bg-accent"
            )}
          >
            <div className="flex items-center gap-2 font-semibold text-sm">
              <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse"></div>
              {t("chatLogs.liveStreamAll")}
            </div>
          </div>

          <div className="my-2 border-t"></div>

          {sessions.map((s: any, i: number) => (
            <div 
              key={i} 
              onClick={() => {
                setSelectedSessionId(s.serverSessionId);
                setSelectedTurnId(null);
              }}
              className={cn(
                "p-3 rounded-lg cursor-pointer transition-all border relative overflow-hidden group",
                selectedSessionId === s.serverSessionId ? "bg-primary/5 border-primary/20" : "border-transparent hover:bg-accent"
              )}
            >
              {s.detectedClient && (
                <div className={cn(
                  "absolute left-0 top-0 bottom-0 w-[3px] transition-all duration-300",
                  s.detectedClient.toLowerCase().includes("claude code") ? "bg-amber-500" :
                  s.detectedClient.toLowerCase().includes("cursor") ? "bg-indigo-500" :
                  s.detectedClient.toLowerCase().includes("xcode") ? "bg-blue-500" :
                  s.detectedClient.toLowerCase().includes("opencode") ? "bg-emerald-500" :
                  s.detectedClient.toLowerCase().includes("augment") ? "bg-pink-500" :
                  s.detectedClient.toLowerCase().includes("vscode") ? "bg-sky-500" :
                  s.detectedClient.toLowerCase().includes("jetbrains") ? "bg-rose-500" : "bg-violet-500"
                )} />
              )}
              <div className={cn("flex items-center justify-between mb-1 min-w-0", s.detectedClient ? "pl-1.5" : "")}>
                <span 
                  className={cn(
                    "font-medium pr-2 truncate",
                    s.sessionTitle ? "text-sm text-foreground" : "text-sm text-foreground/80"
                  )}
                  title={s.sessionTitle || extractPromptSummary(s.firstInputText)}
                >
                  {s.sessionTitle || extractPromptSummary(s.firstInputText)}
                </span>
                <div className="flex items-center gap-1.5 shrink-0">
                  {s.detectedClient && renderClientBadge(s.detectedClient, "sm")}
                  <span className="text-xs bg-muted px-1.5 py-0.5 rounded text-muted-foreground shrink-0">{t("chatLogs.turnsCount", { count: s.turnCount })}</span>
                </div>
              </div>
              <div className={cn("flex items-center gap-1.5 text-xs text-muted-foreground mt-1", s.detectedClient ? "pl-1.5" : "")}>
                <span className="font-medium text-blue-600 dark:text-blue-400 truncate max-w-[100px]">
                  {availableUsers.find((u: any) => u.id === s.userId && u.username !== u.id)?.username || s.userId || 'Unknown'}
                </span>
                <span>•</span>
                <span className="shrink-0">{formatRelativeTime(s.lastUpdatedAt, t)}</span>
              </div>
            </div>
          ))}
          {sessions.length === 0 && (
            <div className="p-4 text-center text-muted-foreground text-sm">{t("chatLogs.noHistoricalSessions")}</div>
          )}
          {isLoadingMore && (
            <div className="p-4 text-center text-muted-foreground text-sm flex items-center justify-center gap-2">
              <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin"></div>
              {t("chatLogs.loading", "加载中...")}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
