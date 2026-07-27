import { useEffect, useState } from "react";
import { fetchApi } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { StatusBadge } from "@/components/StatusBadge";
import { EmptyState } from "@/components/EmptyState";
import { KeyDisplay } from "@/components/KeyDisplay";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Key, ShieldCheck, RefreshCcw, Copy } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useSettings } from "@/contexts/SettingsContext";

interface OpenApiKey {
  id: string;
  name: string;
  keyPrefix: string;
  status: "active" | "disabled" | "revoked";
  createdAt: string;
  lastUsedAt?: string;
  userId?: string;
  username?: string;
}


function getStatusMeta(key: OpenApiKey, t: any) {
  if (key.status === "active") {
    return { status: "active" as const, label: t("openapi.status.active", "启用中") };
  }
  return { status: "disabled" as const, label: t("openapi.status.revoked", "已删除") };
}

export default function AdminOpenAPI() {
  const { t } = useTranslation();
  const { formatDateTime } = useSettings();
  const [keys, setKeys] = useState<OpenApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [createdKey, setCreatedKey] = useState("");
  const [createdKeyDialogOpen, setCreatedKeyDialogOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [revokeConfirm, setRevokeConfirm] = useState<{
    open: boolean;
    keyId: string | null;
    keyName: string;
  }>({ open: false, keyId: null, keyName: "" });
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState("");
  const [testApiKey, setTestApiKey] = useState("");
  const [testStartTime, setTestStartTime] = useState(() => {
    const d = new Date();
    d.setHours(d.getHours() - 24);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  });
  const [testEndTime, setTestEndTime] = useState(() => {
    const d = new Date();
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  });

  const loadKeys = async () => {
    try {
      const data = await fetchApi("/admin/openapi-keys");
      setKeys(data);
    } catch (error: any) {
      toast.error(error.message || t("common.error"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadKeys();
  }, []);

  const handleCreate = async () => {
    try {
      setResetting(true);
      const res = await fetchApi("/admin/openapi-keys", {
        method: "POST",
        body: JSON.stringify({ name: "OpenAPI Key" }),
      });
      setCreatedKey(res.apiKey);
      setCreatedKeyDialogOpen(true);
      await loadKeys();
      toast.success(t("openapi.actions.createSuccess", "创建成功"));
    } catch (error: any) {
      toast.error(error.message || t("common.error"));
    } finally {
      setResetting(false);
    }
  };

  const handleRevoke = async () => {
    if (!revokeConfirm.keyId) return;
    try {
      await fetchApi(`/admin/openapi-keys/${revokeConfirm.keyId}`, {
        method: "DELETE",
      });
      await loadKeys();
      toast.success(t("openapi.actions.deleteSuccess", "删除成功"));
    } catch (error: any) {
      toast.error(error.message || t("common.error"));
    } finally {
      setRevokeConfirm({ open: false, keyId: null, keyName: "" });
    }
  };

  const origin = typeof window !== "undefined" ? window.location.origin : "http://localhost:3000";
  const startIso = testStartTime ? new Date(testStartTime).toISOString() : "2024-01-01T00:00:00Z";
  const endIso = testEndTime ? new Date(testEndTime).toISOString() : "2024-12-31T23:59:59Z";
  const displayApiKey = testApiKey || "<Your-OpenAPI-Key>";

  const curlCommand = `curl -X GET "${origin}/api/openapi/v1/statistics?startTime=${startIso}&endTime=${endIso}" \\
  -H "Authorization: Bearer ${displayApiKey}"`;

  const httpCommand = `GET /api/openapi/v1/statistics?startTime=${startIso}&endTime=${endIso}\nAuthorization: Bearer ${displayApiKey}`;

  const handleTest = async () => {
    if (!testApiKey) {
      toast.error(t("openapi.doc.errorNoKey", "请先填写 API 密钥"));
      return;
    }
    try {
      setTesting(true);
      const response = await fetch(`${origin}/api/openapi/v1/statistics?startTime=${startIso}&endTime=${endIso}`, {
        headers: {
          "Authorization": `Bearer ${testApiKey}`
        }
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Request failed");
      }
      setTestResult(JSON.stringify(data, null, 2));
    } catch (error: any) {
      toast.error(error.message || t("common.error"));
      setTestResult(JSON.stringify({ error: error.message }, null, 2));
    } finally {
      setTesting(false);
    }
  };

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
    toast.success(t("common.copied", "已复制到剪贴板"));
  };

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">
            {t("openapi.title", "开放接口 (OpenAPI)")}
          </h1>
          <p className="text-muted-foreground mt-1">
            {t(
              "openapi.description",
              "管理 OpenAPI 访问密钥，调用系统级统计数据与状态接口。",
            )}
          </p>
        </div>
        <Button onClick={handleCreate} disabled={resetting || loading}>
          <ShieldCheck className="mr-2 h-4 w-4" />
          {t("openapi.actions.generate", "生成 API 密钥")}
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("apiKeys.fields.name", "名称")}</TableHead>
                <TableHead>{t("apiKeys.fields.key", "API 密钥")}</TableHead>
                <TableHead>{t("apiKeys.fields.status", "状态")}</TableHead>
                <TableHead>{t("apiKeys.fields.createdAt", "创建时间")}</TableHead>
                <TableHead>{t("apiKeys.fields.lastUsed", "最后使用")}</TableHead>
                <TableHead>{t("apiKeys.fields.createdBy", "创建人")}</TableHead>
                <TableHead className="text-right">
                  {t("common.actions", "操作")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                Array.from({ length: 3 }).map((_, i) => (
                  <TableRow key={i}>
                    <TableCell>
                      <Skeleton className="h-4 w-[120px]" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-4 w-[180px]" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-4 w-[80px]" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-4 w-[120px]" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-4 w-[120px]" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-4 w-[120px]" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-8 w-8 ml-auto" />
                    </TableCell>
                  </TableRow>
                ))
              ) : keys.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="h-32">
                    <EmptyState
                      icon={<Key className="h-12 w-12" />}
                      title={t("openapi.empty.title", "暂无 OpenAPI 密钥")}
                      description={t(
                        "openapi.empty.description",
                        "生成一个密钥以通过 API 访问系统统计信息",
                      )}
                    />
                  </TableCell>
                </TableRow>
              ) : (
                keys.map((key) => {
                  const meta = getStatusMeta(key, t);
                  return (
                    <TableRow key={key.id}>
                      <TableCell className="font-medium">
                        {key.name}
                      </TableCell>
                      <TableCell className="font-mono text-sm">
                        {key.keyPrefix}••••••••••••
                      </TableCell>
                      <TableCell>
                        <StatusBadge
                          status={meta.status}
                          label={meta.label}
                        />
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-muted-foreground whitespace-nowrap">
                        {formatDateTime(key.createdAt)}
                      </TableCell>
                      <TableCell className="hidden lg:table-cell text-muted-foreground whitespace-nowrap">
                        {formatDateTime(key.lastUsedAt)}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {key.username}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:text-destructive hover:bg-destructive/10"
                          onClick={() =>
                            setRevokeConfirm({
                              open: true,
                              keyId: key.id,
                              keyName: key.name,
                            })
                          }
                        >
                          {t("common.delete", "删除")}
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("openapi.doc.title", "接口文档与测试 (API Reference & Playground)")}</CardTitle>
          <CardDescription>
            {t("openapi.doc.description", "通过 API 获取系统统计数据。你需要将生成的 API 密钥放在请求头的 Authorization 字段中。")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            
            {/* Left side: Docs & Actions */}
            <div className="space-y-4 transition-all duration-300 flex flex-col h-full">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2 md:col-span-2">
                  <Label>{t("openapi.doc.apiKey", "API 密钥 (API Key)")}</Label>
                  <Input 
                    type="text" 
                    placeholder="pg_oa_..." 
                    value={testApiKey}
                    onChange={e => setTestApiKey(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label>{t("openapi.doc.startTime", "开始时间")}</Label>
                  <Input 
                    type="datetime-local" 
                    value={testStartTime}
                    onChange={e => setTestStartTime(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label>{t("openapi.doc.endTime", "结束时间")}</Label>
                  <Input 
                    type="datetime-local" 
                    value={testEndTime}
                    onChange={e => setTestEndTime(e.target.value)}
                  />
                </div>
              </div>

              <Tabs defaultValue="http" className="w-full">
                <TabsList>
                  <TabsTrigger value="http">HTTP</TabsTrigger>
                  <TabsTrigger value="curl">cURL</TabsTrigger>
                </TabsList>
                <TabsContent value="http" className="mt-4">
                  <div className="bg-muted p-4 pr-12 rounded-md overflow-x-auto text-sm font-mono relative group whitespace-pre">
                    <Button 
                      variant="ghost" 
                      size="icon" 
                      className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity"
                      onClick={() => handleCopy(httpCommand)}
                    >
                      <Copy className="h-4 w-4" />
                    </Button>
                    {httpCommand}
                  </div>
                </TabsContent>
                <TabsContent value="curl" className="mt-4">
                  <div className="bg-muted p-4 pr-12 rounded-md overflow-x-auto text-sm font-mono relative group whitespace-pre">
                    <Button 
                      variant="ghost" 
                      size="icon" 
                      className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity"
                      onClick={() => handleCopy(curlCommand)}
                    >
                      <Copy className="h-4 w-4" />
                    </Button>
                    {curlCommand}
                  </div>
                </TabsContent>
              </Tabs>

              <div className="flex gap-2 justify-end mt-auto pt-2">
                <Button onClick={handleTest} disabled={testing} variant="default">
                  {testing ? <RefreshCcw className="mr-2 h-4 w-4 animate-spin" /> : <ShieldCheck className="mr-2 h-4 w-4" />}
                  {t("openapi.doc.runBtn", "发送请求")}
                </Button>
              </div>
            </div>

            {/* Right side: Result */}
            <div className="flex flex-col h-full">
              <div className="flex justify-between items-center mb-2">
                <p className="text-sm font-medium">{t("openapi.doc.testResult", "测试结果：")}</p>
                {testResult && (
                  <Button variant="ghost" size="sm" onClick={() => handleCopy(testResult)} className="h-7 px-2 text-xs">
                    <Copy className="h-3 w-3 mr-1" /> Copy
                  </Button>
                )}
              </div>
              <div className="flex-1 bg-muted rounded-md border shadow-inner flex flex-col min-h-[200px]">
                {testResult ? (
                  <pre className="p-4 text-sm font-mono whitespace-pre-wrap overflow-y-auto max-h-[400px] custom-scrollbar">
                    {testResult}
                  </pre>
                ) : (
                  <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm p-4 text-center">
                    {t("openapi.doc.emptyResult", "暂无测试结果，请点击左侧按钮发送请求")}
                  </div>
                )}
              </div>
            </div>
            
          </div>
        </CardContent>
      </Card>

      <Dialog
        open={createdKeyDialogOpen}
        onOpenChange={(open) => {
          if (!open) {
            setCreatedKeyDialogOpen(false);
            setCreatedKey("");
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {t("apiKeys.created.title", "API 密钥已生成")}
            </DialogTitle>
            <DialogDescription>
              {t(
                "apiKeys.created.description",
                "请妥善保存此密钥。出于安全考虑，它将只显示一次。",
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <KeyDisplay keyValue={createdKey} />
          </div>
          <DialogFooter>
            <Button onClick={() => setCreatedKeyDialogOpen(false)}>
              {t("common.close", "关闭")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={revokeConfirm.open}
        onOpenChange={(open) => {
          if (!open) setRevokeConfirm({ open: false, keyId: null, keyName: "" });
        }}
        title={t("openapi.delete.title", "删除 OpenAPI 密钥")}
        description={t(
          "openapi.delete.description",
          "您确定要删除此 OpenAPI 密钥吗？删除后相关的 API 访问将立即失效。",
          { name: revokeConfirm.keyName },
        )}
        onConfirm={handleRevoke}
        confirmLabel={t("common.delete", "删除")}
        variant="destructive"
      />
    </div>
  );
}
