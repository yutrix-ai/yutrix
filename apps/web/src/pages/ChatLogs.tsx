import { useState, useEffect, useRef } from "react";
import { fetchApi } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { useTranslation } from "react-i18next";
import { Terminal, MessagesSquare, Search, Pause, Play, Brain, Clock, Hash, CheckCircle2, XCircle, Copy, Image as ImageIcon, Wrench, ChevronLeft, ChevronUp, ChevronDown, User, Sparkles, Archive, GitBranch } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useTimeRange } from "@/contexts/TimeRangeContext";
import { useAuth } from "@/lib/store";
import { API_BASE } from "@/lib/api";
import { useSettings } from "@/contexts/SettingsContext";
import { parseReasoning, parseAssistantResponse } from "@/utils/chatParser";

import {
  renderClientBadge,
  renderConversationTurn,
  normalizeInputMessages,
  getContentText,
  extractPromptSummary,
  formatRelativeTime,
  cleanRawJsonForDisplay,
  renderContentBlocks,
  renderAssistantContent
} from "@/components/ChatLogs/ChatLogUtils";
import { useChatLogs } from "@/components/ChatLogs/useChatLogs";
import { ChatLogSidebar } from "@/components/ChatLogs/ChatLogSidebar";

export default function ChatLogs() {
  const chatState = useChatLogs();
  const {
    sessions, sessionTurns, liveTurns, filterUserId, setFilterUserId, filterModel, setFilterModel,
    availableUsers, availableModels, selectedSessionId, setSelectedSessionId, selectedTurnId, setSelectedTurnId,
    isStreaming, showRawInput, setShowRawInput, showRawOutput, setShowRawOutput, page, setPage,
    hasMore, isLoadingMore, hoveredTurnIndex, setHoveredTurnIndex, turnRefs, conversationScrollRef,
    turnPositions, scrollContainerStats, activeTurnIndex, setActiveTurnIndex, autoScrollEnabled, setAutoScrollEnabled,
    scrollPositionsRef, handleCacheResponse, fetchSessions, fetchLiveTurns, handleScroll, fetchSessionTurns,
    startStreaming, stopStreaming, scrollToTurn, autoScrollEnabledRef,
    displayedTurns, filteredTurns, selectedTurn, selectedSession, isLiveMode, isConversationView,
    t, formatDateTime, user, setLiveTurns, updateActiveTurnIndex
  } = chatState;
  const detailTitle = selectedTurn
    ? t("chatLogs.turnDetails")
    : selectedSessionId === "LIVE"
      ? t("chatLogs.liveStreamAll")
      : t("chatLogs.conversationReplay", "Conversation Replay");
  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-hidden">
      <Card className="shrink-0 border-none shadow-sm bg-card/50 backdrop-blur">
        <CardContent className="flex flex-col md:flex-row p-4 items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-muted-foreground w-16">{t("chatLogs.user")}</span>
              <select 
                className="flex h-9 w-[180px] items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                value={filterUserId}
                onChange={(e) => setFilterUserId(e.target.value)}
              >
                <option value="">{t("chatLogs.allUsers")}</option>
                {availableUsers.map(u => <option key={u.id} value={u.id}>{u.username || u.id}</option>)}
              </select>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-muted-foreground w-16">{t("chatLogs.model")}</span>
              <select 
                className="flex h-9 w-[180px] items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                value={filterModel}
                onChange={(e) => setFilterModel(e.target.value)}
              >
                <option value="">{t("chatLogs.allModels")}</option>
                {availableModels.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
            <Button onClick={() => { setPage(1); fetchSessions(1, false); if(selectedSessionId === "LIVE") { setLiveTurns([]); fetchLiveTurns(); } }} variant="secondary" size="sm" className="text-sm">
              <Search className="w-4 h-4 mr-2" /> {t("chatLogs.applyFilters")}
            </Button>
          </div>
          
          {selectedSessionId === "LIVE" && (
            <div className="flex items-center gap-2">
              <Button size="sm" variant={isStreaming ? "outline" : "default"} onClick={isStreaming ? stopStreaming : startStreaming} className="text-sm">
                {isStreaming ? <><Pause className="h-4 w-4 mr-1.5" /> {t("chatLogs.pauseStream")}</> : <><Play className="h-4 w-4 mr-1.5" /> {t("chatLogs.resumeStream")}</>}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 2-Column Layout */}
      <div className="grid grid-cols-1 md:grid-cols-12 gap-4 min-h-0 flex-1">
        
        {/* Column 1: Sessions */}
        <ChatLogSidebar 
          sessions={sessions}
          selectedSessionId={selectedSessionId}
          setSelectedSessionId={setSelectedSessionId}
          setSelectedTurnId={setSelectedTurnId}
          isLoadingMore={isLoadingMore}
          handleScroll={handleScroll}
          availableUsers={availableUsers}
          t={t}
          conversationScrollRef={conversationScrollRef}
          scrollPositionsRef={scrollPositionsRef}
          autoScrollEnabledRef={autoScrollEnabledRef}
        />

        {/* Column 2: Conversation & Detail View */}
        <Card className="col-span-1 md:col-span-9 flex flex-col overflow-hidden shadow-sm border-muted">
          <div className="p-3 border-b bg-muted/30 font-semibold text-sm flex items-center justify-between gap-2 text-muted-foreground">
            <div className="flex items-center gap-2">
              <Hash className="w-4 h-4" /> {detailTitle}
            </div>
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <Switch 
                  id="auto-scroll" 
                  checked={autoScrollEnabled} 
                  onCheckedChange={setAutoScrollEnabled} 
                  className="scale-75 data-[state=checked]:bg-primary"
                />
                <Label htmlFor="auto-scroll" className="text-xs font-normal opacity-70 cursor-pointer">
                  {t("chatLogs.autoScroll", "自动滚动")}
                </Label>
              </div>
              {isConversationView && filteredTurns.length > 0 && (
                <div className="flex items-center gap-1.5 bg-muted/60 border border-muted-foreground/10 rounded px-1.5 py-0.5 shadow-sm">
                  <button
                    disabled={activeTurnIndex <= 0}
                    onClick={() => {
                      const prevIndex = Math.max(0, activeTurnIndex - 1);
                      setActiveTurnIndex(prevIndex);
                      scrollToTurn(filteredTurns[prevIndex].turn.id);
                    }}
                    className="p-0.5 rounded hover:bg-muted-foreground/15 disabled:opacity-30 disabled:hover:bg-transparent transition-all cursor-pointer disabled:cursor-not-allowed"
                    title={t("common.previous", "上一个")}
                  >
                    <ChevronUp className="h-3.5 w-3.5 text-foreground/80" />
                  </button>
                  <span className="text-xs font-mono select-none px-1 min-w-[36px] text-center text-foreground/90 font-medium">
                    {activeTurnIndex + 1} / {filteredTurns.length}
                  </span>
                  <button
                    disabled={activeTurnIndex >= filteredTurns.length - 1}
                    onClick={() => {
                      const nextIndex = Math.min(filteredTurns.length - 1, activeTurnIndex + 1);
                      setActiveTurnIndex(nextIndex);
                      scrollToTurn(filteredTurns[nextIndex].turn.id);
                    }}
                    className="p-0.5 rounded hover:bg-muted-foreground/15 disabled:opacity-30 disabled:hover:bg-transparent transition-all cursor-pointer disabled:cursor-not-allowed"
                    title={t("common.next", "下一个")}
                  >
                    <ChevronDown className="h-3.5 w-3.5 text-foreground/80" />
                  </button>
                </div>
              )}
            </div>
          </div>
          <div className="flex-1 relative flex overflow-hidden">
            <div 
              ref={conversationScrollRef} 
              className="flex-1 overflow-y-auto bg-slate-50/50 dark:bg-slate-950/20 custom-scrollbar pr-6"
              onScroll={(e) => {
                if (selectedSessionId) {
                  scrollPositionsRef.current[selectedSessionId] = e.currentTarget.scrollTop;
                  // Persist to localStorage
                  localStorage.setItem("promptgate_audit_scroll_positions", JSON.stringify(scrollPositionsRef.current));
                }
                updateActiveTurnIndex();
              }}
            >
            {!selectedTurn && displayedTurns.length === 0 && !isLiveMode ? (
              <div className="h-full flex flex-col items-center justify-center p-10 text-muted-foreground opacity-50">
                <MessagesSquare className="w-12 h-12 mb-4" />
                <p className="text-sm">{selectedSessionId === "LIVE" ? t("chatLogs.waitingForTurns") : t("chatLogs.selectTurn")}</p>
              </div>
            ) : isLiveMode ? (
              <div className="p-4 flex flex-col gap-2">
                {liveTurns.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center p-10 text-muted-foreground opacity-50">
                    <div className="w-3 h-3 rounded-full bg-red-500 animate-pulse mb-4" />
                    <p className="text-sm">{t("chatLogs.waitingForTurns")}</p>
                  </div>
                ) : liveTurns.map((turn, index) => (
                  <div
                    key={turn.id || index}
                    className="group relative flex items-start gap-3 rounded-lg border border-transparent p-3 cursor-pointer transition-all hover:bg-accent/50 hover:border-border"
                    onClick={() => {
                      if (turn.serverSessionId) {
                        setSelectedSessionId(turn.serverSessionId);
                        setSelectedTurnId(null);
                        fetchSessionTurns(turn.serverSessionId);
                      } else {
                        setSelectedTurnId(turn.id);
                      }
                    }}
                  >
                    {/* Live indicator dot */}
                    {index === 0 && (
                      <div className="absolute -left-1 top-4 w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                    )}
                    {/* Turn index */}
                    <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-bold text-muted-foreground">
                      {liveTurns.length - index}
                    </div>
                    {/* Content */}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 text-xs text-muted-foreground mb-0.5">
                        <span className="font-medium text-blue-600 dark:text-blue-400 truncate max-w-[100px]">
                          {availableUsers.find(u => u.id === turn.userId)?.username || turn.userId?.slice(0, 8) || "?"}
                        </span>
                        <span className="text-[10px] opacity-60">·</span>
                        <span className="truncate max-w-[140px] opacity-80">{turn.model || "unknown"}</span>
                        <span className="text-[10px] opacity-60">·</span>
                        <span className="opacity-60">{turn.latencyMs || 0}ms</span>
                        <span className="text-[10px] opacity-60">·</span>
                        <span className="opacity-60">{turn.inputTokens || 0}+{turn.outputTokens || 0} tok</span>
                        <span className="ml-auto text-[10px] opacity-50">
                          {formatDateTime(turn.createdAt)}
                        </span>
                      </div>
                      <div className="text-sm text-foreground/80 line-clamp-1">
                        {extractPromptSummary(turn.inputText)}
                      </div>
                      {turn.status === "failed" && (
                        <div className="mt-1 text-xs text-red-500 flex items-center gap-1">
                          <XCircle className="w-3 h-3" /> {turn.error?.slice(0, 80) || "Failed"}
                        </div>
                      )}
                    </div>
                    {/* Arrow */}
                    <ChevronLeft className="mt-1 w-4 h-4 text-muted-foreground/30 rotate-180 group-hover:text-muted-foreground/60 transition-colors shrink-0" />
                  </div>
                ))}
              </div>
            ) : isConversationView ? (
              <div className="relative min-h-full">
                <div className="p-6 pr-14">
                  <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 mb-1.5 min-w-0">
                        <span 
                          className="truncate text-sm md:text-base font-semibold text-foreground"
                          title={selectedSession?.sessionTitle || (displayedTurns[0] ? extractPromptSummary(displayedTurns[0].inputText) : t("chatLogs.conversationReplay", "Conversation Replay"))}
                        >
                          {selectedSession?.sessionTitle || (displayedTurns[0] ? extractPromptSummary(displayedTurns[0].inputText) : t("chatLogs.conversationReplay", "Conversation Replay"))}
                        </span>
                        {displayedTurns[0]?.detectedClient && 
                          renderClientBadge(displayedTurns[0].detectedClient, "md")
                        }
                      </div>
                      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <span>{availableUsers.find(u => u.id === displayedTurns[0]?.userId && u.username !== u.id)?.username || displayedTurns[0]?.userId || "Unknown"}</span>
                        <span>{displayedTurns[0]?.model}</span>
                        <span>{displayedTurns.reduce((sum, turn) => sum + (turn.inputTokens || 0), 0)} / {displayedTurns.reduce((sum, turn) => sum + (turn.outputTokens || 0), 0)} tok</span>
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 px-2 text-xs"
                      onClick={() => {
                        const copyData = displayedTurns.map((turn) => ({
                          requestId: turn.requestId || turn.id,
                          input: (() => {
                            try { return cleanRawJsonForDisplay(JSON.parse(turn.inputText || "{}")); } catch { return turn.inputText; }
                          })(),
                          output: (() => {
                            try { return cleanRawJsonForDisplay(JSON.parse(turn.outputText || "{}")); } catch { return turn.outputText; }
                          })(),
                        }));
                        navigator.clipboard.writeText(JSON.stringify(copyData, null, 2));
                        toast.success(t("common.copySuccess", "已复制到剪贴板"));
                      }}
                    >
                      <Copy className="w-3 h-3 mr-1" />
                      {t("chatLogs.copySession", "Copy Session")}
                    </Button>
                  </div>

                  <div className="flex flex-col gap-6">
                    {displayedTurns.map((turn, index) => (
                      <div key={turn.id || index} ref={(el) => { turnRefs.current[turn.id] = el; }}>
                        {renderConversationTurn(turn, index, t, availableUsers, formatDateTime, user?.role === "admin", handleCacheResponse)}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ) : selectedTurn ? (
              <div className="p-6 flex flex-col gap-6">
                
                {/* Meta header */}
                <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                  <div className="flex items-center flex-wrap gap-2 text-xs font-mono">
                    <button
                      onClick={() => setSelectedTurnId(null)}
                      className="flex items-center gap-1 bg-muted hover:bg-accent px-2 py-1 rounded-md text-muted-foreground hover:text-foreground transition-colors"
                    >
                      <ChevronLeft className="w-3 h-3" />
                      {t("chatLogs.backToConversation", "Back")}
                    </button>
                    <span className="bg-primary/10 text-primary px-2 py-1 rounded-md font-bold">REQ: {selectedTurn.id?.split('-')[0] || 'Unknown'}</span>
                    <span className="bg-muted px-2 py-1 rounded-md text-muted-foreground flex items-center gap-1"><Clock className="w-3 h-3"/> {selectedTurn.latencyMs}ms</span>
                    <span className="bg-muted px-2 py-1 rounded-md text-muted-foreground flex items-center gap-1">In: {selectedTurn.inputTokens} / Out: {selectedTurn.outputTokens}</span>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={() => {
                      try {
                        const copyData = {
                          request: JSON.parse(selectedTurn.inputText || "{}"),
                          response: JSON.parse(selectedTurn.outputText || "{}")
                        };
                        navigator.clipboard.writeText(JSON.stringify(cleanRawJsonForDisplay(copyData), null, 2));
                        toast.success(t("common.copySuccess", "已复制到剪贴板"));
                      } catch {
                        navigator.clipboard.writeText(`Request:\n${selectedTurn.inputText}\n\nResponse:\n${selectedTurn.outputText}`);
                        toast.success(t("common.copySuccess", "已复制到剪贴板"));
                      }
                    }}
                  >
                    <Copy className="w-3 h-3 mr-1" />
                    Copy JSON
                  </Button>
                </div>

                {/* Input Bubble */}
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between border-b pb-1">
                    <span className="text-[10px] font-bold opacity-50 uppercase tracking-wider px-1">
                      {t("chatLogs.userInput", "USER INPUT")}
                    </span>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-[10px] h-6 px-2 text-muted-foreground hover:text-foreground"
                        onClick={() => setShowRawInput(!showRawInput)}
                      >
                        {showRawInput ? t("chatLogs.showRendered", "显示渲染") : t("chatLogs.showRaw", "显示 JSON")}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-[10px] h-6 px-2 text-muted-foreground hover:text-foreground"
                        onClick={() => {
                          navigator.clipboard.writeText(selectedTurn.inputText);
                          toast.success(t("common.copySuccess", "已复制到剪贴板"));
                        }}
                      >
                        {t("common.copy", "复制")}
                      </Button>
                    </div>
                  </div>
                  {showRawInput ? (
                    <pre className="p-4 bg-muted/60 font-mono text-xs rounded-xl overflow-x-auto max-h-[300px] border whitespace-pre-wrap leading-relaxed select-all">
                      {(() => {
                        try {
                          return JSON.stringify(cleanRawJsonForDisplay(JSON.parse(selectedTurn.inputText)), null, 2);
                        } catch {
                          return selectedTurn.inputText;
                        }
                      })()}
                    </pre>
                  ) : (
                    renderContentBlocks(selectedTurn.inputText)
                  )}
                </div>

                {/* Output Bubble */}
                <div className="flex flex-col gap-2 mt-4">
                  <div className="flex items-center justify-between border-b pb-1">
                    <span className="text-[10px] font-bold opacity-50 uppercase tracking-wider px-1">
                      {t("chatLogs.assistantOutput", "ASSISTANT OUTPUT")} ({selectedTurn.model})
                    </span>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-[10px] h-6 px-2 text-muted-foreground hover:text-foreground"
                        onClick={() => setShowRawOutput(!showRawOutput)}
                      >
                        {showRawOutput ? t("chatLogs.showRendered", "显示渲染") : t("chatLogs.showRaw", "显示 JSON")}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-[10px] h-6 px-2 text-muted-foreground hover:text-foreground"
                        onClick={() => {
                          navigator.clipboard.writeText(selectedTurn.outputText || "");
                          toast.success(t("common.copySuccess", "已复制到剪贴板"));
                        }}
                      >
                        {t("common.copy", "复制")}
                      </Button>
                    </div>
                  </div>

                  {showRawOutput ? (
                    <pre className="p-4 bg-muted/60 font-mono text-xs rounded-xl overflow-x-auto max-h-[300px] border whitespace-pre-wrap leading-relaxed select-all">
                      {(() => {
                        try {
                          return JSON.stringify(cleanRawJsonForDisplay(JSON.parse(selectedTurn.outputText || "")), null, 2);
                        } catch {
                          return selectedTurn.outputText || "";
                        }
                      })()}
                    </pre>
                  ) : (
                    renderAssistantContent(selectedTurn, t)
                  )}
                </div>
              </div>
            ) : null}
            </div>

            {/* Minimap — interactive turn navigation (Fixed relative to the viewport height) */}
            {isConversationView && filteredTurns.length > 1 && (
              <div className="absolute right-2 top-4 bottom-4 z-20 hidden w-8 lg:flex pointer-events-none">
                {filteredTurns.slice(0, 80).map(({ turn, originalIndex }, filteredIndex) => {
                  const y = turnPositions[turn.id];
                  const totalHeight = scrollContainerStats.scrollHeight;
                  const ratio = y !== undefined && totalHeight > 0 ? y / totalHeight : originalIndex / filteredTurns.length;
                  const topPercent = ratio * 100;

                  return (
                    <div
                      key={turn.id || originalIndex}
                      className="absolute right-0 flex items-center justify-end pointer-events-auto w-full"
                      style={{
                        top: `${topPercent}%`,
                        transform: 'translateY(-50%)',
                      }}
                      onMouseEnter={() => setHoveredTurnIndex(originalIndex)}
                      onMouseLeave={() => setHoveredTurnIndex(null)}
                      onClick={() => scrollToTurn(turn.id)}
                    >
                      {/* Bar */}
                      <div
                        className={cn(
                          "rounded-full transition-all duration-200 cursor-pointer absolute right-0",
                          hoveredTurnIndex === originalIndex
                            ? "h-[4px] w-7 bg-primary shadow-[0_0_8px_rgba(var(--primary)/0.4)]"
                            : activeTurnIndex === filteredIndex
                              ? "h-[3.5px] w-5.5 bg-primary shadow-[0_0_6px_rgba(var(--primary)/0.3)]"
                              : "h-[3px] w-4 bg-muted-foreground/25 hover:w-5 hover:bg-muted-foreground/50",
                          turn.status === "failed" && hoveredTurnIndex !== originalIndex && "bg-red-400/40"
                        )}
                      />
                      {/* Tooltip */}
                      {hoveredTurnIndex === originalIndex && (
                        <div className="absolute right-full mr-3 w-[280px] rounded-xl border bg-popover/95 backdrop-blur-xl shadow-xl px-4 py-3 text-xs z-50 pointer-events-none animate-in fade-in-0 zoom-in-95 duration-150">
                          <div className="flex items-center justify-between mb-1.5">
                            <span className="font-bold text-foreground">#{originalIndex + 1} · {turn.model || 'Unknown'}</span>
                            <span className="text-[10px] text-muted-foreground">
                              {new Date(turn.createdAt).toLocaleTimeString()}
                            </span>
                          </div>
                          <div className="text-muted-foreground line-clamp-2 leading-relaxed mb-2">
                            {extractPromptSummary(turn.inputText)}
                          </div>
                          <div className="flex items-center gap-3 text-[10px] text-muted-foreground/70">
                            {turn.status === "success" ? (
                              <span className="flex items-center gap-1 text-emerald-500"><CheckCircle2 className="w-3 h-3" /> OK</span>
                            ) : (
                              <span className="flex items-center gap-1 text-red-500"><XCircle className="w-3 h-3" /> Failed</span>
                            )}
                            <span>{turn.latencyMs}ms</span>
                            <span>{turn.inputTokens}+{turn.outputTokens} tok</span>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
