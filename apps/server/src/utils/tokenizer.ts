import { logAction } from "./actionLogger";
import { countOpenAiTokens, isOpenAiTokenizerModel } from "./openaiTokenizer";

type TokenizerModule = {
  AutoTokenizer: {
    from_pretrained(repo: string): Promise<any>;
  };
};

type TransformersEnvModule = {
  env: {
    allowLocalModels: boolean;
  };
};

const dynamicImport = new Function("specifier", "return import(specifier)") as <
  T,
>(
  specifier: string,
) => Promise<T>;

export type TokenizerResolutionSource =
  | "override"
  | "exact"
  | "family"
  | "heuristic"
  | "default";

export type TokenizerResolution = {
  repo: string | null;
  source: TokenizerResolutionSource;
  reason: string;
};

const DEFAULT_TOKENIZER_REPO = "Xenova/gpt-4";



const tokenizerCache = new Map<string, Promise<any>>();
let tokenizerModulePromise: Promise<TokenizerModule> | undefined;
const repoProxyMap = new Map<string, string>();
const failedRepos = new Set<string>();

function normalizeModelId(modelId: string): string {
  return modelId
    .trim()
    .toLowerCase()
    .replace(/^models\//, "");
}

function getModelIdCandidates(modelId: string): string[] {
  const normalized = normalizeModelId(modelId);
  const terminal = normalized.split(/[/:]/).filter(Boolean).pop() || normalized;
  return Array.from(new Set([normalized, terminal]));
}

function readRepoOverrides(): Record<string, string> {
  const raw =
    process.env.TOKENIZER_MODEL_REPOS || process.env.TOKENIZER_REPO_OVERRIDES;
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return {};

    const overrides: Record<string, string> = {};
    for (const [modelId, repo] of Object.entries(parsed)) {
      if (
        typeof modelId === "string" &&
        typeof repo === "string" &&
        repo.trim()
      ) {
        overrides[normalizeModelId(modelId)] = repo.trim();
      }
    }
    return overrides;
  } catch {
    return {};
  }
}

function candidatesMatch(candidates: string[], pattern: RegExp): boolean {
  return candidates.some((candidate) => pattern.test(candidate));
}

export function resolveTokenizerRepo(modelId: string, explicitRepo?: string | null): TokenizerResolution {
  if (explicitRepo && explicitRepo.trim()) {
    return {
      repo: explicitRepo.trim(),
      source: "override",
      reason: "explicitly configured tokenizer repository",
    };
  }

  if (!modelId) {
    return {
      repo: DEFAULT_TOKENIZER_REPO,
      source: "default",
      reason: "empty model id",
    };
  }

  const candidates = getModelIdCandidates(modelId);
  const overrides = readRepoOverrides();
  for (const candidate of candidates) {
    const repo = overrides[candidate];
    if (repo) {
      return {
        repo,
        source: "override",
        reason: "TOKENIZER_MODEL_REPOS override",
      };
    }
  }

  // Exact matches
  for (const candidate of candidates) {
    if (candidate === "deepseek-v4-flash") {
      return {
        repo: "deepseek-ai/DeepSeek-V4-Flash",
        source: "exact",
        reason: "Exact match for DeepSeek-V4-Flash",
      };
    }
    if (candidate === "minimax-m2.5") {
      return {
        repo: "MiniMaxAI/MiniMax-M2.5",
        source: "exact",
        reason: "Exact match for MiniMax-M2.5",
      };
    }
    if (candidate === "deepseek-v3.2") {
      return {
        repo: "deepseek-ai/DeepSeek-V3.2",
        source: "exact",
        reason: "Exact match for DeepSeek-V3.2",
      };
    }
  }

  // Family matches
  for (const candidate of candidates) {
    if (candidate.includes("qwen")) {
      return {
        repo: "Qwen/Qwen2.5-7B-Instruct",
        source: "family",
        reason: "Qwen family tokenizer",
      };
    }
  }

  // Heuristic fallbacks for unsupported public tokenizers
  for (const candidate of candidates) {
    if (candidate.includes("kimi") || candidate.includes("glm")) {
      return {
        repo: null,
        source: "heuristic",
        reason: "Heuristic fallback for unsupported client/provider family",
      };
    }
  }

  return {
    repo: DEFAULT_TOKENIZER_REPO,
    source: "default",
    reason: "unknown model id, using default generic tokenizer",
  };
}

const resolvedTokenizers = new Map<string, any>();

async function loadTokenizerModule(): Promise<TokenizerModule> {
  if (!tokenizerModulePromise) {
    // The package root imports image utilities and may require sharp; tokenizers do not need it.
    tokenizerModulePromise = Promise.all([
      dynamicImport<TokenizerModule>("@xenova/transformers/src/tokenizers.js"),
      dynamicImport<TransformersEnvModule>("@xenova/transformers/src/env.js"),
    ])
      .then(([tokenizers, envModule]: any) => {
        envModule.env.allowLocalModels = false;

        const originalFetch = globalThis.fetch || fetch;
        const customFetch = async (url: any, options: any) => {
          const urlString = String(url);
          let proxyUrl: string | null = null;
          for (const [repo, pUrl] of repoProxyMap.entries()) {
            if (urlString.includes(repo)) {
              proxyUrl = pUrl;
              break;
            }
          }
          if (proxyUrl) {
            const undici = await import("undici");
            const uFetch = undici.fetch as any;
            return uFetch(url, { ...options, dispatcher: new undici.ProxyAgent(proxyUrl) });
          }
          return originalFetch(url, options);
        };
        globalThis.fetch = customFetch;
        (global as any).fetch = customFetch;

        return tokenizers;
      })
      .catch((error) => {
        tokenizerModulePromise = undefined;
        throw error;
      });
  }
  return tokenizerModulePromise;
}

async function getTokenizer(repo: string, proxyUrl?: string | null) {
  if (proxyUrl) {
    repoProxyMap.set(repo, proxyUrl);
  }
  let tokenizerPromise = tokenizerCache.get(repo);
  if (!tokenizerPromise) {
    tokenizerPromise = loadTokenizerModule()
      .then(({ AutoTokenizer }) => AutoTokenizer.from_pretrained(repo))
      .then((tokenizer) => {
        resolvedTokenizers.set(repo, tokenizer);
        return tokenizer;
      });
    tokenizerCache.set(repo, tokenizerPromise);
  }

  try {
    return await tokenizerPromise;
  } catch (error) {
    tokenizerCache.delete(repo);
    throw error;
  }
}

function isCjkLikeChar(char: string): boolean {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}]/u.test(
    char,
  );
}

function isEmojiLikeChar(char: string): boolean {
  const codePoint = char.codePointAt(0) || 0;
  return (
    (codePoint >= 0x1f000 && codePoint <= 0x1faff) ||
    (codePoint >= 0x2600 && codePoint <= 0x27bf)
  );
}

function isAsciiChar(char: string): boolean {
  return /^[\x00-\x7f]$/.test(char);
}

function describeTokenizerError(error: any): string {
  return String(error?.message || error)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 600);
}

export function estimateTokensFallback(text: string): number {
  if (!text) return 0;

  let estimated = 0;
  let asciiRunLength = 0;

  const flushAsciiRun = () => {
    if (asciiRunLength === 0) return;
    estimated += Math.ceil(asciiRunLength / 3);
    asciiRunLength = 0;
  };

  for (const char of Array.from(text)) {
    if (isAsciiChar(char)) {
      asciiRunLength += 1;
      continue;
    }

    flushAsciiRun();

    if (isCjkLikeChar(char)) {
      estimated += 1.2;
    } else if (isEmojiLikeChar(char)) {
      estimated += 2;
    } else {
      estimated += 1.5;
    }
  }

  flushAsciiRun();

  return Math.max(1, Math.ceil(estimated));
}

export async function exactEstimateTokens(
  text: string,
  modelId: string,
  proxyUrl?: string | null,
  explicitRepo?: string | null
): Promise<number> {
  if (!text) return 0;

  // Fast path: if the text is massive (>100k chars, approx 25k-50k tokens),
  // fallback to rough estimation instantly to prevent blocking the Node.js event loop
  // with synchronous WASM tokenizer calls, which causes 100%+ CPU spikes.
  if (text.length > 100000) {
    return estimateTokensFallback(text);
  }

  if (!explicitRepo && isOpenAiTokenizerModel(modelId)) {
    const openAiCount = await countOpenAiTokens(text, modelId);
    if (openAiCount !== null) return openAiCount;
  }

  const resolution = resolveTokenizerRepo(modelId, explicitRepo);

  if (!resolution.repo) {
    return estimateTokensFallback(text);
  }

  const repo = resolution.repo;

  const resolvedTokenizer = resolvedTokenizers.get(repo);
  if (resolvedTokenizer) {
    try {
      const tokens = await resolvedTokenizer.encode(text);
      return Math.max(1, tokens.length);
    } catch (error: any) {
      logAction({
        level: "ERROR",
        code: "tokenizer.error",
        modelId,
        tokenizerRepo: repo,
        tokenizerSource: resolution.source,
        fallbackReason: resolution.reason,
        message: `Failed to encode with repo ${repo} for model ${modelId}: ${describeTokenizerError(error)}`,
      });
      return estimateTokensFallback(text);
    }
  }

  // Trigger loading in the background
  getTokenizer(repo, proxyUrl)
    .then(() => {
      logAction({
        level: "INFO",
        code: "tokenizer.loaded",
        modelId,
        tokenizerRepo: repo,
        tokenizerSource: resolution.source,
        fallbackReason: resolution.reason,
        message: `Successfully loaded and cached tokenizer for model ${modelId} from repo ${repo}`,
      });
    })
    .catch((error: any) => {
      if (!failedRepos.has(repo)) {
        failedRepos.add(repo);
        logAction({
          level: "WARN",
          code: "tokenizer.error",
          modelId,
          tokenizerRepo: repo,
          tokenizerSource: resolution.source,
          fallbackReason: resolution.reason,
          message: `Failed to load tokenizer in background from repo ${repo} for model ${modelId}: ${describeTokenizerError(error)}. Using fallback estimator for this repo.`,
        });
      }
    });

  // Immediately fallback to avoid blocking
  return estimateTokensFallback(text);
}
