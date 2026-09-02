import { Route, Switch, useLocation } from "wouter";
import { useEffect } from "react";
import { useAuth } from "./lib/store";
import { useTheme } from "./hooks/useTheme";
import { AppShell } from "./components/layout/AppShell";
import { TimeRangeProvider } from "./contexts/TimeRangeContext";
import { SettingsProvider } from "./contexts/SettingsContext";
import "./index.css";

import Dashboard from "./pages/Dashboard";
import Login from "./pages/Login";
import ApiKeys from "./pages/ApiKeys";
import Providers from "./pages/Providers";
import Routes from "./pages/Routes";
import UserRoutes from "./pages/UserRoutes";
import Policies from "./pages/Policies";
import Settings from "./pages/Settings";
import Users from "./pages/Users";
import Groups from "./pages/Groups";
import InviteCodes from "./pages/InviteCodes";
import Analytics from "./pages/Analytics";
import Logs from "./pages/Logs";
import ChatLogs from "./pages/ChatLogs";
import MyStats from "./pages/MyStats";
import ChangePassword from "./pages/ChangePassword";
import Playground from "./pages/Playground";
import AdminOpenAPI from "./pages/AdminOpenAPI";
import SystemInfo from "./pages/SystemInfo";
import ResponseCache from "./pages/ResponseCache";
import Distillation from "./pages/Distillation";
function App() {
  const [location, setLocation] = useLocation();
  const { user, loading, checkAuth } = useAuth();

  // Initialize theme
  useTheme();

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center bg-background">
        <div className="text-muted-foreground">加载中...</div>
      </div>
    );
  }

  const isAuthPage = location === "/login";

  if (!user && !isAuthPage) {
    setLocation("/login");
    return null;
  }

  if (user && isAuthPage) {
    setLocation("/");
    return null;
  }

  const renderContent = () => {
    if (isAuthPage) {
      return (
        <Switch>
          <Route path="/login" component={Login} />
        </Switch>
      );
    }

    const AdminRoute = ({ component: Component, ...rest }: any) => {
      const { user } = useAuth();
      const [, setLocation] = useLocation();

      useEffect(() => {
        if (user && user.role !== "admin") {
          setLocation("/my-stats");
        }
      }, [user, setLocation]);

      if (!user || user.role !== "admin") {
        return null;
      }

      return <Route {...rest} component={Component} />;
    };

    return (
      <TimeRangeProvider>
        <AppShell currentPath={location} onNavigate={setLocation}>
          <Switch>
            <Route path="/" component={Dashboard} />
            <AdminRoute path="/users" component={Users} />
            <AdminRoute path="/groups" component={Groups} />
            <AdminRoute path="/invite-codes" component={InviteCodes} />
            <Route path="/api-keys" component={ApiKeys} />
            <AdminRoute path="/providers" component={Providers} />
            <AdminRoute path="/routes" component={Routes} />
            <Route path="/user-routes" component={UserRoutes} />
            <AdminRoute path="/policies" component={Policies} />
            <AdminRoute path="/analytics" component={Analytics} />
            <AdminRoute path="/openapi" component={AdminOpenAPI} />
            <AdminRoute path="/logs" component={Logs} />
            <AdminRoute path="/chat-logs" component={ChatLogs} />
            <AdminRoute path="/settings" component={Settings} />
            <AdminRoute path="/system-info" component={SystemInfo} />
            <AdminRoute path="/response-cache" component={ResponseCache} />
            <AdminRoute path="/distillation" component={Distillation} />
            <Route path="/my-stats" component={MyStats} />
            <Route path="/playground" component={Playground} />
            <Route path="/change-password" component={ChangePassword} />
          </Switch>
        </AppShell>
      </TimeRangeProvider>
    );
  };

  return (
    <SettingsProvider>
      {renderContent()}
    </SettingsProvider>
  );
}

export default App;
