import React, { useState } from 'react';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { AlertCircle, SlidersHorizontal } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useRouteForm } from "./RouteFormContext";
import { RouteTargetsTable } from "./RouteTargetsTable";
import { StrategyRoutingEditor, StrategyRoutingSummary } from "./StrategyRoutingEditor";
import { matchingKeySubmitBlocked, ROUTE_IDENTITY_ERROR } from "@promptgate/shared";
import { cn } from "@/lib/utils";

export function RouteDialog() {
  const { t } = useTranslation();
  const [showStrategyPanel, setShowStrategyPanel] = useState(false);
  const {
    dialogOpen, setDialogOpen, editingId, copying, identityIssues = [], handleSave, formData, setFormData,
    providers, handlePathChange, handleProtocolChange,
    policies,
    groups, usersForSelect, closeDialog, getProviderProtocolForSelection,
    allModels, getDefaultStrategyRules, handleRoutingModeChange
  } = useRouteForm();

  const nameIssue = identityIssues.find((issue: { code: string }) =>
    issue.code === ROUTE_IDENTITY_ERROR.NAME_REQUIRED || issue.code === ROUTE_IDENTITY_ERROR.NAME_CONFLICT
  );
  const matchingKeyIssue = identityIssues.find((issue: { code: string }) =>
    issue.code === ROUTE_IDENTITY_ERROR.MATCHING_KEY_CONFLICT
  );
  const matchingBlocked = matchingKeySubmitBlocked(identityIssues);
  const dialogTitle = copying
    ? t("routes.dialog.copyTitle", "复制路由规则")
    : editingId
      ? t("routes.dialog.editTitle", "编辑路由规则")
      : t("routes.dialog.addTitle", "新建路由规则");
  const dialogDescription = copying
    ? t("routes.dialog.copyDescription", "已带入原路由的转发配置。请确认规则名称，并修改 Host、路径或协议后再保存。")
    : t("routes.dialog.description", "配置网关的请求转发规则");

  return (
      <Dialog open={dialogOpen} onOpenChange={(open) => { if (!open) closeDialog(); else setDialogOpen(true); }}>
        <DialogContent className="max-w-[95vw] lg:max-w-[90vw] xl:max-w-7xl h-[90vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>{dialogTitle}</DialogTitle>
            <DialogDescription>{dialogDescription}</DialogDescription>
          </DialogHeader>

          <form onSubmit={handleSave} className="flex-1 flex flex-col min-h-0">
            <DialogBody className="space-y-6 py-4 overflow-y-auto max-h-[calc(90vh-130px)]">
              {/* 基础信息配置 */}
              {copying && matchingBlocked && (
                <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                  <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                  <span>
                    {matchingKeyIssue?.conflictName
                      ? t("routes.errors.matchingKeyConflict", "该 Host、Path 与 Protocol 组合已有路由") + `（${matchingKeyIssue.conflictName}）`
                      : t("routes.errors.matchingKeyConflict", "该 Host、Path 与 Protocol 组合已有路由")}
                  </span>
                </div>
              )}
              <div className="grid grid-cols-2 gap-x-6 gap-y-4">
                <div className="space-y-2">
                  <Label>{t("routes.fields.name", "规则名称")}</Label>
                  <Input
                    value={formData.name}
                    onChange={e => setFormData({ ...formData, name: e.target.value })}
                    placeholder={t("routes.placeholders.name", "例如：默认 OpenAI 路由")}
                    required
                    aria-invalid={!!nameIssue}
                    className={cn(nameIssue && "border-destructive focus-visible:ring-destructive")}
                  />
                  {nameIssue && (
                    <p className="text-xs text-destructive">
                      {nameIssue.code === ROUTE_IDENTITY_ERROR.NAME_REQUIRED
                        ? t("routes.errors.nameRequired", "规则名称不能为空")
                        : t("routes.errors.nameConflict", "规则名称已存在")}
                    </p>
                  )}
                </div>
                <div className="space-y-2">
                  <Label>{t("routes.fields.host", "Host / 二级域名 *")}</Label>
                  <Input
                    value={formData.hostInput}
                    onChange={e => setFormData({ ...formData, hostInput: e.target.value })}
                    placeholder={t("routes.placeholders.host", "例如：api.yourdomain.com 或 sub")}
                    required
                    autoFocus={!!copying}
                    aria-invalid={!!matchingKeyIssue}
                    className={cn(matchingKeyIssue && "border-destructive focus-visible:ring-destructive")}
                  />
                </div>
                <div className="space-y-2">
                  <Label>{t("routes.fields.path", "请求路径 *")}</Label>
                  <Input
                    value={formData.path}
                    onChange={e => handlePathChange(e.target.value)}
                    placeholder={t("routes.placeholders.path", "例如：/v1/chat/completions")}
                    required
                    aria-invalid={!!matchingKeyIssue}
                    className={cn(matchingKeyIssue && "border-destructive focus-visible:ring-destructive")}
                  />
                </div>
                <div className="space-y-2">
                  <Label>{t("routes.fields.protocol", "路由协议 *")}</Label>
                  <Select value={formData.incomingProtocol} onValueChange={handleProtocolChange}>
                    <SelectTrigger className={cn(matchingKeyIssue && "border-destructive focus:ring-destructive")} aria-invalid={!!matchingKeyIssue}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="openai">{t("routes.hints.openaiProtocol", "OpenAI 格式")}</SelectItem>
                      <SelectItem value="anthropic">{t("routes.hints.anthropicProtocol", "Anthropic 格式")}</SelectItem>
                    </SelectContent>
                  </Select>
                  {matchingKeyIssue && !copying && (
                    <p className="text-xs text-destructive col-span-2">
                      {t("routes.errors.matchingKeyConflict", "该 Host、Path 与 Protocol 组合已有路由")}
                    </p>
                  )}
                </div>
                
                <div className="flex items-center gap-8 pt-5 col-span-2">
                  <div className="flex items-center gap-2">
                    <Switch id="allow-client-model" checked={formData.allowClientModel} onCheckedChange={c => setFormData({...formData, allowClientModel: c})} />
                    <Label htmlFor="allow-client-model" className="cursor-pointer font-medium text-sm">{t("routes.fields.allowClientModel", "允许客户端指定模型")}</Label>
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch id="global-best-effort" checked={formData.fallbackMatchTarget} onCheckedChange={c => setFormData({...formData, fallbackMatchTarget: c})} />
                    <Label htmlFor="global-best-effort" className="cursor-pointer font-medium text-sm">{t("routes.fields.bestEffort", "尽力而为 (逐级降级时优先使用同名模型)")}</Label>
                  </div>
                </div>
              </div>

              {/* 转发目标与路由模式 */}
              <div className="border-t pt-4">
                <RouteTargetsTable
                  targets={formData.targets || []}
                  onChange={targets => setFormData({...formData, targets})}
                  providers={providers}
                  allModels={allModels}
                  policies={policies || []}
                  incomingProtocol={formData.incomingProtocol}
                  routingMode={formData.routingMode || "strategy"}
                  onRoutingModeChange={handleRoutingModeChange}
                  getProviderProtocolForSelection={getProviderProtocolForSelection}
                />
              </div>

              {/* 运行时配置 */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="space-y-2">
                <Label>{t("routes.fields.timeout", "无响应时限 (ms)")}</Label>
                <Input type="number" min="0" value={formData.timeoutMs} onChange={e => setFormData({ ...formData, timeoutMs: parseInt(e.target.value) || 0 })} />
                <p className="text-xs text-muted-foreground leading-snug">
                  {t("routes.hints.timeout", "默认 30000（30 秒）。填 0 则沿用供应商无响应时限。")}
                </p>
              </div>
              <div className="space-y-2">
                <Label>{t("routes.fields.queueTimeout", "排队超时 (ms)")}</Label>
                <Input type="number" value={formData.queueTimeoutMs} onChange={e => setFormData({ ...formData, queueTimeoutMs: parseInt(e.target.value) || 0 })} />
              </div>
              <div className="space-y-2">
                <Label>{t("routes.fields.retryCount", "重试次数")}</Label>
                <Input type="number" value={formData.retryCount} onChange={e => setFormData({ ...formData, retryCount: parseInt(e.target.value) || 0 })} />
              </div>
              <div className="space-y-2">
                <Label>{t("routes.fields.maxBody", "最大请求体 (MB)")}</Label>
                <Input type="number" value={formData.maxBodyMb} onChange={e => setFormData({ ...formData, maxBodyMb: parseInt(e.target.value) || 0 })} />
              </div>
            </div>

            <div className="flex items-start gap-3">
              <Switch
                id="timeout-eject"
                checked={!!formData.timeoutEjectEnabled}
                onCheckedChange={(checked) => setFormData({ ...formData, timeoutEjectEnabled: checked })}
              />
              <div className="space-y-1">
                <Label htmlFor="timeout-eject" className="cursor-pointer font-medium text-sm">
                  {t("routes.fields.timeoutEject", "超时摘流")}
                </Label>
                <p className="text-xs text-muted-foreground leading-snug">
                  {t("routes.hints.timeoutEject", "超时后摘除当前首层，后续请求立即降级；探活成功后恢复。默认关闭。")}
                </p>
              </div>
            </div>

            {/* 来源限制 */}
            <div className="space-y-2">
              <Label htmlFor="ip-whitelist">{t("routes.fields.ipWhitelist", "来源限制")}</Label>
              <Input
                id="ip-whitelist"
                className="font-mono text-sm"
                value={formData.ipWhitelist || ""}
                onChange={(e) => setFormData({ ...formData, ipWhitelist: e.target.value })}
                placeholder={t("routes.placeholders.ipWhitelist", "0.0.0.0/0")}
              />
              <p className="text-xs text-muted-foreground">
                {t("routes.hints.ipWhitelist", "空或 0.0.0.0/0 表示不限制。多个 IP / CIDR 用逗号分隔。")}
              </p>
            </div>

            {/* 授权访问 */}
            <div className="p-3 border rounded-md bg-muted/20">
              <div className="flex items-center justify-between mb-2">
                <Label className="font-medium text-sm">{t("routes.fields.authorization", "授权访问")}</Label>
                <span className="text-xs text-muted-foreground">{t("routes.hints.authorization", "选择可以访问此路由的用户和用户组。未选择则默认授权给默认组。")}</span>
              </div>
              <div className="flex flex-wrap gap-1.5 min-h-[32px] p-2 border rounded-md bg-background">
                {formData.authorizedGroupIds.length === 0 && formData.authorizedUserIds.length === 0 && (
                  <span className="text-xs text-muted-foreground">{t("routes.hints.defaultAuth", "默认授权给默认组")}</span>
                )}
                {formData.authorizedGroupIds.map((gid: string) => {
                  const g = groups.find((gr: any) => gr.id === gid);
                  return g ? (
                    <Badge key={gid} variant="secondary" className="text-xs cursor-pointer hover:bg-destructive/20" onClick={() => setFormData({...formData, authorizedGroupIds: formData.authorizedGroupIds.filter((id: string) => id !== gid)})}>
                      {g.name} ×
                    </Badge>
                  ) : null;
                })}
                {formData.authorizedUserIds.map((uid: string) => {
                  const u = usersForSelect.find((us: any) => us.id === uid);
                  return u ? (
                    <Badge key={uid} variant="outline" className="text-xs cursor-pointer hover:bg-destructive/20" onClick={() => setFormData({...formData, authorizedUserIds: formData.authorizedUserIds.filter((id: string) => id !== uid)})}>
                      {u.username} ×
                    </Badge>
                  ) : null;
                })}
              </div>
              <div className="grid grid-cols-2 gap-2 mt-2">
                <Select value="" onValueChange={(val) => {
                  if (val && !formData.authorizedGroupIds.includes(val)) {
                    setFormData({...formData, authorizedGroupIds: [...formData.authorizedGroupIds, val]});
                  }
                }}>
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue placeholder={t("routes.placeholders.addGroup", "添加用户组")} />
                  </SelectTrigger>
                  <SelectContent>
                    {groups.filter((g: any) => !formData.authorizedGroupIds.includes(g.id)).map((g: any) => (
                      <SelectItem key={g.id} value={g.id}>{g.name}{g.isDefault ? ` (${t("groups.defaultBadge", "默认组")})` : ""}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value="" onValueChange={(val) => {
                  if (val && !formData.authorizedUserIds.includes(val)) {
                    setFormData({...formData, authorizedUserIds: [...formData.authorizedUserIds, val]});
                  }
                }}>
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue placeholder={t("routes.placeholders.addUser", "添加用户")} />
                  </SelectTrigger>
                  <SelectContent>
                    {usersForSelect.filter((u: any) => !formData.authorizedUserIds.includes(u.id)).map((u: any) => (
                      <SelectItem key={u.id} value={u.id}>{u.username}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>


            </DialogBody>

            <DialogFooter className="pt-4 border-t">
              <Button type="button" variant="ghost" onClick={closeDialog}>{t("common.cancel", "取消")}</Button>
              <Button type="submit" disabled={matchingBlocked}>{t("routes.actions.save", "保存")}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
  );
}
