import { afterEach, describe, expect, it } from "vitest";
import {
  estimateTokensFallback,
  resolveTokenizerRepo,
} from "../src/utils/tokenizer";

describe("tokenizer repo resolution", () => {
  afterEach(() => {
    delete process.env.TOKENIZER_MODEL_REPOS;
    delete process.env.TOKENIZER_REPO_OVERRIDES;
  });

  it("resolves modern model ids to compatible tokenizer repos", () => {
    expect(resolveTokenizerRepo("qwen3.7-max")).toMatchObject({
      repo: "Qwen/Qwen2.5-7B-Instruct",
      source: "family",
    });

    expect(resolveTokenizerRepo("deepseek-v4-flash")).toMatchObject({
      repo: "deepseek-ai/DeepSeek-V4-Flash",
      source: "exact",
    });

    expect(resolveTokenizerRepo("minimax-m2.5")).toMatchObject({
      repo: "MiniMaxAI/MiniMax-M2.5",
      source: "exact",
    });
  });

  it("uses bounded family matching for dated or provider-prefixed variants", () => {
    expect(
      resolveTokenizerRepo("accounts/acme/models/qwen3.7-max-0601"),
    ).toMatchObject({
      repo: "Qwen/Qwen2.5-7B-Instruct",
      source: "family",
    });

    expect(
      resolveTokenizerRepo("openrouter/deepseek/deepseek-v3.2"),
    ).toMatchObject({
      repo: "deepseek-ai/DeepSeek-V3.2",
      source: "exact",
    });
  });

  it("keeps unsupported or incompatible public tokenizers on heuristic fallback", () => {
    expect(resolveTokenizerRepo("kimi-k2.6")).toMatchObject({
      repo: null,
      source: "heuristic",
    });

    expect(resolveTokenizerRepo("glm-5.1")).toMatchObject({
      repo: null,
      source: "heuristic",
    });
  });

  it("allows repo mappings to be supplied without a code change", () => {
    process.env.TOKENIZER_MODEL_REPOS = JSON.stringify({
      "kimi-k2.6": "moonshotai/Kimi-K2.6",
    });

    expect(resolveTokenizerRepo("kimi-k2.6")).toMatchObject({
      repo: "moonshotai/Kimi-K2.6",
      source: "override",
    });
  });
});

describe("tokenizer fallback estimate", () => {
  it("does not use the old unsafe text length divided by three for CJK text", () => {
    const text = "中文提示词用于测试本地降级估算";

    expect(estimateTokensFallback(text)).toBeGreaterThan(
      Math.ceil(text.length / 3),
    );
  });

  it("keeps ASCII estimates conservative enough for code-like text", () => {
    expect(estimateTokensFallback("const answer = 42;")).toBeGreaterThan(0);
  });
});
