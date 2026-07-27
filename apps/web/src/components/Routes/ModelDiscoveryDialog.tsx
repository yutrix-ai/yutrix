import { useState, useEffect, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogBody,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useTranslation } from "react-i18next";
import { fetchApi } from "@/lib/api";
import { toast } from "sonner";
import { Save, XCircle } from "lucide-react";

interface ModelDiscoveryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ModelDiscoveryDialog({
  open,
  onOpenChange,
}: ModelDiscoveryDialogProps) {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState(true);
  const [openaiModels, setOpenaiModels] = useState<string[]>([]);
  const [anthropicModels, setAnthropicModels] = useState<string[]>([]);
  const [openaiInput, setOpenaiInput] = useState("");
  const [anthropicInput, setAnthropicInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const loadSettings = useCallback(async () => {
    try {
      const res = await fetchApi("/admin/settings");
      const map: Record<string, string> = {};
      res.forEach((s: any) => {
        map[s.key] = s.value;
      });

      setEnabled(map.modelDiscoveryEnabled !== "false");

      if (map.modelDiscoveryOpenai) {
        try {
          const parsed = JSON.parse(map.modelDiscoveryOpenai);
          if (Array.isArray(parsed)) setOpenaiModels(parsed);
        } catch {
          /* ignore */
        }
      }

      if (map.modelDiscoveryAnthropic) {
        try {
          const parsed = JSON.parse(map.modelDiscoveryAnthropic);
          if (Array.isArray(parsed)) setAnthropicModels(parsed);
        } catch {
          /* ignore */
        }
      }

      setLoaded(true);
    } catch (e: any) {
      toast.error(
        t("routes.modelDiscovery.loadFailed", "加载模型发现配置失败") +
          ": " +
          e.message
      );
    }
  }, [t]);

  useEffect(() => {
    if (open) {
      loadSettings();
    }
  }, [open, loadSettings]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await fetchApi("/admin/settings", {
        method: "POST",
        body: JSON.stringify({
          settings: [
            {
              key: "modelDiscoveryEnabled",
              value: enabled ? "true" : "false",
            },
            {
              key: "modelDiscoveryOpenai",
              value: JSON.stringify(openaiModels),
            },
            {
              key: "modelDiscoveryAnthropic",
              value: JSON.stringify(anthropicModels),
            },
          ],
        }),
      });
      toast.success(
        t("routes.modelDiscovery.saveSuccess", "模型发现配置已保存")
      );
      onOpenChange(false);
    } catch (e: any) {
      toast.error(
        t("routes.modelDiscovery.saveFailed", "保存失败") + ": " + e.message
      );
    } finally {
      setSaving(false);
    }
  };

  const addModel = (
    list: string[],
    setList: React.Dispatch<React.SetStateAction<string[]>>,
    input: string,
    setInput: React.Dispatch<React.SetStateAction<string>>
  ) => {
    const trimmed = input.trim();
    if (trimmed && !list.includes(trimmed)) {
      setList((prev) => [...prev, trimmed]);
    }
    setInput("");
  };

  const removeModel = (
    list: string[],
    setList: React.Dispatch<React.SetStateAction<string[]>>,
    index: number
  ) => {
    setList((prev) => prev.filter((_, i) => i !== index));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl flex flex-col max-h-[85vh]">
        <DialogHeader>
          <DialogTitle>
            {t("routes.modelDiscovery.title", "配置模型发现列表")}
          </DialogTitle>
          <DialogDescription>
            {t(
              "routes.modelDiscovery.desc",
              "配置 /v1/models 端点返回的模型列表。客户端（如 Claude、opencode）连接网关时将从此列表中拉取可用模型名称。启用后，返回的模型列表与系统中具体路由到的实际配置模型完全脱钩，确保最佳兼容性。"
            )}
          </DialogDescription>
        </DialogHeader>

        {loaded ? (
          <DialogBody className="space-y-4 py-4 min-h-0">
            {/* Enable switch */}
            <div className="flex items-center justify-between gap-4 border-b pb-4">
              <div className="min-w-0">
                <Label
                  htmlFor="modelDiscoveryEnabled"
                  className="text-sm font-medium"
                >
                  {t(
                    "routes.modelDiscovery.enableLabel",
                    "启用自定义模型发现列表"
                  )}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t(
                    "routes.modelDiscovery.enableDesc",
                    "关闭后 /v1/models 仅返回默认占位模型"
                  )}
                </p>
              </div>
              <Switch
                id="modelDiscoveryEnabled"
                checked={enabled}
                onCheckedChange={setEnabled}
              />
            </div>

            {enabled && (
              <div className="grid gap-4 md:grid-cols-2">
                {/* OpenAI Models */}
                <div className="space-y-2 flex flex-col h-[300px]">
                  <Label className="text-xs font-medium flex items-center gap-1.5 shrink-0">
                    <Badge
                      variant="outline"
                      className="text-[10px] px-1 py-0 h-4 border-green-300 text-green-700 dark:border-green-700 dark:text-green-400"
                    >
                      OpenAI
                    </Badge>
                    {t("routes.modelDiscovery.modelListLabel", "模型列表")}
                  </Label>
                  <div className="border rounded-md bg-background flex flex-col flex-1 min-h-0 overflow-hidden">
                    <div className="flex-1 overflow-y-auto p-2 flex flex-wrap content-start gap-1.5 custom-scrollbar">
                      {openaiModels.map((model, idx) => (
                        <Badge
                          key={idx}
                          variant="secondary"
                          className="flex items-center gap-1 font-mono text-[11px] py-0.5 h-fit"
                        >
                          {model}
                          <XCircle
                            className="h-3 w-3 cursor-pointer text-muted-foreground hover:text-foreground transition-colors"
                            onClick={() =>
                              removeModel(openaiModels, setOpenaiModels, idx)
                            }
                          />
                        </Badge>
                      ))}
                      {openaiModels.length === 0 && (
                        <span className="text-xs text-muted-foreground p-1">
                          {t(
                            "routes.modelDiscovery.emptyHint",
                            "暂无模型，请在下方输入添加"
                          )}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 p-2 border-t border-border/50 shrink-0 bg-muted/5">
                      <Input
                        placeholder={t(
                          "routes.modelDiscovery.inputPlaceholder",
                          "输入模型 ID，回车添加"
                        )}
                        value={openaiInput}
                        className="text-xs h-7 flex-1"
                        onChange={(e) => setOpenaiInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            addModel(
                              openaiModels,
                              setOpenaiModels,
                              openaiInput,
                              setOpenaiInput
                            );
                          }
                        }}
                      />
                    </div>
                  </div>
                </div>

                {/* Anthropic Models */}
                <div className="space-y-2 flex flex-col h-[300px]">
                  <Label className="text-xs font-medium flex items-center gap-1.5 shrink-0">
                    <Badge
                      variant="outline"
                      className="text-[10px] px-1 py-0 h-4 border-amber-300 text-amber-700 dark:border-amber-700 dark:text-amber-400"
                    >
                      Anthropic
                    </Badge>
                    {t("routes.modelDiscovery.modelListLabel", "模型列表")}
                  </Label>
                  <div className="border rounded-md bg-background flex flex-col flex-1 min-h-0 overflow-hidden">
                    <div className="flex-1 overflow-y-auto p-2 flex flex-wrap content-start gap-1.5 custom-scrollbar">
                      {anthropicModels.map((model, idx) => (
                        <Badge
                          key={idx}
                          variant="secondary"
                          className="flex items-center gap-1 font-mono text-[11px] py-0.5 h-fit"
                        >
                          {model}
                          <XCircle
                            className="h-3 w-3 cursor-pointer text-muted-foreground hover:text-foreground transition-colors"
                            onClick={() =>
                              removeModel(
                                anthropicModels,
                                setAnthropicModels,
                                idx
                              )
                            }
                          />
                        </Badge>
                      ))}
                      {anthropicModels.length === 0 && (
                        <span className="text-xs text-muted-foreground p-1">
                          {t(
                            "routes.modelDiscovery.emptyHint",
                            "暂无模型，请在下方输入添加"
                          )}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 p-2 border-t border-border/50 shrink-0 bg-muted/5">
                      <Input
                        placeholder={t(
                          "routes.modelDiscovery.inputPlaceholder",
                          "输入模型 ID，回车添加"
                        )}
                        value={anthropicInput}
                        className="text-xs h-7 flex-1"
                        onChange={(e) => setAnthropicInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            addModel(
                              anthropicModels,
                              setAnthropicModels,
                              anthropicInput,
                              setAnthropicInput
                            );
                          }
                        }}
                      />
                    </div>
                  </div>
                </div>
              </div>
            )}
          </DialogBody>
        ) : (
          <div className="h-[200px] flex items-center justify-center text-sm text-muted-foreground">
            {t("common.loading", "加载中...")}
          </div>
        )}

        <DialogFooter className="border-t pt-4">
          <Button
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
          >
            {t("common.cancel", "取消")}
          </Button>
          <Button size="sm" onClick={handleSave} disabled={saving}>
            <Save className="h-3.5 w-3.5 mr-1.5" />
            {saving
              ? t("routes.modelDiscovery.saving", "保存中...")
              : t("routes.modelDiscovery.save", "保存")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
