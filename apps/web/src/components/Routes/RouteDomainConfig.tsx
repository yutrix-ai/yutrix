import React, { useState, useMemo } from 'react';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Globe, Plus, Trash2, AlertCircle, CheckCircle2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  parseMainDomains,
  parseRouteHosts,
  parseRouteDomainBindings,
  isValidDomain,
  isValidSubdomainPrefix,
} from "@promptgate/shared";
import { cn } from "@/lib/utils";

export interface RouteDomainConfigProps {
  hosts?: string[];
  hostInput?: string;
  mainDomain: string;
  onChange: (hosts: string[], hostInput: string) => void;
  error?: string;
  disabled?: boolean;
}

interface BindingRow {
  id: string;
  isCustom: boolean;
  mainDomain: string;
  subdomain: string;
  customHost: string;
}

type DomainMode = "wildcard" | "specific";

function emptyRow(domains: string[]): BindingRow {
  return {
    id: `row-${Date.now()}`,
    isCustom: domains.length === 0,
    mainDomain: domains[0] || "",
    subdomain: "",
    customHost: "",
  };
}

function rowsFromHosts(hostList: string[], domains: string[]): BindingRow[] {
  const parsed = parseRouteDomainBindings(hostList, domains);
  if (parsed.length === 0) return [emptyRow(domains)];
  return parsed.map((b, idx) => ({
    id: `row-${idx}-${b.fullHost}`,
    isCustom: !!b.isCustom,
    mainDomain: b.isCustom ? "" : b.mainDomain,
    subdomain: b.isCustom ? "" : b.subdomain,
    customHost: b.isCustom ? b.fullHost : "",
  }));
}

export function RouteDomainConfig({
  hosts = ["*"],
  hostInput = "*",
  mainDomain,
  onChange,
  error,
  disabled = false,
}: RouteDomainConfigProps) {
  const { t } = useTranslation();

  const configuredMainDomains = useMemo(() => {
    return parseMainDomains(mainDomain);
  }, [mainDomain]);

  const [mode, setMode] = useState<DomainMode>(() => {
    const initialHosts = hosts && hosts.length > 0 ? hosts : parseRouteHosts(hostInput);
    const wildcard = initialHosts.length === 1 && (initialHosts[0] === "*" || initialHosts[0] === "all");
    return wildcard ? "wildcard" : "specific";
  });

  // Rows stay local while typing. Parent echoes would otherwise reset the input
  // and turn an empty prefix into the apex host.
  const [rows, setRows] = useState<BindingRow[]>(() => {
    const domains = parseMainDomains(mainDomain);
    const initialHosts = hosts && hosts.length > 0 ? hosts : parseRouteHosts(hostInput);
    const wildcard = initialHosts.length === 1 && (initialHosts[0] === "*" || initialHosts[0] === "all");
    if (wildcard) return [emptyRow(domains)];
    return rowsFromHosts(initialHosts, domains);
  });

  const domainForRow = (row: BindingRow) => {
    if (row.isCustom) return "";
    if (row.mainDomain && configuredMainDomains.includes(row.mainDomain)) return row.mainDomain;
    return configuredMainDomains[0] || row.mainDomain || "";
  };

  // Calculate used main domains across rows to enforce single-use constraint
  const usedMainDomains = useMemo(() => {
    return rows
      .filter((r) => !r.isCustom)
      .map((r) => domainForRow(r))
      .filter(Boolean);
  }, [rows, configuredMainDomains]);

  const availableMainDomains = useMemo(() => {
    return configuredMainDomains.filter((d) => !usedMainDomains.includes(d));
  }, [configuredMainDomains, usedMainDomains]);

  // Incomplete rows are omitted. An empty prefix must not become the apex or "*".
  const publish = (nextRows: BindingRow[], nextMode: DomainMode) => {
    if (nextMode === "wildcard") {
      onChange(["*"], "*");
      return;
    }
    const list: string[] = [];
    for (const r of nextRows) {
      if (r.isCustom) {
        const trimmed = r.customHost.trim().toLowerCase();
        if (trimmed) list.push(trimmed);
        continue;
      }
      const domain = domainForRow(r);
      const sub = r.subdomain.trim().toLowerCase();
      if (!domain || !sub) continue;
      list.push(sub === "@" ? domain : `${sub}.${domain}`);
    }
    if (list.length === 0) onChange([], "");
    else onChange(list, list.join(", "));
  };

  const handleModeChange = (targetMode: DomainMode) => {
    setMode(targetMode);
    if (targetMode === "wildcard") {
      publish(rows, "wildcard");
      return;
    }
    let initialRows = rows;
    if (initialRows.length === 0 || initialRows.every((r) => !r.subdomain && !r.customHost)) {
      initialRows = [emptyRow(configuredMainDomains)];
      setRows(initialRows);
    }
    publish(initialRows, "specific");
  };

  const handleAddSubdomainRow = () => {
    if (availableMainDomains.length === 0) return;
    const nextMain = availableMainDomains[0];
    const newRow: BindingRow = {
      id: `row-${Date.now()}-${Math.random()}`,
      isCustom: false,
      mainDomain: nextMain,
      subdomain: "",
      customHost: "",
    };
    const nextRows = [...rows, newRow];
    setRows(nextRows);
    publish(nextRows, "specific");
  };

  const handleAddCustomRow = () => {
    const newRow: BindingRow = {
      id: `row-${Date.now()}-${Math.random()}`,
      isCustom: true,
      mainDomain: "",
      subdomain: "",
      customHost: "",
    };
    const nextRows = [...rows, newRow];
    setRows(nextRows);
    publish(nextRows, "specific");
  };

  const handleRemoveRow = (index: number) => {
    if (rows.length <= 1) {
      // If only 1 row, clear it
      const resetRow: BindingRow = {
        id: `row-${Date.now()}`,
        isCustom: configuredMainDomains.length === 0,
        mainDomain: configuredMainDomains[0] || "",
        subdomain: "",
        customHost: "",
      };
      setRows([resetRow]);
      publish([resetRow], mode);
      return;
    }
    const nextRows = rows.filter((_, idx) => idx !== index);
    setRows(nextRows);
    publish(nextRows, mode);
  };

  const handleRowDomainSelect = (index: number, val: string) => {
    const nextRows = [...rows];
    if (val === "__custom__") {
      nextRows[index] = {
        ...nextRows[index],
        isCustom: true,
        mainDomain: "",
      };
    } else {
      nextRows[index] = {
        ...nextRows[index],
        isCustom: false,
        mainDomain: val,
      };
    }
    setRows(nextRows);
    publish(nextRows, mode);
  };

  const handleRowSubdomainChange = (index: number, sub: string) => {
    const nextRows = [...rows];
    nextRows[index] = {
      ...nextRows[index],
      subdomain: sub.trim().toLowerCase(),
    };
    setRows(nextRows);
    publish(nextRows, mode);
  };

  const handleRowCustomHostChange = (index: number, customHost: string) => {
    const nextRows = [...rows];
    nextRows[index] = {
      ...nextRows[index],
      customHost: customHost.trim().toLowerCase(),
    };
    setRows(nextRows);
    publish(nextRows, mode);
  };

  // Real-time validation warning
  const validationIssue = useMemo(() => {
    if (mode === "wildcard") return null;
    // Check single main domain rule
    const mainCounts: Record<string, number> = {};
    for (const r of rows) {
      if (!r.isCustom && r.mainDomain) {
        mainCounts[r.mainDomain] = (mainCounts[r.mainDomain] || 0) + 1;
        if (mainCounts[r.mainDomain] > 1) {
          return t(
            "routes.domains.singleMainDomainRule",
            "同一个路由中只允许一个一级域名出现一次"
          ) + `（${r.mainDomain}）`;
        }
      }
    }
    // Check syntax
    for (const r of rows) {
      if (!r.isCustom) {
        const sub = r.subdomain.trim();
        if (sub && !isValidSubdomainPrefix(sub)) {
          return `二级域名「${sub}」格式无效，仅支持英文字母、数字、连字符和多级前缀`;
        }
      } else {
        const host = r.customHost.trim();
        if (host && !isValidDomain(host)) {
          return `自定义域名「${host}」格式无效`;
        }
      }
    }
    return null;
  }, [mode, rows, t]);

  return (
    <div className="space-y-3 rounded-lg border bg-card p-4 text-card-foreground shadow-sm">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Globe className="h-4 w-4 text-primary" />
          <Label className="font-semibold text-sm">
            {t("routes.domains.title", "域名与二级域名配置 *")}
          </Label>
        </div>

        {/* Mode Selector Toggle */}
        <div className="flex items-center rounded-md bg-muted p-1 text-xs">
          <button
            type="button"
            disabled={disabled}
            onClick={() => handleModeChange("wildcard")}
            className={cn(
              "px-3 py-1 font-medium rounded transition-all",
              mode === "wildcard"
                ? "bg-background text-foreground shadow-sm font-semibold"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {t("routes.domains.modeWildcard", "全部域名 (*)")}
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => handleModeChange("specific")}
            className={cn(
              "px-3 py-1 font-medium rounded transition-all",
              mode === "specific"
                ? "bg-background text-foreground shadow-sm font-semibold"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {t("routes.domains.modeSpecific", "指定二级域名")}
          </button>
        </div>
      </div>

      {mode === "wildcard" ? (
        <div className="rounded-md border border-dashed border-border/80 bg-muted/30 px-4 py-3 text-xs text-muted-foreground flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />
          <span>
            {t(
              "routes.domains.modeWildcardDesc",
              "匹配任意外部请求域名 (Host: *)，当请求路径匹配时即可触发此路由规则。"
            )}
          </span>
        </div>
      ) : (
        <div className="space-y-3 pt-1">
          {rows.map((row, index) => {
            const rowDomain = domainForRow(row);
            const previewFullHost = row.isCustom
              ? row.customHost || t("routes.domains.customPlaceholder", "例如：api.example.com")
              : row.subdomain === "@"
              ? `${rowDomain} (${t("routes.domains.rootDomain", "根域名")})`
              : row.subdomain
              ? `${row.subdomain}.${rowDomain}`
              : t("routes.domains.subdomainPlaceholder", "例如：code、api 或 @ (根域名)");

            return (
              <div
                key={row.id}
                className="flex flex-col sm:flex-row items-start sm:items-center gap-2 rounded-md border bg-background/50 p-2.5"
              >
                {/* Primary Domain Select */}
                <div className="w-full sm:w-48 shrink-0">
                  <Select
                    disabled={disabled}
                    value={row.isCustom ? "__custom__" : rowDomain || undefined}
                    onValueChange={(val) => handleRowDomainSelect(index, val)}
                  >
                    <SelectTrigger className="h-9 text-xs">
                      <SelectValue
                        placeholder={t("routes.domains.primaryDomain", "选择一级域名")}
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {configuredMainDomains.map((dom) => {
                        const isUsedInOtherRow =
                          !row.isCustom && row.mainDomain !== dom && usedMainDomains.includes(dom);
                        return (
                          <SelectItem
                            key={dom}
                            value={dom}
                            disabled={isUsedInOtherRow}
                            className="text-xs font-mono"
                          >
                            {dom}{" "}
                            {isUsedInOtherRow
                              ? `(${t("routes.domains.alreadyAdded", "已添加")})`
                              : ""}
                          </SelectItem>
                        );
                      })}
                      <SelectItem value="__custom__" className="text-xs">
                        {t("routes.domains.customOption", "自定义完整域名")}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {/* Subdomain Input or Custom Host Input */}
                <div className="flex-1 w-full flex items-center gap-2">
                  {!row.isCustom ? (
                    <div className="flex-1 flex items-center gap-2">
                      <div className="relative flex-1">
                        <Input
                          disabled={disabled}
                          value={row.subdomain}
                          onChange={(e) => handleRowSubdomainChange(index, e.target.value)}
                          placeholder={t(
                            "routes.domains.subdomainPlaceholder",
                            "例如：code、api 或 @ (根域名)"
                          )}
                          className="h-9 text-xs font-mono"
                        />
                      </div>
                      <div className="shrink-0 flex items-center">
                        <Badge
                          variant="secondary"
                          className="font-mono text-xs font-normal bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300 border border-blue-200/60 dark:border-blue-800/40 max-w-[200px] truncate"
                          title={previewFullHost}
                        >
                          {previewFullHost}
                        </Badge>
                      </div>
                    </div>
                  ) : (
                    <div className="flex-1">
                      <Input
                        disabled={disabled}
                        value={row.customHost}
                        onChange={(e) => handleRowCustomHostChange(index, e.target.value)}
                        placeholder={t(
                          "routes.domains.customPlaceholder",
                          "例如：api.yourdomain.com"
                        )}
                        className="h-9 text-xs font-mono"
                      />
                    </div>
                  )}

                  {/* Remove Row Button */}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    disabled={disabled}
                    onClick={() => handleRemoveRow(index)}
                    className="h-8 w-8 text-muted-foreground hover:text-destructive shrink-0"
                    title={t("routes.domains.deleteBinding", "移除此域名")}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            );
          })}

          {/* Action Row */}
          <div className="flex items-center gap-3 pt-1 flex-wrap">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled || availableMainDomains.length === 0}
              onClick={handleAddSubdomainRow}
              className="h-8 text-xs gap-1.5"
            >
              <Plus className="h-3.5 w-3.5" />
              {t("routes.domains.addBinding", "添加二级域名")}
            </Button>

            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disabled}
              onClick={handleAddCustomRow}
              className="h-8 text-xs gap-1 text-muted-foreground hover:text-foreground"
            >
              <Plus className="h-3.5 w-3.5" />
              {t("routes.domains.addCustom", "添加自定义域名")}
            </Button>

            {availableMainDomains.length === 0 && configuredMainDomains.length > 0 && (
              <span className="text-[11px] text-muted-foreground">
                {t(
                  "routes.domains.allUsedHint",
                  "已配置所有一级域名（同一个路由只允许一个一级域名出现一次）"
                )}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Validation issue message */}
      {(validationIssue || error) && (
        <div className="flex items-center gap-1.5 text-xs text-destructive pt-1">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          <span>{validationIssue || error}</span>
        </div>
      )}
    </div>
  );
}
