import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";

import zh from "./locales/zh.json";
import en from "./locales/en.json";

const resources = {
  en: { translation: en },
  zh: { translation: zh },
};

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: "zh",
    supportedLngs: ["zh", "en"],
    load: "languageOnly",
    nonExplicitSupportedLngs: true,
    detection: {
      order: ["localStorage", "navigator", "htmlTag"],
      lookupLocalStorage: "promptgate.language",
      caches: ["localStorage"],
    },
    interpolation: {
      escapeValue: false, // React already safe from xss
    },
  });

// sync document lang
document.documentElement.lang = i18n.language || "zh";

i18n.on("languageChanged", (lng) => {
  document.documentElement.lang = lng;
});

export default i18n;
