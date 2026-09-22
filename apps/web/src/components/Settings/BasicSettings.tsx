import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { FormField } from "@/components/FormField";
import { Globe, Plus, X, Star } from "lucide-react";
import {
  parseMainDomains,
  formatMainDomains,
  isValidDomain,
  normalizeDomain,
} from "@promptgate/shared";

interface BasicSettingsProps {
  settings: Record<string, string>;
  updateSetting: (key: string, value: string) => void;
}

export function BasicSettings({ settings, updateSetting }: BasicSettingsProps) {
  const { t } = useTranslation();
  const [newDomainInput, setNewDomainInput] = useState("");
  const [domainError, setDomainError] = useState("");

  const domainList = parseMainDomains(settings.mainDomain || "");

  const handleAddDomain = (rawText?: string) => {
    const textToAdd = rawText !== undefined ? rawText : newDomainInput;
    if (!textToAdd.trim()) return;

    // Support entering or pasting multiple domains (comma, semicolon, newline, whitespace)
    const incomingDomains = parseMainDomains(textToAdd);
    if (incomingDomains.length === 0) {
      setDomainError(t("settings.sections.basic.domainInvalid", "请输入有效的域名格式（如 example.com）"));
      return;
    }

    const currentSet = new Set(domainList);
    const added: string[] = [];

    for (const d of incomingDomains) {
      if (!isValidDomain(d)) {
        setDomainError(t("settings.sections.basic.domainInvalid", "请输入有效的域名格式（如 example.com）"));
        return;
      }
      if (!currentSet.has(d)) {
        currentSet.add(d);
        added.push(d);
      }
    }

    if (added.length === 0) {
      setDomainError(t("settings.sections.basic.domainExists", "该域名已存在于列表中"));
      return;
    }

    const updated = [...domainList, ...added];
    updateSetting("mainDomain", formatMainDomains(updated));
    setNewDomainInput("");
    setDomainError("");
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      handleAddDomain();
    }
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const pasted = e.clipboardData.getData("text");
    if (pasted && (pasted.includes(",") || pasted.includes("\n") || pasted.includes(" "))) {
      e.preventDefault();
      handleAddDomain(pasted);
    }
  };

  const handleRemoveDomain = (domainToRemove: string) => {
    const updated = domainList.filter((d) => d !== domainToRemove);
    updateSetting("mainDomain", formatMainDomains(updated));
  };

  const handleSetPrimary = (targetDomain: string) => {
    const updated = [targetDomain, ...domainList.filter((d) => d !== targetDomain)];
    updateSetting("mainDomain", formatMainDomains(updated));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Globe className="h-5 w-5" />
          {t("settings.sections.basic.title", "基础设置")}
        </CardTitle>
        <CardDescription>
          {t("settings.sections.basic.desc", "配置域名和网络相关的基础参数")}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6 md:grid-cols-2">
        {/* Multi-Domain Setting */}
        <div className="space-y-3 md:col-span-2">
          <FormField
            label={t("settings.sections.basic.mainDomain", "主域名")}
            hint={t(
              "settings.sections.basic.mainDomainHint",
              "支持配置多个主域名（外部 Caddy 等反向代理可接入多个域名，二级域名与路由将自动生效于所有主域名）。列表中首个域名为默认主选域名。",
            )}
          >
            <div className="space-y-2">
              <div className="flex gap-2">
                <Input
                  value={newDomainInput}
                  onChange={(e) => {
                    setNewDomainInput(e.target.value);
                    if (domainError) setDomainError("");
                  }}
                  onKeyDown={handleKeyDown}
                  onPaste={handlePaste}
                  placeholder={t(
                    "settings.sections.basic.mainDomainPlaceholder",
                    "输入域名并回车或点击添加，如 brtel.link",
                  )}
                  className="max-w-md"
                />
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => handleAddDomain()}
                  disabled={!newDomainInput.trim()}
                >
                  <Plus className="h-4 w-4 mr-1" />
                  {t("settings.sections.basic.addDomain", "添加")}
                </Button>
              </div>

              {domainError && (
                <p className="text-xs text-destructive">{domainError}</p>
              )}

              {/* Domains Badges List */}
              <div className="flex flex-wrap items-center gap-2 pt-1">
                {domainList.length === 0 ? (
                  <span className="text-xs text-muted-foreground italic">
                    {t("common.none", "未配置主域名")}
                  </span>
                ) : (
                  domainList.map((domain, index) => {
                    const isPrimary = index === 0;
                    return (
                      <Badge
                        key={domain}
                        variant={isPrimary ? "default" : "secondary"}
                        className="py-1.5 px-3 text-xs flex items-center gap-2 transition-all shadow-xs"
                      >
                        <span className="font-mono">{domain}</span>
                        {isPrimary ? (
                          <span className="flex items-center text-[10px] bg-primary-foreground/20 px-1.5 py-0.5 rounded font-medium">
                            <Star className="h-3 w-3 mr-0.5 fill-current" />
                            {t("settings.sections.basic.primaryTag", "主选")}
                          </span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => handleSetPrimary(domain)}
                            title={t("settings.sections.basic.setPrimary", "设为主选")}
                            className="text-[10px] opacity-70 hover:opacity-100 hover:underline cursor-pointer"
                          >
                            {t("settings.sections.basic.setPrimary", "设为主选")}
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => handleRemoveDomain(domain)}
                          title={t("settings.sections.basic.removeDomain", "移除域名")}
                          className="text-muted-foreground hover:text-destructive transition-colors ml-0.5"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </Badge>
                    );
                  })
                )}
              </div>
            </div>
          </FormField>
        </div>

        {/* Queue Timeout */}
        <FormField
          label={t(
            "settings.sections.basic.queueTimeout",
            "默认队列超时时间 (ms)",
          )}
          hint={t(
            "settings.sections.basic.queueTimeoutHint",
            "请求在队列中等待的最大时间",
          )}
        >
          <Input
            type="number"
            value={settings.defaultQueueTimeoutMs || ""}
            onChange={(e) =>
              updateSetting("defaultQueueTimeoutMs", e.target.value)
            }
            placeholder="30000"
          />
        </FormField>
      </CardContent>
    </Card>
  );
}
