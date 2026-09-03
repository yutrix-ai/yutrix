import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { fetchApi } from "@/lib/api";
import {
  DEFAULT_PROVIDER_STREAM_TIMEOUT_MS,
  DEFAULT_PROVIDER_TIMEOUT_MS,
  nextCopyRouteName,
} from "@promptgate/shared";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { CheckCircle, XCircle } from "lucide-react";

interface FormData {
  name: string;
  openaiBaseUrl: string;
  anthropicBaseUrl: string;
  apiKey: string;
  timeoutMs: number;
  streamTimeoutMs: number;
  concurrencyLimit: number;
  maxOutputTokens: number;
  hourlyTokenLimit: number;
  enabled: boolean;
  upstreamProxyUrl: string;
  weightProxyUrl: string;
}

interface ProviderEditModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  provider: any | null; // null means 'create'
  copying?: boolean;
  existingNames?: string[];
  onSaveSuccess: () => void;
}

export function ProviderEditModal({
  open,
  onOpenChange,
  provider,
  copying = false,
  existingNames = [],
  onSaveSuccess,
}: ProviderEditModalProps) {
  const { t } = useTranslation();
  
  const [formData, setFormData] = useState<FormData>({
    name: "",
    openaiBaseUrl: "",
    anthropicBaseUrl: "",
    apiKey: "",
    timeoutMs: DEFAULT_PROVIDER_TIMEOUT_MS,
    streamTimeoutMs: DEFAULT_PROVIDER_STREAM_TIMEOUT_MS,
    concurrencyLimit: 4,
    maxOutputTokens: 0,
    hourlyTokenLimit: 0,
    enabled: true,
    upstreamProxyUrl: "",
    weightProxyUrl: "",
  });

  const [testResult, setTestResult] = useState<any>(null);
  const [testing, setTesting] = useState(false);
  const [currentModels, setCurrentModels] = useState<string[]>([]);
  const [newModelInput, setNewModelInput] = useState("");
  const isEditing = Boolean(provider && !copying);

  useEffect(() => {
    if (open) {
      if (provider) {
        const computedName = copying
          ? nextCopyRouteName(
              provider.name,
              existingNames || [],
              t("providers.copyName.label", "副本"),
            )
          : provider.name;

        setFormData({
          name: computedName,
          openaiBaseUrl: provider.openaiBaseUrl || "",
          anthropicBaseUrl: provider.anthropicBaseUrl || "",
          apiKey: "",
          timeoutMs: provider.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS,
          streamTimeoutMs: provider.streamTimeoutMs ?? DEFAULT_PROVIDER_STREAM_TIMEOUT_MS,
          concurrencyLimit: provider.concurrencyLimit ?? 4,
          maxOutputTokens: provider.maxOutputTokens || 0,
          hourlyTokenLimit: provider.hourlyTokenLimit || 0,
          enabled: provider.enabled ?? true,
          upstreamProxyUrl: provider.upstreamProxyUrl || "",
          weightProxyUrl: provider.weightProxyUrl || "",
        });
        
        let initialModels: string[] = [];
        if (Array.isArray(provider.manualModels) && provider.manualModels.length > 0) {
          initialModels = [...provider.manualModels];
        } else if (typeof provider.manualModels === "string") {
          try {
            const parsed = JSON.parse(provider.manualModels);
            if (Array.isArray(parsed)) initialModels = parsed;
          } catch {}
        }
        setCurrentModels(initialModels);

        // Fetch models from server if we don't have manual models locally in provider object or to load source models
        if (provider.id) {
          fetchApi(`/admin/providers/${provider.id}/models`).then((serverModels: any[]) => {
            if (serverModels && Array.isArray(serverModels) && serverModels.length > 0) {
              const serverModelIds = serverModels.map((m: any) => m.modelId || m.id).filter(Boolean);
              setCurrentModels(prev => Array.from(new Set([...prev, ...serverModelIds])));
            }
          }).catch(() => {
            // Ignore
          });
        }
      } else {
        // Reset for create
        setFormData({
          name: "",
          openaiBaseUrl: "",
          anthropicBaseUrl: "",
          apiKey: "",
          timeoutMs: DEFAULT_PROVIDER_TIMEOUT_MS,
          streamTimeoutMs: DEFAULT_PROVIDER_STREAM_TIMEOUT_MS,
          concurrencyLimit: 4,
          maxOutputTokens: 0,
          hourlyTokenLimit: 0,
          enabled: true,
          upstreamProxyUrl: "",
          weightProxyUrl: "",
        });
        setCurrentModels([]);
      }
      setTestResult(null);
    }
  }, [open, provider, copying]);

  const handleTest = async () => {
    if (!formData.openaiBaseUrl && !formData.anthropicBaseUrl) {
      return toast.error(t("providers.toasts.fillUrl", "请填写 OpenAI 或 Anthropic 协议 URL"));
    }

    setTesting(true);
    try {
      const res = await fetchApi("/admin/providers/test", {
        method: "POST",
        body: JSON.stringify({
          providerId: isEditing ? provider?.id : undefined,
          openaiBaseUrl: formData.openaiBaseUrl || undefined,
          anthropicBaseUrl: formData.anthropicBaseUrl || undefined,
          apiKey: formData.apiKey || undefined,
          upstreamProxyUrl: formData.upstreamProxyUrl || undefined,
          manualModels: currentModels.length > 0 ? currentModels : undefined
        }),
      });
      setTestResult(res);
      if (res.success) {
        toast.success(t("providers.toasts.testPassed", "连接测试通过"));
        if (!currentModels || currentModels.length === 0) {
          if (res.models && Array.isArray(res.models)) {
            setCurrentModels(Array.from(new Set(res.models.map((m: any) => m.id))));
          }
        }
      }
      else toast.error(t("providers.toasts.testFailed", "连接测试失败") + ": " + res.message);
    } catch (e: any) {
      setTestResult({ success: false, message: e.message, models: [] });
      toast.error(t("providers.toasts.testException", "连接测试发生异常") + ": " + e.message);
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();

    const url = isEditing ? `/admin/providers/${provider.id}` : "/admin/providers";
    const method = isEditing ? "PATCH" : "POST";

    try {
      await fetchApi(url, {
        method,
        body: JSON.stringify({
          ...formData,
          apiKey: !isEditing && formData.apiKey ? formData.apiKey : undefined,
          testSessionId: testResult?.success ? testResult.testSessionId : undefined,
          manualModels: currentModels.length > 0 ? currentModels : undefined
        }),
      });
      toast.success(t("providers.toasts.saveSuccess", "供应商保存成功"));
      onSaveSuccess();
      onOpenChange(false);
    } catch (e: any) {
      toast.error(t("providers.toasts.saveFailed", "保存失败") + ": " + e.message);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-5xl h-[85vh] flex flex-col p-0 overflow-hidden bg-background">
        <DialogHeader className="px-6 py-4 border-b shrink-0 bg-muted/30">
          <DialogTitle>
            {copying
              ? t("providers.dialog.copyTitle", "复制供应商")
              : isEditing
              ? t("providers.dialog.editTitle", "编辑供应商")
              : t("providers.dialog.addTitle", "添加新供应商")}
          </DialogTitle>
          <DialogDescription>
            {copying
              ? t("providers.dialog.copyDesc", "已复制原供应商配置。请确认名称并在需要时重新输入密钥。")
              : isEditing
              ? t("providers.dialog.editDesc", "更新供应商配置。")
              : t("providers.dialog.addDesc", "配置 OpenAI 兼容或 Anthropic 协议的供应商信息，并在右侧进行连通性测试。")}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSave} className="flex-1 flex flex-col min-h-0 overflow-hidden" autoComplete="off">
          <div className="flex-1 flex min-h-0 overflow-hidden">
            {/* Left side: Form */}
            <div className="w-1/2 p-6 border-r flex flex-col overflow-hidden">
              <div className="space-y-6">
                <div className="space-y-2">
                  <Label className="flex items-center">
                    {t("providers.fields.name", "供应商名称")}
                    <span className="text-destructive ml-1">*</span>
                  </Label>
                  <Input
                    placeholder={t("providers.placeholders.name", "例如: OpenAI 官方")}
                    value={formData.name}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    required
                  />
                </div>

                {!isEditing && (
                  <div className="space-y-2">
                    <Label className="flex items-center gap-2">
                      {t("providers.fields.apiKey", "API Key")}
                      <span className="text-xs text-muted-foreground font-normal ml-2">
                        {t("providers.hints.testKey", "(用于初始连通性测试，保存后自动作为第一个密钥)")}
                      </span>
                    </Label>
                    <Input
                      type="text"
                      autoComplete="new-password"
                      placeholder="sk-..."
                      value={formData.apiKey}
                      onChange={(e) =>
                        setFormData({ ...formData, apiKey: e.target.value })
                      }
                    />
                  </div>
                )}

                <div className="grid grid-cols-1 gap-4">
                  <div className="space-y-2">
                    <Label className="flex items-center gap-2">
                      {t("providers.fields.openaiUrl", "OpenAI 协议 URL")}
                    </Label>
                    <Input
                      placeholder="https://api.openai.com/v1"
                      value={formData.openaiBaseUrl}
                      onChange={(e) =>
                        setFormData({ ...formData, openaiBaseUrl: e.target.value })
                      }
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className="flex items-center gap-2">
                      {t("providers.fields.anthropicUrl", "Anthropic 协议 URL")}
                    </Label>
                    <Input
                      placeholder="https://api.anthropic.com"
                      value={formData.anthropicBaseUrl}
                      onChange={(e) =>
                        setFormData({ ...formData, anthropicBaseUrl: e.target.value })
                      }
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
                  <div className="space-y-2">
                    <Label className="flex items-center gap-2">
                      {t("providers.fields.upstreamProxyUrl", "Upstream Proxy URL")}
                    </Label>
                    <Input
                      placeholder="http://127.0.0.1:7890"
                      value={formData.upstreamProxyUrl}
                      onChange={(e) =>
                        setFormData({ ...formData, upstreamProxyUrl: e.target.value })
                      }
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className="flex items-center gap-2">
                      {t("providers.fields.weightProxyUrl", "Weight Proxy URL")}
                    </Label>
                    <Input
                      placeholder="http://10.8.0.68:11811"
                      value={formData.weightProxyUrl}
                      onChange={(e) =>
                        setFormData({ ...formData, weightProxyUrl: e.target.value })
                      }
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
                  <div className="space-y-2">
                    <Label>{t("providers.fields.timeout", "Timeout (ms)")}</Label>
                    <Input
                      type="number"
                      min="0"
                      value={formData.timeoutMs}
                      onChange={(e) =>
                        setFormData({ ...formData, timeoutMs: parseInt(e.target.value) || 0 })
                      }
                    />
                    <p className="text-xs text-muted-foreground leading-snug">
                      {t("providers.hints.timeout", "Enter 0 for no first-answer SLA")}
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label>{t("providers.fields.streamTimeout", "Stream Timeout (ms)")}</Label>
                    <Input
                      type="number"
                      min="0"
                      value={formData.streamTimeoutMs}
                      onChange={(e) =>
                        setFormData({ ...formData, streamTimeoutMs: parseInt(e.target.value) || 0 })
                      }
                    />
                    <p className="text-xs text-muted-foreground leading-snug">
                      {t("providers.hints.streamTimeout", "Idle limit between chunks after the first byte")}
                    </p>
                  </div>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 pt-2">
                  <div className="space-y-2">
                    <Label>{t("providers.fields.concurrency", "Concurrency Limit")}</Label>
                    <Input
                      type="number"
                      min="1"
                      value={formData.concurrencyLimit}
                      onChange={(e) =>
                        setFormData({ ...formData, concurrencyLimit: parseInt(e.target.value) || 10 })
                      }
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Hourly Token Limit</Label>
                    <Input
                      type="number"
                      min="0"
                      value={formData.hourlyTokenLimit}
                      onChange={(e) =>
                        setFormData({ ...formData, hourlyTokenLimit: parseInt(e.target.value) || 0 })
                      }
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* Right side: Test & Models */}
            <div className="w-1/2 p-6 flex flex-col min-h-0 overflow-hidden bg-muted/10">
              <div className="mb-4 shrink-0">
                <h3 className="text-sm font-semibold mb-1">{t("providers.test.title", "模型列表与连通性测试")}</h3>
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleTest}
                  disabled={testing}
                  className="w-full bg-background"
                >
                  {testing ? t("providers.test.testing", "测试中...") : t("providers.test.start", "开始测试")}
                </Button>
              </div>

              <div className="flex-1 min-h-0 pr-2 custom-scrollbar flex flex-col">
                <div className="flex-1 flex flex-col mb-4 min-h-0">
                  <div className="flex-1 border rounded-md bg-background flex flex-col min-h-0 overflow-hidden">
                    <div className="flex-1 overflow-y-auto p-3 custom-scrollbar flex flex-wrap content-start gap-2">
                      {currentModels.map((model, idx) => (
                        <Badge key={idx} variant="secondary" className="flex items-center gap-1 font-mono text-xs py-1 h-fit">
                          {model}
                          <XCircle 
                            className="h-3 w-3 cursor-pointer text-muted-foreground hover:text-foreground transition-colors" 
                            onClick={() => {
                              setCurrentModels(prev => prev.filter((_, i) => i !== idx));
                            }} 
                          />
                        </Badge>
                      ))}
                    </div>
                    
                    <div className="flex items-center gap-2 p-3 border-t border-border/50 shrink-0 bg-muted/5">
                      <Input 
                        placeholder="输入模型 ID，回车添加"
                        value={newModelInput}
                        className="text-xs h-8 flex-1"
                        onChange={e => setNewModelInput(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            if (newModelInput.trim()) {
                              setCurrentModels(prev => [...prev, newModelInput]);
                              setNewModelInput("");
                            }
                          }
                        }}
                      />
                    </div>
                  </div>
                </div>
                
                {testResult && (
                  <div className="shrink-0 overflow-y-auto max-h-[50%] custom-scrollbar mb-4">
                    <div
                      className={`p-4 rounded-md text-sm border ${
                      testResult.success
                        ? "bg-green-50/50 border-green-200 dark:bg-green-950/20 dark:border-green-900"
                        : "bg-red-50/50 border-red-200 dark:bg-red-950/20 dark:border-red-900"
                    }`}
                  >
                    {testResult.success ? (
                      <div className="flex items-center gap-2 text-green-700 dark:text-green-400 font-medium">
                        <CheckCircle className="h-4 w-4" />
                        {t("providers.test.success", "成功发现 {{count}} 个模型", { count: testResult.models.length })}
                      </div>
                    ) : (
                      <div className="flex items-center gap-2 text-red-700 dark:red-400">
                        <XCircle className="h-4 w-4" />
                        {testResult.message}
                      </div>
                    )}
                  </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          <DialogFooter className="px-6 py-4 border-t shrink-0 bg-muted/10">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {t("common.cancel", "取消")}
            </Button>
            <Button type="submit">
              {t("providers.actions.save", "保存供应商")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
