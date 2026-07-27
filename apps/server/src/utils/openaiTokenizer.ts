const dynamicImport = new Function("specifier", "return import(specifier)") as <
  T,
>(
  specifier: string,
) => Promise<T>;

let tiktokenNodeModulePromise: Promise<any> | undefined;
let tiktokenWasmModulePromise: Promise<any> | undefined;
const tiktokenNodeEncoders = new Map<string, any>();
const tiktokenWasmEncoders = new Map<string, any>();

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

export function isOpenAiTokenizerModel(modelId: string): boolean {
  const candidates = getModelIdCandidates(modelId);
  return candidates.some((candidate) => (
    candidate.startsWith("gpt-") ||
    candidate.startsWith("chatgpt-") ||
    /^o\d/.test(candidate) ||
    candidate.includes("openai/gpt-") ||
    candidate.includes("text-davinci") ||
    candidate.includes("davinci") ||
    candidate.includes("babbage") ||
    candidate.includes("curie") ||
    candidate.includes("ada") ||
    candidate.includes("text-embedding")
  ));
}

function preferredOpenAiEncoding(modelId: string): "o200k_base" | "cl100k_base" {
  const candidates = getModelIdCandidates(modelId);
  const usesModernEncoding = candidates.some((candidate) => (
    candidate.includes("gpt-4o") ||
    candidate.includes("gpt-4.1") ||
    candidate.includes("gpt-4.5") ||
    candidate.includes("gpt-5") ||
    /^o\d/.test(candidate)
  ));
  return usesModernEncoding ? "o200k_base" : "cl100k_base";
}

async function loadTiktokenNodeModule(): Promise<any> {
  if (!tiktokenNodeModulePromise) {
    tiktokenNodeModulePromise = dynamicImport<any>("tiktoken-node")
      .then((mod: any) => mod.default || mod)
      .catch((error) => {
        tiktokenNodeModulePromise = undefined;
        throw error;
      });
  }
  return tiktokenNodeModulePromise;
}

async function loadTiktokenWasmModule(): Promise<any> {
  if (!tiktokenWasmModulePromise) {
    tiktokenWasmModulePromise = dynamicImport<any>("tiktoken")
      .catch((error) => {
        tiktokenWasmModulePromise = undefined;
        throw error;
      });
  }
  return tiktokenWasmModulePromise;
}

async function countWithTiktokenNode(text: string, modelId: string): Promise<number | null> {
  const encodingName = preferredOpenAiEncoding(modelId);
  // tiktoken-node 0.0.7 is fast, but it does not ship o200k_base. Use it only
  // when it can count the model family without underestimating modern models.
  if (encodingName === "o200k_base") return null;

  try {
    const tiktoken = await loadTiktokenNodeModule();
    const candidates = getModelIdCandidates(modelId);
    const cacheKey = `node:${candidates[0]}:${encodingName}`;
    let encoder = tiktokenNodeEncoders.get(cacheKey);
    if (!encoder) {
      for (const candidate of candidates) {
        try {
          encoder = tiktoken.encodingForModel(candidate);
          break;
        } catch {
          // Fall through to the encoding-name fallback below.
        }
      }
      if (!encoder) {
        encoder = tiktoken.getEncoding(encodingName);
      }
      tiktokenNodeEncoders.set(cacheKey, encoder);
    }
    return Math.max(1, encoder.encode(text).length);
  } catch {
    return null;
  }
}

async function countWithTiktokenWasm(text: string, modelId: string): Promise<number | null> {
  try {
    const tiktoken = await loadTiktokenWasmModule();
    const encodingName = preferredOpenAiEncoding(modelId);
    const candidates = getModelIdCandidates(modelId);
    const cacheKey = `wasm:${candidates[0]}:${encodingName}`;
    let encoder = tiktokenWasmEncoders.get(cacheKey);
    if (!encoder) {
      for (const candidate of candidates) {
        try {
          encoder = tiktoken.encoding_for_model(candidate);
          break;
        } catch {
          // Fall through to the encoding-name fallback below.
        }
      }
      if (!encoder) {
        encoder = tiktoken.get_encoding(encodingName);
      }
      tiktokenWasmEncoders.set(cacheKey, encoder);
    }
    return Math.max(1, encoder.encode(text).length);
  } catch {
    return null;
  }
}

export async function countOpenAiTokens(text: string, modelId: string): Promise<number | null> {
  const nativeCount = await countWithTiktokenNode(text, modelId);
  if (nativeCount !== null) return nativeCount;
  return countWithTiktokenWasm(text, modelId);
}
