import { exactEstimateTokens } from "../src/utils/tokenizer";
import * as fs from "fs";

async function run() {
  console.log("Generating large text...");
  // Create a large text of ~22k tokens
  // A word is ~1.3 tokens. 15000 words ~ 20k tokens.
  const words = Array.from({ length: 15000 }, () => "hello world qwen model test tokenizer performance optimization").join(" ");
  
  console.log("Measuring exactEstimateTokens on Qwen...");
  const start = Date.now();
  // Using Qwen tokenizer which resolution maps to Xenova/Qwen2.5-7B-Instruct
  // We need process.env.TOKENIZER_MODEL_REPOS to resolve correctly, but let's just pass "qwen3.7-plus"
  const tokens = await exactEstimateTokens(words, "qwen3.7-plus");
  const end = Date.now();
  console.log(`Resolved ${tokens} tokens in ${end - start} ms`);
}

run().catch(console.error);
