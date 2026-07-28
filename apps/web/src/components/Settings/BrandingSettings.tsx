import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FormField } from "@/components/FormField";
import { Image as ImageIcon, Upload, Sparkles, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface BrandingSettingsProps {
  settings: Record<string, string>;
  updateSetting: (key: string, value: string) => void;
  updateBoolean: (key: string, value: boolean) => void;
}

export function BrandingSettings({ settings, updateSetting, updateBoolean }: BrandingSettingsProps) {
  const { t } = useTranslation();
  const [isBgModalOpen, setIsBgModalOpen] = useState(false);
  const [bgRemoveColorType, setBgRemoveColorType] = useState<"white" | "black" | "custom">("white");
  const [customBgColor, setCustomBgColor] = useState("#ffffff");
  const [bgRemoveTolerance, setBgRemoveTolerance] = useState(30);

  const handleLogoChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.type !== "image/png") {
      toast.error(t("settings.sections.branding.pngOnly", "图标只允许是PNG格式"));
      return;
    }
    const reader = new FileReader();
    reader.onload = (event) => {
      if (event.target?.result) {
        updateSetting("systemLogoUrl", event.target.result as string);
      }
    };
    reader.readAsDataURL(file);
  };

  const removeLogoBackground = () => {
    if (!settings.systemLogoUrl) return;

    const img = new Image();
    img.src = settings.systemLogoUrl;
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      ctx.drawImage(img, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = imageData.data;

      let targetR = 255;
      let targetG = 255;
      let targetB = 255;

      if (bgRemoveColorType === "black") {
        targetR = 0;
        targetG = 0;
        targetB = 0;
      } else if (bgRemoveColorType === "custom") {
        const hex = customBgColor.replace("#", "");
        if (hex.length === 3) {
          targetR = parseInt(hex[0] + hex[0], 16);
          targetG = parseInt(hex[1] + hex[1], 16);
          targetB = parseInt(hex[2] + hex[2], 16);
        } else if (hex.length === 6) {
          targetR = parseInt(hex.substring(0, 2), 16);
          targetG = parseInt(hex.substring(2, 4), 16);
          targetB = parseInt(hex.substring(4, 6), 16);
        }
      }

      const tolerance = bgRemoveTolerance;

      for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const a = data[i + 3];

        if (a === 0) continue;

        const distance = Math.sqrt(
          Math.pow(r - targetR, 2) +
          Math.pow(g - targetG, 2) +
          Math.pow(b - targetB, 2)
        );

        if (distance <= tolerance) {
          data[i + 3] = 0; // Set transparent
        }
      }

      ctx.putImageData(imageData, 0, 0);
      const transparentBase64 = canvas.toDataURL("image/png");
      updateSetting("systemLogoUrl", transparentBase64);
      toast.success(t("settings.sections.branding.bgRemoved", "背景已成功去除"));
      setIsBgModalOpen(false);
    };
    img.onerror = () => {
      toast.error(t("settings.sections.branding.bgRemoveFailed", "背景去除失败"));
    };
  };

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ImageIcon className="h-5 w-5" />
            {t("settings.sections.branding.title", "品牌与系统标识")}
          </CardTitle>
          <CardDescription>{t("settings.sections.branding.desc", "自定义系统的名称、口号和Logo图标")}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <div className="col-span-1 md:col-span-2 space-y-2">
            <Label className="text-sm font-medium">{t("settings.sections.branding.systemLogo", "系统Logo")}</Label>
            <div className="flex flex-col sm:flex-row items-start sm:items-center gap-6 p-4 rounded-xl border border-dashed border-border/80 bg-muted/20 dark:bg-card/40 hover:bg-muted/30 transition-all duration-200">
              <div className="relative group shrink-0">
                <div className="w-20 h-20 rounded-2xl bg-card border shadow-sm flex items-center justify-center p-2 relative overflow-hidden transition-transform duration-300 group-hover:scale-105">
                  {settings.systemLogoUrl ? (
                    <img src={settings.systemLogoUrl} alt="Logo Preview" className="w-full h-full object-contain" />
                  ) : (
                    <ImageIcon className="w-8 h-8 text-muted-foreground/50" />
                  )}
                </div>
              </div>
              <div className="space-y-2.5 flex-1 min-w-0">
                <div className="flex flex-wrap gap-2.5">
                  <label className="inline-flex items-center justify-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm cursor-pointer transition-all duration-200 hover:scale-[1.02] active:scale-[0.98]">
                    <Upload className="w-3.5 h-3.5" />
                    <span>{t("settings.sections.branding.uploadBtn", "上传新图标")}</span>
                    <input
                      type="file"
                      accept="image/png"
                      onChange={handleLogoChange}
                      className="hidden"
                    />
                  </label>
                  {settings.systemLogoUrl && settings.systemLogoUrl !== "/favicon.svg" && (
                    <>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setIsBgModalOpen(true)}
                        className="h-8 text-xs text-muted-foreground hover:text-primary hover:bg-primary/5 dark:hover:bg-primary/10"
                      >
                        <Sparkles className="w-3.5 h-3.5 mr-1" />
                        {t("settings.sections.branding.removeBgBtn", "去背景")}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => updateSetting("systemLogoUrl", "/favicon.svg")}
                        className="h-8 text-xs text-muted-foreground hover:text-destructive hover:bg-destructive/5 dark:hover:bg-destructive/10"
                      >
                        <X className="w-3.5 h-3.5 mr-1" />
                        {t("settings.sections.branding.resetBtn", "恢复默认")}
                      </Button>
                    </>
                  )}
                </div>
                <p className="text-xs text-muted-foreground/80 leading-relaxed">
                  {t("settings.sections.branding.pngOnly", "仅支持 PNG 格式，图片将转换为 Base64 并在数据库保存")}
                </p>
              </div>
            </div>
          </div>

          <FormField label={t("settings.sections.branding.systemName", "系统名称")}>
            <Input
              value={settings.systemName || ""}
              onChange={(e) => updateSetting("systemName", e.target.value)}
              placeholder="PromptGate"
            />
          </FormField>

          <FormField label={t("settings.sections.branding.systemSlogan", "系统口号 (Slogan)")}>
            <div className="space-y-2">
              <Input
                value={settings.systemSlogan || ""}
                onChange={(e) => updateSetting("systemSlogan", e.target.value)}
                placeholder="Lightweight LLM Gateway Console"
              />
              <div className="flex flex-col gap-2 pt-1">
                <div className="flex items-center gap-2">
                  <Switch
                    id="append-slogan-switch"
                    checked={settings.appendSloganToTitle === "true"}
                    onCheckedChange={(checked) => updateBoolean("appendSloganToTitle", checked)}
                  />
                  <Label htmlFor="append-slogan-switch" className="text-xs text-muted-foreground font-normal cursor-pointer select-none">
                    {t("settings.sections.branding.appendSlogan", "在浏览器标签页追加口号")}
                  </Label>
                </div>
                {settings.appendSloganToTitle === "true" && (
                  <div className="pl-11 flex items-center gap-2 mt-1.5 animate-in fade-in slide-in-from-top-1.5 duration-200">
                    <Switch
                      id="hide-system-name-switch"
                      checked={settings.hideSystemNameInTitle === "true"}
                      onCheckedChange={(checked) => updateBoolean("hideSystemNameInTitle", checked)}
                    />
                    <Label htmlFor="hide-system-name-switch" className="text-xs text-muted-foreground font-normal cursor-pointer select-none">
                      {t("settings.sections.branding.hideSystemName", "仅显示系统口号 (隐藏系统名称)")}
                    </Label>
                  </div>
                )}
              </div>
            </div>
          </FormField>

          <FormField label={t("settings.sections.branding.logoAnimation", "边栏 Logo & 标题动画")}>
            <Select
              value={settings.sidebarLogoAnimation || "none"}
              onValueChange={(value) => updateSetting("sidebarLogoAnimation", value)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">{t("settings.sections.branding.animNone", "无动画")}</SelectItem>
                <SelectItem value="spin-hover">{t("settings.sections.branding.animSpin", "经典旋转 (悬停)")}</SelectItem>
                <SelectItem value="tesla-show">{t("settings.sections.branding.animTesla", "⚡ 特斯拉灯光秀 (炫目)")}</SelectItem>
                <SelectItem value="cyber-glitch">{t("settings.sections.branding.animGlitch", "👾 赛博朋克故障 (悬停)")}</SelectItem>
                <SelectItem value="neon-breath">{t("settings.sections.branding.animBreath", "🌟 霓虹呼吸 (常驻)")}</SelectItem>
                <SelectItem value="cosmic-aurora">{t("settings.sections.branding.animAurora", "🌌 极光晕染 (常驻)")}</SelectItem>
              </SelectContent>
            </Select>
          </FormField>

          <FormField label={t("settings.sections.branding.githubIcon", "顶部 GitHub 图标")}>
            <div className="flex items-center gap-2">
              <Switch
                id="show-github-icon-switch"
                checked={settings.showGithubIcon !== "false"}
                onCheckedChange={(checked) => updateBoolean("showGithubIcon", checked)}
              />
              <Label htmlFor="show-github-icon-switch" className="text-xs text-muted-foreground font-normal cursor-pointer select-none">
                {t("settings.sections.branding.showGithubIcon", "在顶栏显示 GitHub 仓库入口")}
              </Label>
            </div>
          </FormField>
        </CardContent>
      </Card>

      <Dialog open={isBgModalOpen} onOpenChange={setIsBgModalOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("settings.sections.branding.removeBgModalTitle", "去除Logo背景")}</DialogTitle>
            <DialogDescription>
              {t("settings.sections.branding.removeBgModalDesc", "选择要去除的背景颜色，并微调容差以获得最佳透明效果")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-3">
            <div className="space-y-2">
              <Label className="text-xs font-semibold">{t("settings.sections.branding.selectBgColor", "选择背景颜色")}</Label>
              <div className="grid grid-cols-3 gap-2">
                <button
                  type="button"
                  onClick={() => setBgRemoveColorType("white")}
                  className={cn(
                    "flex flex-col items-center justify-center p-3 rounded-lg border text-xs gap-1.5 transition-all cursor-pointer",
                    bgRemoveColorType === "white"
                      ? "border-primary bg-primary/5 text-primary font-medium"
                      : "border-border hover:bg-muted/50"
                  )}
                >
                  <div className="w-5 h-5 rounded border bg-white shadow-sm" />
                  <span>{t("settings.sections.branding.colorWhite", "白色")}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setBgRemoveColorType("black")}
                  className={cn(
                    "flex flex-col items-center justify-center p-3 rounded-lg border text-xs gap-1.5 transition-all cursor-pointer",
                    bgRemoveColorType === "black"
                      ? "border-primary bg-primary/5 text-primary font-medium"
                      : "border-border hover:bg-muted/50"
                  )}
                >
                  <div className="w-5 h-5 rounded border bg-black shadow-sm" />
                  <span>{t("settings.sections.branding.colorBlack", "黑色")}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setBgRemoveColorType("custom")}
                  className={cn(
                    "flex flex-col items-center justify-center p-3 rounded-lg border text-xs gap-1.5 transition-all cursor-pointer",
                    bgRemoveColorType === "custom"
                      ? "border-primary bg-primary/5 text-primary font-medium"
                      : "border-border hover:bg-muted/50"
                  )}
                >
                  <div className="w-5 h-5 rounded-full border bg-gradient-to-r from-red-400 via-green-400 to-blue-400 shadow-sm" />
                  <span>{t("settings.sections.branding.colorCustom", "自定义")}</span>
                </button>
              </div>
            </div>

            {bgRemoveColorType === "custom" && (
              <div className="space-y-2 animate-in fade-in slide-in-from-top-1 duration-150">
                <Label className="text-xs font-semibold">{t("settings.sections.branding.customColorHex", "自定义颜色 Hex 代码")}</Label>
                <div className="flex gap-2">
                  <Input
                    type="color"
                    value={customBgColor}
                    onChange={(e) => setCustomBgColor(e.target.value)}
                    className="w-10 h-10 p-0.5 border cursor-pointer rounded-lg shrink-0"
                  />
                  <Input
                    type="text"
                    value={customBgColor}
                    onChange={(e) => setCustomBgColor(e.target.value)}
                    placeholder="#ffffff"
                    className="flex-1"
                  />
                </div>
              </div>
            )}

            <div className="space-y-2">
              <div className="flex justify-between items-center">
                <Label className="text-xs font-semibold">{t("settings.sections.branding.colorTolerance", "颜色容差")}</Label>
                <span className="text-xs font-mono text-muted-foreground">{bgRemoveTolerance}</span>
              </div>
              <input
                type="range"
                min="5"
                max="120"
                value={bgRemoveTolerance}
                onChange={(e) => setBgRemoveTolerance(Number(e.target.value))}
                className="w-full accent-primary h-1.5 bg-muted rounded-lg appearance-none cursor-pointer"
              />
              <p className="text-[10px] text-muted-foreground/80 leading-normal">
                {t("settings.sections.branding.toleranceHint", "提示：建议设定 15-40。值越大，去除邻近相似颜色的范围越宽，可轻松平滑抠除白边。")}
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setIsBgModalOpen(false)}>
              {t("settings.sections.branding.cancelBtn", "取消")}
            </Button>
            <Button type="button" onClick={removeLogoBackground}>
              {t("settings.sections.branding.confirmRemoveBg", "确认去除")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
