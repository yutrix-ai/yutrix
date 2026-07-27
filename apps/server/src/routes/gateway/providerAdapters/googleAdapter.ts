import { ProviderAdapter, ProviderAdapterContext } from "./types";
import { googleGemmaTranslator } from "../translators/googleGemmaTranslator";

/**
 * Strict hostname check for Google domains.
 * Matches: googleapis.com, generativelanguage.googleapis.com, *.googleapis.com
 * Rejects: evilgoogleapis.com, googleapis.com.example.com
 */
function isGoogleHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "googleapis.com" || h.endsWith(".googleapis.com");
}

export const googleAdapter: ProviderAdapter = {
  id: "google",
  match(context: ProviderAdapterContext): boolean {
    const hostname = context.hostname.toLowerCase();
    return isGoogleHostname(hostname);
  },

  createAttemptState(_context: ProviderAdapterContext): any {
    return {
      isInsideGoogleThoughtTag: false,
      isGoogleGemmaStream: false
    };
  },

  transformStreamChunk(chunk: any, state: any, context: ProviderAdapterContext): boolean {
    const compatCtx = {
      modelId: context.modelId,
      providerProtocol: context.providerProtocol
    };
    return googleGemmaTranslator.translateStreamChunk(chunk, state, compatCtx);
  },

  transformNonStreamResponse(response: any, context: ProviderAdapterContext): boolean {
    if (!response || typeof response !== "object") return false;
    const compatCtx = {
      modelId: context.modelId,
      providerProtocol: context.providerProtocol
    };

    let modified = false;
    if (response.choices && Array.isArray(response.choices)) {
      for (const choice of response.choices) {
        if (choice.message) {
          modified = googleGemmaTranslator.translateNonStreamMessage(choice.message, compatCtx) || modified;
        }
      }
    }
    return modified;
  }
};
