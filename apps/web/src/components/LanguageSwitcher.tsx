import { useTranslation } from "react-i18next";
import { Globe } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useEffect, useState } from "react";

export function LanguageSwitcher() {
  const { t, i18n } = useTranslation();
  // Get current state from localStorage or fallback to 'system'
  const getInitialValue = () => {
    const saved = localStorage.getItem("promptgate.language");
    if (saved === "zh" || saved === "en") return saved;
    return "system";
  };
  
  const [value, setValue] = useState(getInitialValue());

  useEffect(() => {
    const handleStorageChange = () => {
      setValue(getInitialValue());
    };
    window.addEventListener("storage", handleStorageChange);
    return () => window.removeEventListener("storage", handleStorageChange);
  }, []);

  const handleChange = (newVal: string) => {
    setValue(newVal);
    if (newVal === "system") {
      localStorage.removeItem("promptgate.language");
      // i18next-browser-languagedetector will handle fallback based on navigator
      // But we can force it to redetect or explicitly set it based on navigator
      const navLang = navigator.language.toLowerCase();
      const targetLang = navLang.startsWith("zh") ? "zh" : "en";
      i18n.changeLanguage(targetLang);
    } else {
      localStorage.setItem("promptgate.language", newVal);
      i18n.changeLanguage(newVal);
    }
  };

  return (
    <Select value={value} onValueChange={handleChange}>
      <SelectTrigger className="w-[140px] h-9 border-none bg-transparent shadow-none hover:bg-accent hover:text-accent-foreground focus:ring-0 focus:ring-offset-0">
        <div className="flex items-center gap-2">
          <Globe className="h-4 w-4" />
          <SelectValue placeholder={t("settings.language.label")} />
        </div>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="system">{t("settings.language.system")}</SelectItem>
        <SelectItem value="zh">{t("settings.language.zh")}</SelectItem>
        <SelectItem value="en">{t("settings.language.en")}</SelectItem>
      </SelectContent>
    </Select>
  );
}
