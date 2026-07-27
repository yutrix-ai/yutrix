import { db } from "../db";
import { chatLogs, systemSettings, endpointRoutes, endpoints, subdomains } from "../db/schema";
import { logEmitter } from "../utils/events";
import { systemToken } from "../utils/systemToken";
import { eq } from "drizzle-orm";
import { ChatLogPayload } from "./chatLogTypes";

export function triggerSessionTitleSummarization(
  payload: ChatLogPayload,
  finalInputText: string | null | undefined,
  finalServerSessionId: string
) {
  setTimeout(() => {
    (async () => {
      try {
        const enabledSetting = await db.select().from(systemSettings).where(eq(systemSettings.key, "sessionSummaryEnabled"));
        const routeSetting = await db.select().from(systemSettings).where(eq(systemSettings.key, "sessionSummaryRoute"));

        const isEnabled = enabledSetting.length > 0 && enabledSetting[0].value === "true";
        const routeId = routeSetting.length > 0 ? routeSetting[0].value : "";

        if (isEnabled && routeId) {
          const routeRows = await db
            .select({
              route: endpointRoutes,
              endpoint: endpoints,
              subdomain: subdomains
            })
            .from(endpointRoutes)
            .leftJoin(endpoints, eq(endpointRoutes.endpointId, endpoints.id))
            .leftJoin(subdomains, eq(endpointRoutes.subdomainId, subdomains.id))
            .where(eq(endpointRoutes.id, routeId));

          if (routeRows.length > 0 && routeRows[0].endpoint) {
            const { route, endpoint, subdomain } = routeRows[0];

            let userPrompt = finalInputText || payload.inputText || "";
            let assistantResponse = "";
            try {
              if (payload.outputText) {
                if (payload.outputText.trim().startsWith("{") || payload.outputText.trim().startsWith("[")) {
                  const parsedOut = JSON.parse(payload.outputText);
                  const choice = parsedOut.choices?.[0];
                  if (choice?.message?.content) {
                    assistantResponse = choice.message.content;
                  } else if (choice?.text) {
                    assistantResponse = choice.text;
                  } else if (parsedOut.content) {
                    assistantResponse = String(parsedOut.content);
                  } else {
                    assistantResponse = payload.outputText;
                  }
                } else {
                  assistantResponse = payload.outputText;
                }
              }
            } catch {
              assistantResponse = payload.outputText || "";
            }

            const chatSnippet = `用户: ${userPrompt}\n助手: ${assistantResponse}`;
            const promptText = "请根据以下用户与助手的对话内容，用2-6个字概括出对话主题，直接输出主题词即可，不要包含任何标点符号或额外解释：\n\n" + chatSnippet;
            const requestBody = {
              messages: [
                { role: "user", content: promptText }
              ]
            };

            const port = Number(process.env.PORT) || 3000;
            const localUrl = `http://127.0.0.1:${port}${endpoint.path}`;
            const hostHeader = subdomain?.hostname || "*";
            const authHeader = `Bearer ${payload.apiKey || ("pg_system_" + systemToken)}`;

            const headers: Record<string, string> = {
              "Content-Type": "application/json",
              "Authorization": authHeader,
              "X-PromptGate-No-Summary": "true",
              "X-PromptGate-User-Id": payload.userId,
            };
            if (hostHeader && hostHeader !== "*") {
              headers["Host"] = hostHeader;
            }

            const response = await fetch(localUrl, {
              method: "POST",
              headers,
              body: JSON.stringify(requestBody),
            });

            if (response.ok) {
              const data: any = await response.json();
              let title = "";
              const choice = data.choices?.[0];
              if (choice?.message?.content) {
                title = choice.message.content.trim();
              } else if (choice?.text) {
                title = choice.text.trim();
              } else if (data.content) {
                title = String(data.content).trim();
              }

              title = title.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
              title = title.replace(/["'“”`]/g, "").replace(/[。！.!?？]/g, "").trim();
              if (title.length > 20) {
                title = title.substring(0, 20);
              }

              if (title) {
                await db
                  .update(chatLogs)
                  .set({ sessionTitle: title })
                  .where(eq(chatLogs.serverSessionId, finalServerSessionId || ""));

                logEmitter.emit("chatSessionTitleUpdate", {
                  serverSessionId: finalServerSessionId,
                  sessionTitle: title
                });
              }
            } else {
              const errText = await response.text();
              console.error(`[ChatLogService] Summarization request failed with status ${response.status}: ${errText}`);
            }
          } else {
            console.warn(`[ChatLogService] Summarization route ${routeId} not found (possibly deleted). Disabling session summary setting.`);
            await db
              .update(systemSettings)
              .set({ value: "false", updatedAt: new Date() })
              .where(eq(systemSettings.key, "sessionSummaryEnabled"));
            await db
              .update(systemSettings)
              .set({ value: "", updatedAt: new Date() })
              .where(eq(systemSettings.key, "sessionSummaryRoute"));
          }
        }
      } catch (sumErr) {
        console.error("[ChatLogService] Failed in background summarization process:", sumErr);
      }
    })();
  }, 3000);
}
