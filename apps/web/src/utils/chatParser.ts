export function parseReasoning(text: string | null) {
  if (!text) return { text: "", reasoning: "", toolText: "", routingTrace: [] as any[], routingTraceText: "" };
  const reasoningParts: string[] = [];
  let mainText = text;
  
  // Extract all <reasoning> blocks (global match)
  const rMatches = text.matchAll(/<reasoning>([\s\S]*?)<\/reasoning>/g);
  for (const m of rMatches) {
    reasoningParts.push(m[1].trim());
  }
  if (reasoningParts.length > 0) {
    mainText = text.replace(/<reasoning>[\s\S]*?<\/reasoning>/g, "").trim();
  } else {
    // Try <think> blocks (global match)
    const tMatches = text.matchAll(/<think>([\s\S]*?)<\/think>/g);
    for (const m of tMatches) {
      reasoningParts.push(m[1].trim());
    }
    if (reasoningParts.length > 0) {
      mainText = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    }
  }

  // Extract <tool_calls> blocks
  let toolText = "";
  const tcMatch = mainText.match(/<tool_calls>([\s\S]*?)<\/tool_calls>/);
  if (tcMatch) {
    try {
      const toolCalls = JSON.parse(tcMatch[1]);
      toolText = JSON.stringify(toolCalls, null, 2);
    } catch {
      toolText = tcMatch[1].trim();
    }
    mainText = mainText.replace(/<tool_calls>[\s\S]*?<\/tool_calls>/g, "").trim();
  }

  let routingTrace: any[] = [];
  let routingTraceText = "";
  const rtMatch = mainText.match(/<routing_trace>([\s\S]*?)<\/routing_trace>/);
  if (rtMatch) {
    try {
      const parsedTrace = JSON.parse(rtMatch[1]);
      routingTrace = Array.isArray(parsedTrace) ? parsedTrace : [];
      routingTraceText = JSON.stringify(parsedTrace, null, 2);
    } catch {
      routingTraceText = rtMatch[1].trim();
    }
    mainText = mainText.replace(/<routing_trace>[\s\S]*?<\/routing_trace>/g, "").trim();
  }

  const reasoning = reasoningParts.join("\n\n");
  return { text: mainText, reasoning, toolText, routingTrace, routingTraceText };
}

export function parseAssistantResponse(text: string | null) {
  if (!text) return { text: "", reasoning: "", isRawJson: false, parsedJson: null, toolText: "", routingTrace: [] as any[], routingTraceText: "" };
  
  try {
    const data = JSON.parse(text);
    let assistantText = "";
    let reasoningText = "";
    
    if (data.choices && Array.isArray(data.choices) && data.choices.length > 0) {
      const firstChoice = data.choices[0];
      if (firstChoice.message) {
        assistantText = firstChoice.message.content || "";
        if (firstChoice.message.reasoning_content) {
          reasoningText = firstChoice.message.reasoning_content;
        } else if (firstChoice.message.reasoning) {
          reasoningText = firstChoice.message.reasoning;
        }
        if (!assistantText && firstChoice.message.tool_calls) {
          return {
            text: "",
            reasoning: reasoningText,
            isRawJson: true,
            parsedJson: data,
            toolText: JSON.stringify(firstChoice.message.tool_calls, null, 2),
            routingTrace: [] as any[],
            routingTraceText: "",
          };
        }
      } else if (firstChoice.text) {
        assistantText = firstChoice.text;
      }
    } else if (data.content && Array.isArray(data.content)) {
      const textBlocks = data.content.filter((c: any) => c.type === "text");
      assistantText = textBlocks.map((c: any) => c.text).join("\n");
    } else if (data.output) {
      assistantText = typeof data.output === "string" ? data.output : JSON.stringify(data.output);
    }
    
    if (assistantText || reasoningText) {
      const internalParse = parseReasoning(assistantText);
      return { 
        text: internalParse.text, 
        reasoning: reasoningText || internalParse.reasoning, 
        isRawJson: true, 
        parsedJson: data,
        toolText: internalParse.toolText,
        routingTrace: internalParse.routingTrace,
        routingTraceText: internalParse.routingTraceText,
      };
    }
  } catch (e) {
    // not JSON
  }
  
  const plainParse = parseReasoning(text);
  return { 
    text: plainParse.text, 
    reasoning: plainParse.reasoning, 
    isRawJson: false, 
    parsedJson: null,
    toolText: plainParse.toolText,
    routingTrace: plainParse.routingTrace,
    routingTraceText: plainParse.routingTraceText,
  };
}
