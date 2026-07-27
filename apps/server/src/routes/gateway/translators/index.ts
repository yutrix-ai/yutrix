import { ModelTranslator } from "./types";
import { googleGemmaTranslator } from "./googleGemmaTranslator";

export const activeTranslators: ModelTranslator[] = [
  googleGemmaTranslator
];
