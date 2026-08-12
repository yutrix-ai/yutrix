import { ContinuityStrategy, ContinuityContext, ContinuityDecision } from "../types";

export class ReasoningExhaustionStrategy implements ContinuityStrategy {
  name = "ReasoningExhaustion";
  maxRetries = 3;

  async evaluate(context: ContinuityContext): Promise<ContinuityDecision> {
    const { responseData, originalBody, accumulatedCompletionText, streamResult } = context;

    if (responseData?.isStream && !streamResult) {
      return { shouldIntervene: false };
    }

    let hasToolCalls = false;
    let parsedData = responseData?.data;

    // In stream situations we use the accumulated completion text.
    // Otherwise fallback to parsedData if not a stream.
    let textToCheck = accumulatedCompletionText;

    if (!parsedData && responseData?.isFakeStream && textToCheck) {
      try { parsedData = JSON.parse(textToCheck); } catch(e) {}
    } else if (!responseData?.isFakeStream && !responseData?.isStream && parsedData) {
      if (parsedData.choices?.[0]?.message?.content) {
         textToCheck = parsedData.choices[0].message.content;
      } else if (parsedData.content && Array.isArray(parsedData.content)) {
         textToCheck = parsedData.content.map((b: any) => b.text || "").join("");
      }
    }

    if (parsedData?.choices?.[0]?.message?.tool_calls?.length > 0) hasToolCalls = true;
    if (parsedData?.content && Array.isArray(parsedData.content) && parsedData.content.some((b: any) => b.type === "tool_use")) hasToolCalls = true;
    if (textToCheck && (textToCheck.includes("<tool_calls>") || textToCheck.includes("\"tool_calls\""))) hasToolCalls = true;

    let cleanVisibleText = textToCheck || "";
    let reasoningText = "";

    // Extract <reasoning> blocks from visible text if present
    if (cleanVisibleText) {
      const rMatches = cleanVisibleText.matchAll(/<reasoning>([\s\S]*?)<\/reasoning>/g);
      for (const m of rMatches) { reasoningText += m[1].trim() + "\n"; }
      cleanVisibleText = cleanVisibleText.replace(/<reasoning>[\s\S]*?<\/reasoning>/g, "").trim();

      // Extract <think> blocks from visible text if present
      const tMatches = cleanVisibleText.matchAll(/<think>([\s\S]*?)<\/think>/g);
      for (const m of tMatches) { reasoningText += m[1].trim() + "\n"; }
      cleanVisibleText = cleanVisibleText.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    }

    // Check native reasoning_content field (from OpenAI models like deepseek-reasoner or glm-5)
    if (parsedData?.choices?.[0]?.message?.reasoning_content) {
      reasoningText += parsedData.choices[0].message.reasoning_content;
    }

    // Conditions: visible content is empty, reasoning content is present, and there are NO tool calls.
    const isReasoningOnlyHit = cleanVisibleText.trim() === "" && reasoningText.trim() !== "" && !hasToolCalls;

    if (isReasoningOnlyHit) {
      const injectPrompt = "请继续完成上一轮任务，直接输出用户可见的最终结果；不要只输出推理过程。";
      let assistantContent = cleanVisibleText;

      if (reasoningText && !assistantContent.includes("<think>") && !assistantContent.includes("<reasoning>")) {
        assistantContent = `<think>${reasoningText.trim()}</think>\n` + assistantContent;
      }

      const modifiedBody = { ...originalBody };

      if (modifiedBody.messages && Array.isArray(modifiedBody.messages)) {
        modifiedBody.messages = [...modifiedBody.messages];
        modifiedBody.messages.push({ role: "assistant", content: assistantContent });
        modifiedBody.messages.push({ role: "user", content: injectPrompt });
      } else if (modifiedBody.prompt && typeof modifiedBody.prompt === "string") {
        modifiedBody.prompt += "\n" + assistantContent + "\n\nUser: " + injectPrompt + "\n\nAssistant:";
      }

      // We persist reasoning text length info for the logger to use later in gatewayExecutor.
      context.state.set("reasoningTextLength", reasoningText.length);
      context.state.set("cleanVisibleTextLength", cleanVisibleText.length);

      return {
        shouldIntervene: true,
        strategyName: this.name,
        modifiedBody
      };
    }

    return { shouldIntervene: false };
  }

  async onExhausted(context: ContinuityContext): Promise<any> {
    const { responseData } = context;
    const fallbackMsg = "\n\n*(系统提示：模型多次尝试仅输出推理过程，未生成有效结果，请尝试调整提示词或重试)*";

    if (responseData.data?.choices?.[0]?.message) {
      responseData.data.choices[0].message.content = (responseData.data.choices[0].message.content || "") + fallbackMsg;
    } else if (responseData.data?.content && Array.isArray(responseData.data.content)) {
      responseData.data.content.push({ type: "text", text: fallbackMsg });
    } else if (responseData.data) {
      responseData.data.response = (responseData.data.response || "") + fallbackMsg;
    }

    return responseData;
  }
}
