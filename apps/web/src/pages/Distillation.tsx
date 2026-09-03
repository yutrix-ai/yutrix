import { useCallback, useEffect, useState } from "react";
import { fetchApi, API_BASE } from "@/lib/api";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  Play,
  Pause,
  Square,
  Download,
  CheckCircle2,
  RotateCcw,
  Loader2,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmDialog } from "@/components/ConfirmDialog";

type Job = {
  id: string;
  mode: string;
  status: string;
  totalItems: number;
  processedItems: number;
  failedItems: number;
  createdAt: string;
};

type Proposal = {
  id: string;
  status: string;
  sourceUserId: string | null;
  payload: string;
  createdAt: string;
};

type SkillPkg = {
  userId: string;
  username: string;
  version: number;
  sourceRecordCount: number;
  status: string;
  files?: Record<string, string>;
};

type Settings = {
  analysisRouteId: string | null;
  concurrency: number;
  cronEnabled: boolean;
  cron: string;
  maxRecordsPerRun: number;
};

type RouteOption = { id: string; name: string };

export default function DistillationPage() {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [skills, setSkills] = useState<SkillPkg[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [routes, setRoutes] = useState<RouteOption[]>([]);
  const [activeOverlay, setActiveOverlay] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [validating, setValidating] = useState(false);
  const [applying, setApplying] = useState(false);
  const [previewSkill, setPreviewSkill] = useState<SkillPkg | null>(null);
  const [actionJobId, setActionJobId] = useState<string | null>(null);
  const [terminateJobId, setTerminateJobId] = useState<string | null>(null);
  const [terminateConfirmOpen, setTerminateConfirmOpen] = useState(false);
  const [terminating, setTerminating] = useState(false);

  const loadAll = useCallback(async () => {
    try {
      const [j, p, s, st, r, ov] = await Promise.all([
        fetchApi("/admin/distillation/jobs"),
        fetchApi("/admin/distillation/proposals"),
        fetchApi("/admin/distillation/skills"),
        fetchApi("/admin/distillation/settings"),
        fetchApi("/admin/routes"),
        fetchApi("/admin/distillation/routing/active"),
      ]);
      setJobs(Array.isArray(j) ? j : []);
      setProposals(Array.isArray(p) ? p : []);
      setSkills(Array.isArray(s) ? s : []);
      setSettings(st);
      setRoutes(
        (Array.isArray(r) ? r : r?.data ?? []).map((x: any) => ({
          id: x.id,
          name: x.name ?? x.id,
        })),
      );
      setActiveOverlay(ov?.active?.versionLabel ?? null);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAll();
    const timer = setInterval(loadAll, 5000);
    return () => clearInterval(timer);
  }, [loadAll]);

  const startJob = async (mode: "incremental" | "full_relearn") => {
    setStarting(true);
    try {
      await fetchApi("/admin/distillation/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      toast.success(t("distillation.jobStarted", "蒸馏作业已启动"));
      await loadAll();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setStarting(false);
    }
  };

  const handlePause = async (id: string) => {
    setActionJobId(id);
    try {
      await fetchApi(`/admin/distillation/jobs/${id}/pause`, {
        method: "POST",
      });
      toast.success(t("distillation.pauseSuccess", "作业已暂停"));
      await loadAll();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setActionJobId(null);
    }
  };

  const handleResume = async (id: string) => {
    setActionJobId(id);
    try {
      await fetchApi(`/admin/distillation/jobs/${id}/resume`, {
        method: "POST",
      });
      toast.success(t("distillation.resumeSuccess", "作业已继续"));
      await loadAll();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setActionJobId(null);
    }
  };

  const openTerminateConfirm = (id: string) => {
    setTerminateJobId(id);
    setTerminateConfirmOpen(true);
  };

  const handleConfirmTerminate = async () => {
    if (!terminateJobId) return;
    setTerminating(true);
    try {
      await fetchApi(`/admin/distillation/jobs/${terminateJobId}/cancel`, {
        method: "POST",
      });
      toast.success(t("distillation.terminateSuccess", "作业已终止"));
      await loadAll();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setTerminating(false);
      setTerminateJobId(null);
    }
  };

  const saveSettings = async () => {
    if (!settings) return;
    try {
      await fetchApi("/admin/distillation/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      toast.success(t("distillation.settingsSaved", "设置已保存"));
    } catch (e: any) {
      toast.error(e.message);
    }
  };

  const validateProposals = async () => {
    setValidating(true);
    try {
      const res = await fetchApi("/admin/distillation/proposals/validate", {
        method: "POST",
      });
      if (res.ok) toast.success(t("distillation.validateOk", "预校验通过"));
      else toast.error(res.errors?.join(", ") ?? "validation failed");
      await loadAll();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setValidating(false);
    }
  };

  const applyRouting = async () => {
    setApplying(true);
    try {
      const res = await fetchApi("/admin/distillation/proposals/apply", {
        method: "POST",
      });
      toast.success(
        t("distillation.applyOk", "路由已生效：{{v}}", { v: res.versionLabel }),
      );
      await loadAll();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setApplying(false);
    }
  };

  const rollbackRouting = async () => {
    try {
      await fetchApi("/admin/distillation/routing/rollback", { method: "POST" });
      toast.success(t("distillation.rollbackOk", "已回滚路由版本"));
      await loadAll();
    } catch (e: any) {
      toast.error(e.message);
    }
  };

  const downloadSkill = async (userId: string, username: string) => {
    const token =
      localStorage.getItem("token") || sessionStorage.getItem("token");
    const res = await fetch(
      `${API_BASE}/admin/distillation/skills/${userId}/download`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) throw new Error(await res.text());
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${username}-skill.zip`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const previewUserSkill = async (userId: string) => {
    try {
      const pkg = await fetchApi(`/admin/distillation/skills/${userId}`);
      setPreviewSkill(pkg);
    } catch (e: any) {
      toast.error(e.message);
    }
  };

  const activeJob = jobs.find(
    (j) =>
      j.status === "running" || j.status === "pending" || j.status === "paused",
  );
  const draftCount = proposals.filter((p) => p.status === "draft").length;
  const validatedCount = proposals.filter((p) => p.status === "validated").length;

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("distillation.title", "蒸馏飞轮")}
        description={t(
          "distillation.subtitle",
          "从审计日志同时进化路由信号与员工 Skill（抽象、无业务 case）",
        )}
      />

      <Tabs defaultValue="jobs" className="space-y-4">
        <TabsList>
          <TabsTrigger value="jobs">{t("distillation.tab.jobs", "作业")}</TabsTrigger>
          <TabsTrigger value="routing">{t("distillation.tab.routing", "路由提案")}</TabsTrigger>
          <TabsTrigger value="skills">{t("distillation.tab.skills", "员工 Skill")}</TabsTrigger>
          <TabsTrigger value="settings">{t("distillation.tab.settings", "设置")}</TabsTrigger>
        </TabsList>

        <TabsContent value="jobs">
          <Card>
            <CardContent className="p-6 space-y-4">
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => startJob("incremental")} disabled={starting || !!activeJob}>
                  {starting ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Play className="w-4 h-4 mr-2" />}
                  {t("distillation.startIncremental", "开始增量蒸馏")}
                </Button>
                <Button variant="secondary" onClick={() => startJob("full_relearn")} disabled={starting || !!activeJob}>
                  {t("distillation.startFull", "全量重学")}
                </Button>
              </div>
              {activeJob && (
                <div className="space-y-3 rounded-lg border p-4 bg-muted/20">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs text-foreground font-semibold">
                        {activeJob.id.slice(0, 8)}…
                      </span>
                      <Badge variant="outline">{activeJob.mode}</Badge>
                      <Badge
                        variant={
                          activeJob.status === "paused"
                            ? "secondary"
                            : activeJob.status === "running"
                            ? "default"
                            : "outline"
                        }
                      >
                        {activeJob.status}
                      </Badge>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs">
                        {activeJob.processedItems}/{activeJob.totalItems}
                      </span>
                      {(activeJob.status === "running" || activeJob.status === "pending") && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handlePause(activeJob.id)}
                          disabled={actionJobId === activeJob.id}
                        >
                          {actionJobId === activeJob.id ? (
                            <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
                          ) : (
                            <Pause className="w-3.5 h-3.5 mr-1" />
                          )}
                          {t("distillation.pause", "暂停")}
                        </Button>
                      )}
                      {activeJob.status === "paused" && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleResume(activeJob.id)}
                          disabled={actionJobId === activeJob.id}
                        >
                          {actionJobId === activeJob.id ? (
                            <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
                          ) : (
                            <Play className="w-3.5 h-3.5 mr-1" />
                          )}
                          {t("distillation.resume", "继续")}
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() => openTerminateConfirm(activeJob.id)}
                        disabled={actionJobId === activeJob.id || terminating}
                      >
                        <Square className="w-3.5 h-3.5 mr-1" />
                        {t("distillation.terminate", "终止")}
                      </Button>
                    </div>
                  </div>
                  <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
                    <div
                      className="h-full bg-primary transition-all"
                      style={{
                        width: `${activeJob.totalItems ? (activeJob.processedItems / activeJob.totalItems) * 100 : 0}%`,
                      }}
                    />
                  </div>
                </div>
              )}
              <div className="divide-y rounded-md border">
                {jobs.slice(0, 8).map((job) => {
                  const isActive =
                    job.status === "running" ||
                    job.status === "pending" ||
                    job.status === "paused";
                  return (
                    <div
                      key={job.id}
                      className="flex items-center justify-between p-3 text-sm gap-2"
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs">{job.id.slice(0, 8)}…</span>
                        <Badge variant="outline">{job.mode}</Badge>
                        <Badge
                          variant={
                            job.status === "paused"
                              ? "secondary"
                              : job.status === "completed"
                              ? "default"
                              : job.status === "cancelled"
                              ? "destructive"
                              : "outline"
                          }
                        >
                          {job.status}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="text-muted-foreground text-xs">
                          {job.processedItems}/{job.totalItems}
                        </span>
                        {isActive && (
                          <div className="flex items-center gap-1">
                            {(job.status === "running" || job.status === "pending") && (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 px-2 text-xs"
                                onClick={() => handlePause(job.id)}
                                disabled={actionJobId === job.id}
                              >
                                {actionJobId === job.id ? (
                                  <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                                ) : (
                                  <Pause className="w-3 h-3 mr-1" />
                                )}
                                {t("distillation.pause", "暂停")}
                              </Button>
                            )}
                            {job.status === "paused" && (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 px-2 text-xs"
                                onClick={() => handleResume(job.id)}
                                disabled={actionJobId === job.id}
                              >
                                {actionJobId === job.id ? (
                                  <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                                ) : (
                                  <Play className="w-3 h-3 mr-1" />
                                )}
                                {t("distillation.resume", "继续")}
                              </Button>
                            )}
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 px-2 text-xs text-destructive hover:text-destructive hover:bg-destructive/10"
                              onClick={() => openTerminateConfirm(job.id)}
                              disabled={actionJobId === job.id || terminating}
                            >
                              <Square className="w-3 h-3 mr-1" />
                              {t("distillation.terminate", "终止")}
                            </Button>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="routing">
          <Card>
            <CardContent className="p-6 space-y-4">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                {t("distillation.activeVersion", "当前生效版本")}:
                <Badge variant="secondary">{activeOverlay ?? t("distillation.none", "无")}</Badge>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" onClick={validateProposals} disabled={validating || draftCount === 0}>
                  {validating ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                  {t("distillation.validate", "预校验")} ({draftCount})
                </Button>
                <Button onClick={applyRouting} disabled={applying || validatedCount === 0}>
                  {applying ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <CheckCircle2 className="w-4 h-4 mr-2" />}
                  {t("distillation.apply", "一键使用")} ({validatedCount})
                </Button>
                <Button variant="outline" onClick={rollbackRouting}>
                  <RotateCcw className="w-4 h-4 mr-2" />
                  {t("distillation.rollback", "回滚")}
                </Button>
              </div>
              <div className="space-y-2 max-h-80 overflow-y-auto">
                {proposals.slice(0, 30).map((p) => (
                  <div key={p.id} className="rounded-md border p-3 text-xs font-mono">
                    <div className="flex gap-2 mb-1">
                      <Badge>{p.status}</Badge>
                      <span className="text-muted-foreground">{p.sourceUserId?.slice(0, 8)}</span>
                    </div>
                    <pre className="whitespace-pre-wrap break-all opacity-80">{p.payload}</pre>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="skills">
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardContent className="p-6 space-y-3">
                {skills.length === 0 && (
                  <p className="text-sm text-muted-foreground">{t("distillation.noSkills", "暂无 Skill，请先运行蒸馏")}</p>
                )}
                {skills.map((s) => (
                  <div key={s.userId} className="flex items-center justify-between rounded-lg border p-3">
                    <div>
                      <p className="font-medium">{s.username}</p>
                      <p className="text-xs text-muted-foreground">v{s.version} · {s.sourceRecordCount} records</p>
                    </div>
                    <div className="flex gap-2">
                      <Button size="sm" variant="secondary" onClick={() => previewUserSkill(s.userId)}>
                        {t("distillation.preview", "预览")}
                      </Button>
                      <Button size="sm" onClick={() => downloadSkill(s.userId, s.username).catch((e) => toast.error(e.message))}>
                        <Download className="w-4 h-4 mr-1" />
                        {t("distillation.download", "下载")}
                      </Button>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-6">
                {previewSkill ? (
                  <div className="space-y-3 max-h-[480px] overflow-y-auto">
                    <h3 className="font-semibold">{previewSkill.username} · v{previewSkill.version}</h3>
                    {previewSkill.files &&
                      Object.entries(previewSkill.files).map(([name, content]) => (
                        <div key={name}>
                          <Badge variant="outline" className="mb-1">{name}</Badge>
                          <pre className="text-xs whitespace-pre-wrap rounded-md bg-muted p-3">{content}</pre>
                        </div>
                      ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">{t("distillation.selectPreview", "选择成员预览 Skill")}</p>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="settings">
          <Card>
            <CardContent className="p-6 space-y-4 max-w-lg">
              {settings && (
                <>
                  <label className="text-sm font-medium block">{t("distillation.analysisRoute", "分析 Route")}</label>
                  <select
                    className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                    value={settings.analysisRouteId ?? ""}
                    onChange={(e) => setSettings({ ...settings, analysisRouteId: e.target.value || null })}
                  >
                    <option value="">{t("distillation.heuristicFallback", "启发式（无 LLM）")}</option>
                    {routes.map((r) => (
                      <option key={r.id} value={r.id}>{r.name}</option>
                    ))}
                  </select>
                  <label className="text-sm font-medium block">{t("distillation.concurrency", "并发度")}</label>
                  <input
                    type="number"
                    min={1}
                    max={5}
                    className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                    value={settings.concurrency}
                    onChange={(e) => setSettings({ ...settings, concurrency: Number(e.target.value) })}
                  />
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={settings.cronEnabled}
                      onChange={(e) => setSettings({ ...settings, cronEnabled: e.target.checked })}
                    />
                    {t("distillation.cronEnabled", "每日定时增量")}
                  </label>
                  <input
                    className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm font-mono"
                    value={settings.cron}
                    onChange={(e) => setSettings({ ...settings, cron: e.target.value })}
                  />
                  <Button onClick={saveSettings}>{t("distillation.saveSettings", "保存设置")}</Button>
                </>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <ConfirmDialog
        open={terminateConfirmOpen}
        onOpenChange={setTerminateConfirmOpen}
        title={t("distillation.confirmTerminateTitle", "终止作业")}
        description={t(
          "distillation.confirmTerminate",
          "确定要终止此蒸馏作业吗？未处理的记录将被取消。",
        )}
        confirmLabel={t("distillation.terminate", "终止")}
        variant="destructive"
        onConfirm={handleConfirmTerminate}
        loading={terminating}
      />
    </div>
  );
}
