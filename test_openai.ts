import { normalizeAssistantMessageToComparableText, normalizeAssistantResponseToComparableText } from "./apps/server/src/utils/chatTurns.ts";

const msg1 = {
  role: "assistant",
  content: "I will call the weather tool.",
  tool_calls: [{ id: "call_123", type: "function", function: { name: "get_weather", arguments: "{}" } }]
};

const resp1 = JSON.stringify({
  choices: [{
    message: {
      content: "I will call the weather tool.",
      tool_calls: [{ id: "call_123", type: "function", function: { name: "get_weather", arguments: "{}" } }]
    }
  }]
});

console.log("Message Hash input:", normalizeAssistantMessageToComparableText(msg1));
console.log("Response Hash input:", normalizeAssistantResponseToComparableText(resp1));
