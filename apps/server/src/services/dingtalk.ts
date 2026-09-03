import crypto from "crypto";
import cron, { ScheduledTask } from "node-cron";
import { db } from "../db";
import { systemSettings } from "../db/schema";
import { eq } from "drizzle-orm";
import { getStatisticsData } from "./statistics";

let currentTask: ScheduledTask | null = null;

async function getSetting(key: string): Promise<string | null> {
  const result = await db.select().from(systemSettings).where(eq(systemSettings.key, key));
  return result.length > 0 ? result[0].value : null;
}

function compactNumber(num: number): string {
  if (num >= 1000000) return (num / 1000000).toFixed(1) + "M";
  if (num >= 1000) return (num / 1000).toFixed(1) + "K";
  return num.toString();
}

function formatCost(val: number): string {
  if (val <= 0) return "$0.00";
  if (val < 0.01) return `$${val.toFixed(4)}`;
  return `$${val.toFixed(2)}`;
}

export async function generateStatsReport(): Promise<{ report: string; validTokenCount: number }> {
  const now = new Date();
  const startTime = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const lang = (await getSetting("dingTalkLanguage")) || "zh";
  const excludeUsersStr = await getSetting("dingTalkExcludeUsers");
  let excludedUsers: string[] = [];
  if (excludeUsersStr) {
    try {
      excludedUsers = JSON.parse(excludeUsersStr);
    } catch (e) {}
  }

  const stats = await getStatisticsData(startTime, now, excludedUsers);

  const userRanking = stats.userRanking.slice(0, 10);
  const modelRanking = stats.modelRanking.slice(0, 10);

  const rankTable = userRanking.length > 0
    ? userRanking.map((u, i) => `| #${i + 1} | ${u.username} | ${u.totalRequests.toLocaleString()} | ${compactNumber(u.inputTokens)} | ${compactNumber(u.outputTokens)} | ${compactNumber(u.totalTokens)} | ${formatCost(u.totalCost)} |`).join("\n")
    : (lang === "zh" ? "| - | - | - | - | - | - | - |" : "| - | - | - | - | - | - | - |");

  const modelTable = modelRanking.length > 0
    ? modelRanking.map((m, i) => `| #${i + 1} | ${m.modelId} | ${m.totalRequests.toLocaleString()} | ${compactNumber(m.inputTokens)} | ${compactNumber(m.outputTokens)} | ${compactNumber(m.totalTokens)} | ${formatCost(m.totalCost)} |`).join("\n")
    : (lang === "zh" ? "| - | - | - | - | - | - | - |" : "| - | - | - | - | - | - | - |");

  if (lang === "en") {
    const report = `### 📊 PromptGate Daily Report (Past 24H)

#### 👥 User Usage Ranking
| Rank | User | Calls | Input | Output | Total | Cost (USD) |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
${rankTable}

#### 🤖 Model Usage Ranking
| Rank | Model | Calls | Input | Output | Total | Cost (USD) |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
${modelTable}

> 💡 *Note: **K** = Thousand, **M** = Million*

---
**📊 System Summary**
* **Total Requests**: ${stats.systemSummary.totalRequests.toLocaleString()}
* **Total Tokens**: ${stats.systemSummary.totalTokens.toLocaleString()} (Input: ${stats.systemSummary.totalInputTokens.toLocaleString()} / Output: ${stats.systemSummary.totalOutputTokens.toLocaleString()})
* **Total Cost**: ${formatCost(stats.systemSummary.totalCost)} (USD)`;
    return { report, validTokenCount: stats.systemSummary.validTokenCount };
  }

  const report = `### 📊 PromptGate 每日数据报表 (近 24 小时)

#### 👥 用户使用排行
| 排名 | 用户 | 次数 | 输入 Token | 输出 Token | 总 Token | 费用 (USD) |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
${rankTable}

#### 🤖 模型使用排行
| 排名 | 模型 | 次数 | 输入 Token | 输出 Token | 总 Token | 费用 (USD) |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
${modelTable}

> 💡 *注：**K** = 千，**M** = 百万*

---
**📊 系统汇总**
* **总请求数**: ${stats.systemSummary.totalRequests.toLocaleString()} 次
* **总消耗 Token**: ${stats.systemSummary.totalTokens.toLocaleString()} (输入: ${stats.systemSummary.totalInputTokens.toLocaleString()} / 输出: ${stats.systemSummary.totalOutputTokens.toLocaleString()})
* **总费用**: ${formatCost(stats.systemSummary.totalCost)} (USD)`;
  return { report, validTokenCount: stats.systemSummary.validTokenCount };
}

async function sendDingTalkMessage(webhook: string, secret: string, content: string) {
  const timestamp = Date.now().toString();
  const stringToSign = timestamp + "\n" + secret;
  const hash = crypto.createHmac("sha256", secret).update(stringToSign).digest("base64");
  const sign = encodeURIComponent(hash);

  const url = `${webhook}&timestamp=${timestamp}&sign=${sign}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      msgtype: "markdown",
      markdown: {
        title: "PromptGate Daily Report",
        text: content,
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`DingTalk API Error: ${response.statusText}`);
  }
}

export async function triggerDingTalkPush(isManual: boolean = false) {
  const enabled = await getSetting("dingTalkEnabled");
  if (enabled !== "true") {
    throw new Error("DingTalk push is disabled.");
  }

  const webhook = await getSetting("dingTalkWebhook");
  const secret = await getSetting("dingTalkSecret");

  if (!webhook || !secret) {
    throw new Error("DingTalk webhook or secret is not configured.");
  }

  const { report, validTokenCount } = await generateStatsReport();

  if (!isManual) {
    const skipEmpty = await getSetting("dingTalkSkipEmpty");
    if (skipEmpty === "true" && validTokenCount <= 0) {
      console.log("DingTalk push skipped: no valid token usage detected.");
      return;
    }
  }

  await sendDingTalkMessage(webhook, secret, report);
}

export function stopDingTalkJobs() {
  if (currentTask) {
    currentTask.stop();
    currentTask = null;
  }
}

export async function scheduleDingTalkJobs() {
  if (currentTask) {
    currentTask.stop();
    currentTask = null;
  }

  const enabled = await getSetting("dingTalkEnabled");
  const cronSpec = await getSetting("dingTalkCron");

  if (enabled === "true" && cronSpec && cron.validate(cronSpec)) {
    currentTask = cron.schedule(cronSpec, async () => {
      try {
        await triggerDingTalkPush();
        console.log("Scheduled DingTalk push completed successfully.");
      } catch (e: any) {
        console.error("Scheduled DingTalk push failed:", e.message);
      }
    });
    console.log(`DingTalk push scheduled with cron: ${cronSpec}`);
  }
}
