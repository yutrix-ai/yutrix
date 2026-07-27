import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { FormField } from "@/components/FormField";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useTranslation } from "react-i18next";

export function PolicyFormDialog({ open, onOpenChange, formData, setFormData, handleSave }: any) {
  const { t } = useTranslation();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>{t("policies.dialog.addTitle", "添加提示词策略")}</DialogTitle>
          <DialogDescription>
            {t("policies.dialog.addDesc", "创建新的提示词注入策略")}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSave} className="flex-1 flex flex-col min-h-0">
          <DialogBody className="py-4">
            <div className="space-y-4">
              <FormField label={t("policies.fields.name", "策略名称")} required>
                <Input
                  placeholder={t("policies.placeholders.name", "例如: 安全防护策略")}
                  value={formData.name}
                  onChange={(e) =>
                    setFormData({ ...formData, name: e.target.value })
                  }
                  required
                  autoFocus
                />
              </FormField>

              <FormField label={t("policies.fields.description", "描述说明")}>
                <Input
                  placeholder={t("policies.placeholders.description", "可选，用于说明此策略的用途")}
                  value={formData.description}
                  onChange={(e) =>
                    setFormData({ ...formData, description: e.target.value })
                  }
                />
              </FormField>

              <div className="grid grid-cols-2 gap-4">
                <FormField label={t("policies.fields.protocol", "协议类型")}>
                  <Select
                    value={formData.protocol}
                    onValueChange={(value) =>
                      setFormData({ ...formData, protocol: value })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="openai">{t("policies.options.openai", "OpenAI 格式")}</SelectItem>
                      <SelectItem value="anthropic">{t("policies.options.anthropic", "Anthropic 格式")}</SelectItem>
                    </SelectContent>
                  </Select>
                </FormField>

                <FormField label={t("policies.fields.injectMode", "注入模式")}>
                  <Select
                    value={formData.injectMode}
                    onValueChange={(value) =>
                      setFormData({ ...formData, injectMode: value })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="every_request">{t("policies.options.everyRequest", "每次请求注入")}</SelectItem>
                      <SelectItem value="once_per_conversation">{t("policies.options.oncePerConversation", "防重复注入")}</SelectItem>
                    </SelectContent>
                  </Select>
                </FormField>
              </div>

              <FormField label={t("policies.fields.injectPosition", "注入位置")}>
                <Select
                  value={formData.injectPosition}
                  onValueChange={(value) =>
                    setFormData({ ...formData, injectPosition: value })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="append_system">{t("policies.options.appendSystem", "追加到 System Prompt 末尾")}</SelectItem>
                    <SelectItem value="messages_unshift">{t("policies.options.messagesUnshift", "插入到 Messages 头部")}</SelectItem>
                    <SelectItem value="replace_system">{t("policies.options.replaceSystem", "替换原有 System Prompt")}</SelectItem>
                    <SelectItem value="system">{t("policies.options.system", "覆盖系统提示词")}</SelectItem>
                  </SelectContent>
                </Select>
              </FormField>

              {formData.injectMode === "once_per_conversation" && (
                <Card>
                  <CardContent className="pt-6 space-y-4">
                    <div className="font-medium text-sm">{t("policies.conversation.title", "防重复注入设置")}</div>
                    <FormField label={t("policies.conversation.keySource", "会话 ID 来源")}>
                      <Select
                        value={formData.conversationKeySource}
                        onValueChange={(value) =>
                          setFormData({ ...formData, conversationKeySource: value })
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="header">{t("policies.conversation.sourceHeader", "从 Header 获取会话 ID")}</SelectItem>
                          <SelectItem value="body">{t("policies.conversation.sourceBody", "从 Body 获取会话 ID")}</SelectItem>
                        </SelectContent>
                      </Select>
                    </FormField>

                    <FormField label={t("policies.conversation.keyName", "会话 ID Key 名称")}>
                      <Input
                        placeholder="X-Conversation-Id"
                        value={formData.conversationKeyName}
                        onChange={(e) =>
                          setFormData({ ...formData, conversationKeyName: e.target.value })
                        }
                      />
                    </FormField>

                    <FormField label={t("policies.conversation.fallbackMode", "无 ID 时的处理模式")}>
                      <Select
                        value={formData.fallbackMode}
                        onValueChange={(value) =>
                          setFormData({ ...formData, fallbackMode: value })
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="treat_as_new">{t("policies.options.fallbackTreatAsNew", "视为新请求直接注入")}</SelectItem>
                          <SelectItem value="skip_injection">{t("policies.options.fallbackSkip", "跳过注入")}</SelectItem>
                          <SelectItem value="error">{t("policies.options.fallbackError", "抛出错误并拦截")}</SelectItem>
                        </SelectContent>
                      </Select>
                    </FormField>
                  </CardContent>
                </Card>
              )}

              <FormField label={t("policies.fields.content", "注入内容")} required hint={t("policies.hints.content", "支持文本或 JSON 格式")}>
                <Textarea
                  placeholder={t("policies.placeholders.content", "输入要注入的提示词内容...")}
                  rows={6}
                  value={formData.content}
                  onChange={(e) =>
                    setFormData({ ...formData, content: e.target.value })
                  }
                  required
                />
              </FormField>

              <div className="flex items-center justify-between">
                <Label htmlFor="policyEnabled">{t("policies.fields.enabled", "创建后立即启用")}</Label>
                <Switch
                  id="policyEnabled"
                  checked={formData.enabled}
                  onCheckedChange={(checked) =>
                    setFormData({ ...formData, enabled: checked })
                  }
                />
              </div>

            </div>
          </DialogBody>

          <DialogFooter className="pt-4 border-t">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              {t("common.cancel", "取消")}
            </Button>
            <Button type="submit">{t("common.save", "保存")}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
