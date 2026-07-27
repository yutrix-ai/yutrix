import { useState, useEffect } from "react";
import {
  LayoutDashboard,
  Users,
  Ticket,
  Key,
  Box,
  Globe,
  Activity,
  Shield,
  BarChart3,
  ScrollText,
  Settings,
  Settings2,
  LogOut,
  Route as RouteIcon,
  Terminal,
  UsersRound,
  MessagesSquare,
  ChevronDown,
  ChevronRight,
  Database,
  FastForward,
} from "lucide-react";
import { useAuth } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import { useSettings } from "@/contexts/SettingsContext";

interface SidebarProps {
  currentPath: string;
  onNavigate: (path: string) => void;
  sidebarOpen?: boolean;
  onClose?: () => void;
}

export function Sidebar({ currentPath, onNavigate, sidebarOpen, onClose }: SidebarProps) {
  const { user, logout } = useAuth();
  const { t } = useTranslation();
  const { systemName, systemLogoUrl, sidebarLogoAnimation } = useSettings();

  const adminGroups = [
    {
      key: "dashboard",
      group: t("layout.group.dashboard", "仪表盘"),
      icon: LayoutDashboard,
      items: [
        { path: "/", label: t("layout.overview", "概览"), icon: LayoutDashboard },
        { path: "/analytics", label: t("layout.analytics", "数据统计"), icon: BarChart3 },
      ]
    },
    {
      key: "playground",
      group: t("layout.group.playground", "Playground"),
      icon: Terminal,
      items: [
        { path: "/playground", label: t("layout.playground", "Playground"), icon: Terminal },
      ]
    },
    {
      key: "gateway",
      group: t("layout.group.gateway", "网关配置"),
      icon: RouteIcon,
      items: [
        { path: "/providers", label: t("layout.providers", "供应商管理"), icon: Box },
        { path: "/routes", label: t("layout.routes", "路由配置"), icon: RouteIcon },
        { path: "/policies", label: t("layout.policies", "访问策略"), icon: Shield },
        { path: "/response-cache", label: t("layout.responseCache", "响应缓存"), icon: Database },
      ]
    },
    {
      key: "access",
      group: t("layout.group.access", "接入与密钥"),
      icon: Key,
      items: [
        { path: "/api-keys", label: t("layout.apikeys", "API Keys"), icon: Key },
        { path: "/openapi", label: t("layout.openapi", "开放接口"), icon: Globe },
      ]
    },
    {
      key: "identity",
      group: t("layout.group.identity", "用户与组织"),
      icon: Users,
      items: [
        { path: "/users", label: t("layout.users", "用户管理"), icon: Users },
        { path: "/groups", label: t("layout.groups", "用户组"), icon: UsersRound },
        { path: "/invite-codes", label: t("layout.invite-codes", "邀请码管理"), icon: Ticket },
      ]
    },
    {
      key: "audit",
      group: t("layout.group.audit", "审计"),
      icon: ScrollText,
      items: [
        { path: "/chat-logs", label: t("layout.chatLogs", "LLM 审计日志"), icon: MessagesSquare },
        { path: "/logs", label: t("layout.logs", "Action Logs"), icon: ScrollText },
      ]
    }
  ];

  const userGroups = [
    {
      key: "user-flat",
      group: "",
      icon: LayoutDashboard,
      items: [
        { path: "/", label: t("layout.dashboard"), icon: LayoutDashboard },
        { path: "/api-keys", label: t("layout.apikeys"), icon: Key },
        { path: "/playground", label: t("layout.playground"), icon: Terminal },
        { path: "/user-routes", label: t("layout.user-routes"), icon: RouteIcon },
        { path: "/my-stats", label: t("layout.my-stats"), icon: BarChart3 },
        { path: "/change-password", label: t("layout.change-password"), icon: Settings },
      ]
    }
  ];

  const groups = user?.role === "admin" ? adminGroups : userGroups;

  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem("promptgate_sidebar_expanded");
      if (stored) return new Set(JSON.parse(stored));
    } catch (e) {
      // ignore
    }
    return new Set();
  });

  useEffect(() => {
    localStorage.setItem("promptgate_sidebar_expanded", JSON.stringify(Array.from(expandedGroups)));
  }, [expandedGroups]);

  useEffect(() => {
    const activeGroup = (user?.role === "admin" ? adminGroups : userGroups).find(g =>
      g.items.some(item => {
        if (item.path === "/") return currentPath === "/";
        return currentPath.startsWith(item.path);
      })
    );
    if (activeGroup?.key) {
      setExpandedGroups(prev => new Set(prev).add(activeGroup.key));
    }
  }, [currentPath, user?.role]);

  const toggleGroup = (key: string, itemsCount: number, firstPath: string) => {
    if (itemsCount === 1) {
      onNavigate(firstPath);
    } else {
      setExpandedGroups(prev => {
        const next = new Set(prev);
        next.has(key) ? next.delete(key) : next.add(key);
        return next;
      });
    }
  };

  return (
    <aside className={cn(
      "flex h-full shrink-0 flex-col border-r bg-card transition-all duration-300",
      "fixed inset-y-0 left-0 z-50 w-60",
      sidebarOpen ? "translate-x-0" : "-translate-x-full",
      "lg:static lg:translate-x-0",
      sidebarOpen ? "lg:w-60" : "lg:w-0 lg:overflow-hidden lg:border-r-0"
    )}>
      <div className="flex h-16 items-center border-b px-6">
        <div className="flex items-center gap-2 group/logo cursor-pointer select-none">
          <img
            src={systemLogoUrl}
            alt="Logo"
            className={cn(
              "w-7 h-7 object-contain transition-all duration-500",
              sidebarLogoAnimation === "spin-hover" && "group-hover/logo:rotate-[360deg]",
              sidebarLogoAnimation === "tesla-show" && "animate-[neon-breath-glow_4s_infinite_ease-in-out] group-hover/logo:animate-[tesla-logo-pulse_0.8s_infinite_ease-in-out]",
              sidebarLogoAnimation === "cyber-glitch" && "group-hover/logo:animate-[cyber-logo-glitch_0.25s_infinite_linear]",
              sidebarLogoAnimation === "neon-breath" && "animate-[neon-breath-glow_3s_infinite_ease-in-out]",
              sidebarLogoAnimation === "cosmic-aurora" && "animate-[spin-slow_12s_infinite_linear] filter drop-shadow(0 0 6px rgba(168,85,247,0.5))"
            )}
          />
          <h1
            className={cn(
              "text-lg font-bold tracking-tight bg-clip-text text-transparent bg-[length:200%_auto] transition-all duration-300",
              sidebarLogoAnimation === "cosmic-aurora"
                ? "bg-gradient-to-r from-pink-500 via-purple-500 to-cyan-500 animate-[cosmic-aurora-sweep_6s_infinite_ease-in-out]"
                : sidebarLogoAnimation === "neon-breath"
                ? "bg-gradient-to-r from-primary via-cyan-400 to-indigo-500 animate-[cosmic-aurora-sweep_4s_infinite_ease-in-out]"
                : sidebarLogoAnimation === "tesla-show"
                ? "bg-gradient-to-r from-primary via-pink-500 to-yellow-500 group-hover/logo:animate-[tesla-text-strobe_0.6s_infinite_linear] animate-[cosmic-aurora-sweep_3s_infinite_linear]"
                : sidebarLogoAnimation === "cyber-glitch"
                ? "bg-gradient-to-r from-primary via-indigo-500 to-violet-500 group-hover/logo:animate-[cyber-logo-glitch_0.3s_infinite_linear] group-hover/logo:text-cyan-400"
                : "bg-gradient-to-r from-primary via-indigo-500 to-violet-500"
            )}
          >
            {systemName}
          </h1>
        </div>
      </div>

      <nav className="flex-1 space-y-2.5 p-4 overflow-y-auto overflow-x-hidden custom-scrollbar">
        {groups.map((g) => {
          if (!g.group) {
            return g.items.map((item) => {
              const Icon = item.icon;
              const isActive = currentPath === item.path || (item.path !== "/" && currentPath.startsWith(item.path));
              return (
                <button
                  key={item.path}
                  onClick={() => onNavigate(item.path)}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all duration-200 relative overflow-hidden group hover:scale-[0.985]",
                    isActive
                      ? "bg-gradient-to-r from-primary/15 to-primary/5 text-primary font-semibold border border-primary/20 shadow-sm"
                      : "text-muted-foreground hover:bg-accent/60 hover:text-accent-foreground border border-transparent"
                  )}
                >
                  {isActive && (
                    <div className="absolute left-0 top-1.5 bottom-1.5 w-[3px] bg-primary rounded-r" />
                  )}
                  <Icon className={cn("h-4 w-4 shrink-0 transition-transform duration-200 group-hover:scale-110", isActive ? "text-primary" : "")} />
                  {item.label}
                </button>
              );
            });
          }

          const GroupIcon = g.icon;
          const isExpanded = expandedGroups.has(g.key);
          const isGroupActive = g.items.some(item => {
            if (item.path === "/") return currentPath === "/";
            return currentPath.startsWith(item.path);
          });
          
          return (
            <div key={g.key} className="space-y-1.5">
              <button
                onClick={() => toggleGroup(g.key, g.items.length, g.items[0].path)}
                className={cn(
                  "flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-sm font-medium transition-all duration-200 hover:scale-[0.985] group",
                  isGroupActive
                    ? "bg-gradient-to-r from-primary/8 to-primary/2 text-primary font-semibold border border-primary/10"
                    : "text-muted-foreground hover:bg-accent/60 hover:text-accent-foreground border border-transparent"
                )}
              >
                <div className="flex items-center gap-3">
                  <GroupIcon className={cn("h-4 w-4 shrink-0 transition-transform duration-200 group-hover:scale-110", isGroupActive ? "text-primary" : "")} />
                  <span>{g.group}</span>
                </div>
                {g.items.length > 1 && (
                  isExpanded ? (
                    <ChevronDown className="h-4 w-4 shrink-0 opacity-70" />
                  ) : (
                    <ChevronRight className="h-4 w-4 shrink-0 opacity-70" />
                  )
                )}
              </button>
              {isExpanded && g.items.length > 1 && (
                <div className="mt-1 space-y-1 pl-2 border-l border-muted/30 ml-5 overflow-hidden animate-in fade-in slide-in-from-top-1 duration-200">
                  {g.items.map((item) => {
                    const SubIcon = item.icon;
                    const isActive = currentPath === item.path || (item.path !== "/" && currentPath.startsWith(item.path));
                    return (
                      <button
                        key={item.path}
                        onClick={() => onNavigate(item.path)}
                        className={cn(
                          "flex w-full items-center gap-3 rounded-lg pl-4 pr-3 py-2 text-sm font-medium transition-all duration-200 relative overflow-hidden group hover:scale-[0.985]",
                          isActive
                            ? "bg-gradient-to-r from-primary/10 to-primary/3 text-primary font-semibold"
                            : "text-muted-foreground hover:bg-accent/40 hover:text-accent-foreground"
                        )}
                      >
                        {isActive && (
                          <div className="absolute left-0 top-1 bottom-1 w-[2px] bg-primary rounded-r" />
                        )}
                        <SubIcon className={cn("h-3.5 w-3.5 shrink-0 transition-transform duration-200 group-hover:scale-110", isActive ? "text-primary" : "")} />
                        {item.label}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </nav>

      <div className="border-t p-4 space-y-2.5">
        <div className="flex items-center gap-3 pl-3 pr-1.5 py-2.5 rounded-lg bg-muted/20 dark:bg-card/40 border border-border/40">
          <div className="w-8 h-8 rounded-full bg-primary/10 text-primary flex items-center justify-center font-bold text-sm shrink-0 uppercase">
            {user?.username?.slice(0, 2) || "U"}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold truncate text-foreground">{user?.username}</div>
            <div className="text-xs text-muted-foreground capitalize">
              {user?.role === "admin" ? "Admin" : "User"}
            </div>
          </div>
          {user?.role === "admin" && (
            <div className="flex items-center gap-0.5 shrink-0 ml-auto">
              <button
                onClick={() => onNavigate("/system-info")}
                title={t("layout.systemInfo", "系统状态")}
                className={cn(
                  "flex items-center justify-center w-7 h-7 rounded-md transition-all duration-200 group",
                  currentPath === "/system-info"
                    ? "bg-primary/15 text-primary ring-1 ring-primary/20"
                    : "text-muted-foreground/60 hover:text-foreground hover:bg-accent/50 dark:hover:bg-accent/30"
                )}
              >
                <Activity className="h-3.5 w-3.5 transition-transform duration-200 group-hover:scale-110" />
              </button>
              <button
                onClick={() => onNavigate("/settings")}
                title={t("layout.settings", "系统设置")}
                className={cn(
                  "flex items-center justify-center w-7 h-7 rounded-md transition-all duration-200 group",
                  currentPath === "/settings"
                    ? "bg-primary/15 text-primary ring-1 ring-primary/20"
                    : "text-muted-foreground/60 hover:text-foreground hover:bg-accent/50 dark:hover:bg-accent/30"
                )}
              >
                <Settings2 className="h-3.5 w-3.5 transition-transform duration-300 group-hover:rotate-90" />
              </button>
            </div>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start text-muted-foreground/70 hover:text-destructive hover:bg-destructive/8 dark:hover:bg-destructive/10 transition-all duration-200 h-8 text-xs"
          onClick={logout}
        >
          <LogOut className="h-3.5 w-3.5 mr-1.5" />
          {t("layout.logout")}
        </Button>
      </div>
    </aside>
  );
}
