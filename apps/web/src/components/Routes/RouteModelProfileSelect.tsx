import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Pencil, Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useRouteForm } from "./RouteFormContext";
import type { RouteModelProfileItem } from "./types";

const DEFAULT_VALUE = "__default__";
const ADD_VALUE = "__add__";

type EditorState = { mode: "add" | "rename"; value: string; error: string };

/** Picks which funnel table the dialog edits: the default table or one keyed by client model id. */
export function RouteModelProfileSelect() {
  const { t } = useTranslation();
  const { formData, setActiveProfileIndex, addModelProfile, renameModelProfile, removeModelProfile } = useRouteForm();
  const profiles: RouteModelProfileItem[] = formData.modelProfiles || [];
  const activeIndex: number = formData.activeProfileIndex ?? -1;
  const [editor, setEditor] = useState<EditorState | null>(null);

  const selectValue = activeIndex >= 0 && profiles[activeIndex] ? `p:${activeIndex}` : DEFAULT_VALUE;

  const handleSelect = (value: string) => {
    if (value === ADD_VALUE) {
      setEditor({ mode: "add", value: "", error: "" });
      return;
    }
    if (value === DEFAULT_VALUE) {
      setActiveProfileIndex(-1);
      return;
    }
    setActiveProfileIndex(Number(value.slice(2)));
  };

  const submitEditor = () => {
    if (!editor) return;
    const error = editor.mode === "add"
      ? addModelProfile(editor.value)
      : renameModelProfile(activeIndex, editor.value);
    if (error) {
      setEditor({ ...editor, error });
      return;
    }
    setEditor(null);
  };

  if (editor) {
    return (
      <div className="space-y-1">
        <div className="flex items-center gap-1.5">
          <Input
            autoFocus
            className="h-8 w-[220px] font-mono text-xs"
            value={editor.value}
            placeholder={t("routes.modelProfiles.namePlaceholder", "客户端请求的模型 ID")}
            onChange={(e) => setEditor({ ...editor, value: e.target.value, error: "" })}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submitEditor();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setEditor(null);
              }
            }}
          />
          <Button type="button" size="icon" variant="ghost" className="h-8 w-8" onClick={submitEditor}>
            <Check className="h-4 w-4" />
          </Button>
          <Button type="button" size="icon" variant="ghost" className="h-8 w-8" onClick={() => setEditor(null)}>
            <X className="h-4 w-4" />
          </Button>
        </div>
        <p className={editor.error ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
          {editor.error ||
            (editor.mode === "add"
              ? t("routes.modelProfiles.addHint", "新路由表复制自当前路由表")
              : t("routes.modelProfiles.renameHint", "修改后客户端需使用新的模型 ID"))}
        </p>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      <Label className="text-sm font-medium whitespace-nowrap">{t("routes.modelProfiles.label", "路由表")}</Label>
      <Select value={selectValue} onValueChange={handleSelect}>
        <SelectTrigger
          className="h-8 w-[220px] text-xs"
          title={t(
            "routes.modelProfiles.hint",
            "客户端请求的模型 ID 与路由表名一致时使用该路由表，否则使用默认路由表",
          )}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={DEFAULT_VALUE}>{t("routes.modelProfiles.default", "默认路由表")}</SelectItem>
          {profiles.map((profile, index) => (
            <SelectItem key={`${index}-${profile.name}`} value={`p:${index}`}>
              <span className="font-mono">{profile.name}</span>
            </SelectItem>
          ))}
          <SelectSeparator />
          <SelectItem value={ADD_VALUE}>
            <span className="flex items-center gap-1.5">
              <Plus className="h-3.5 w-3.5" />
              {t("routes.modelProfiles.add", "新建路由表")}
            </span>
          </SelectItem>
        </SelectContent>
      </Select>
      {activeIndex >= 0 && profiles[activeIndex] && (
        <>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-8 w-8"
            title={t("routes.modelProfiles.rename", "重命名")}
            onClick={() => setEditor({ mode: "rename", value: profiles[activeIndex].name, error: "" })}
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-8 w-8 text-destructive hover:text-destructive"
            title={t("routes.modelProfiles.remove", "删除路由表")}
            onClick={() => removeModelProfile(activeIndex)}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </>
      )}
    </div>
  );
}
