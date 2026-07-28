import { useState } from "react";
import { Sidebar } from "./Sidebar";
import { ThemeToggle } from "@/components/ThemeToggle";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { useTranslation } from "react-i18next";
import { Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TimeRangeSelector } from "@/components/TimeRangeSelector";
import { useSettings } from "@/contexts/SettingsContext";

interface AppShellProps {
  currentPath: string;
  onNavigate: (path: string) => void;
  children: React.ReactNode;
}



function GitHubMark({ className = "" }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
    >
      <path d="M10.226 17.284c-2.965-.36-5.054-2.493-5.054-5.256 0-1.123.404-2.336 1.078-3.144-.292-.741-.247-2.314.09-2.965.898-.112 2.111.36 2.83 1.01.853-.269 1.752-.404 2.853-.404 1.1 0 1.999.135 2.807.382.696-.629 1.932-1.1 2.83-.988.315.606.36 2.179.067 2.942.72.854 1.101 2 1.101 3.167 0 2.763-2.089 4.852-5.098 5.234.763.494 1.28 1.572 1.28 2.807v2.336c0 .674.561 1.056 1.235.786 4.066-1.55 7.255-5.615 7.255-10.646C23.5 6.188 18.334 1 11.978 1 5.62 1 .5 6.188.5 12.545c0 4.986 3.167 9.12 7.435 10.669.606.225 1.19-.18 1.19-.786V20.63a2.9 2.9 0 0 1-1.078.224c-1.483 0-2.359-.808-2.987-2.313-.247-.607-.517-.966-1.034-1.033-.27-.023-.359-.135-.359-.27 0-.27.45-.471.898-.471.652 0 1.213.404 1.797 1.235.45.651.921.943 1.483.943.561 0 .92-.202 1.437-.719.382-.381.674-.718.944-.943" />
    </svg>
  );
}

export function AppShell({ currentPath, onNavigate, children }: AppShellProps) {
  const lockPageScroll = currentPath === "/logs";
  const [sidebarOpen, setSidebarOpen] = useState(() => typeof window !== "undefined" ? window.innerWidth >= 1024 : true);
  const { showGithubIcon } = useSettings();

  return (
    <div className="flex h-[100dvh] md:h-screen w-full overflow-hidden bg-background">
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <Sidebar
        currentPath={currentPath}
        sidebarOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        onNavigate={(path) => {
          onNavigate(path);
          if (window.innerWidth < 1024) {
            setSidebarOpen(false);
          }
        }}
      />

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden relative">
        {/* Premium Ambient Glow for Dark Mode */}
        <div className="absolute top-0 left-0 right-0 h-[400px] bg-[radial-gradient(ellipse_60%_50%_at_50%_-10%,rgba(99,102,241,0.05),rgba(255,255,255,0))] pointer-events-none z-0" />

        <header className="flex h-16 shrink-0 items-center justify-between border-b bg-card/65 backdrop-blur-md px-4 md:px-8 z-10">
          {/* Left: Context Controls (Navigation + Time Range) */}
          <div className="flex items-center gap-2 sm:gap-4 min-w-0">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setSidebarOpen(!sidebarOpen)}
              className="h-9 w-9 shrink-0"
              aria-label="切换侧边栏"
            >
              <Menu className="h-5 w-5" />
            </Button>
            
            <div className="hidden sm:block">
              <TimeRangeSelector />
            </div>
          </div>

          {/* Right: App Utilities */}
          <div className="flex shrink-0 items-center gap-2 sm:gap-4">
            <LanguageSwitcher />
            
            {/* Mobile-only Date Selector */}
            <div className="sm:hidden">
              <TimeRangeSelector />
            </div>

            {showGithubIcon !== "false" && (
              <a
                href="https://github.com/yutrix-ai/yutrix"
                target="_blank"
                rel="noreferrer"
                aria-label="打开 GitHub 仓库"
                title="GitHub"
                className="hidden sm:inline-flex h-9 w-9 items-center justify-center rounded-md text-foreground/80 transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <GitHubMark className="h-5 w-5" />
              </a>
            )}
            <ThemeToggle />
          </div>
        </header>

        <main
          className={`flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden z-10 ${
            lockPageScroll ? "overflow-hidden" : "overflow-y-auto overscroll-contain"
          }`}
        >
          <div className="min-w-0 w-full flex-1 flex flex-col min-h-0 p-4 md:p-8">{children}</div>
        </main>
      </div>
    </div>
  );
}
