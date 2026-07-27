import { db } from "../db";
import {
  users,
  inviteCodes,
  systemSettings,
  promptPolicies,
  userGroups,
  providers,
  providerModels,
} from "../db/schema";
import { eq } from "drizzle-orm";
import * as bcrypt from "bcryptjs";
import crypto from "crypto";

export function generateRandomString(length: number) {
  return crypto.randomBytes(length).toString("hex").slice(0, length);
}

export async function seedAdminUser() {
  const adminUsers = await db
    .select()
    .from(users)
    .where(eq(users.role, "admin"));

  if (adminUsers.length === 0) {
    console.log("[PromptGate Bootstrap] First-time initialization...");
    const rawPassword = generateRandomString(16);
    const passwordHash = await bcrypt.hash(rawPassword, 10);

    await db.insert(users).values({
      id: crypto.randomUUID(),
      username: "admin",
      passwordHash,
      role: "admin",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    console.log(`  管理员用户名: admin`);
    console.log(`  管理员密码: ${rawPassword}`);
    console.log("  请在首次登录后修改管理员密码。");

    const rawInviteCode = "pg-inv-" + generateRandomString(12);
    const codeHash = crypto
      .createHash("sha256")
      .update(rawInviteCode)
      .digest("hex");
    const codePrefix = rawInviteCode.substring(0, 10);

    await db.insert(inviteCodes).values({
      id: crypto.randomUUID(),
      codeHash,
      codePrefix,
      maxUses: 10,
      usedCount: 0,
      status: "active",
      createdBy: "system",
      createdAt: new Date(),
    });

    console.log(`  邀请码: ${rawInviteCode}`);
    console.log("  注意：以上信息仅在首次初始化时打印，请妥善保存。");

    const defaultSettings = [
      { key: "theme", value: "system" },
      { key: "accentColor", value: "blue" },
      { key: "mainDomain", value: "localhost" },
      { key: "globalConcurrencyLimit", value: "100" },
      { key: "defaultApiKeyConcurrency", value: "2" },
      { key: "defaultQueueTimeoutMs", value: "30000" },
      { key: "defaultConversationHeader", value: "X-Conversation-Id" },
      { key: "promptInjectionRecordTtlDays", value: "30" },
      { key: "strictUsageMode", value: "true" },
      { key: "realtimeLogsEnabled", value: "true" },
      { key: "logLevel", value: "info" },
      { key: "logRetentionDays", value: "7" },
      { key: "corsAllowlist", value: '["*"]' },
      { key: "trustProxy", value: "true" },
      { key: "allowUnknownHostFallback", value: "false" },
      { key: "analyticsStartOfDay", value: "00:00" },
      { key: "analyticsStartOfWeek", value: "1" },
    ];

    for (const setting of defaultSettings) {
      await db.insert(systemSettings).values({
        key: setting.key,
        value: setting.value,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }
  }
}

export async function seedBrandingSettings() {
  const brandingSettings = [
    { key: "systemName", value: "PromptGate" },
    { key: "systemSlogan", value: "Lightweight LLM Gateway Console" },
    { key: "systemLogoUrl", value: "/favicon.svg" },
    { key: "sidebarLogoAnimation", value: "none" },
    { key: "appendSloganToTitle", value: "false" },
    { key: "hideSystemNameInTitle", value: "false" },
  ];

  for (const setting of brandingSettings) {
    const existing = await db
      .select()
      .from(systemSettings)
      .where(eq(systemSettings.key, setting.key))
      .limit(1);
    if (existing.length === 0) {
      await db.insert(systemSettings).values({
        key: setting.key,
        value: setting.value,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }
  }
}

/**
 * Seed default model discovery settings.
 * These settings control which model IDs are returned by the /v1/models endpoint,
 * enabling third-party clients (Claude Desktop, opencode, etc.) to discover models.
 */
export async function seedModelDiscoverySettings() {
  const modelDiscoveryDefaults = [
    { key: "modelDiscoveryEnabled", value: "true" },
    {
      key: "modelDiscoveryOpenai",
      value: JSON.stringify([
        "gpt-4.1",
        "gpt-4.1-mini",
        "gpt-4.1-nano",
        "o3",
        "o4-mini",
      ]),
    },
    {
      key: "modelDiscoveryAnthropic",
      value: JSON.stringify([
        "claude-opus-4-20250918",
        "claude-sonnet-4-20250514",
        "claude-haiku-4-20250506",
      ]),
    },
  ];

  for (const setting of modelDiscoveryDefaults) {
    const existing = await db
      .select()
      .from(systemSettings)
      .where(eq(systemSettings.key, setting.key))
      .limit(1);
    if (existing.length === 0) {
      await db.insert(systemSettings).values({
        key: setting.key,
        value: setting.value,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }
  }
}

export async function seedBuiltinPromptPolicies() {
  let adminId = "system";
  const currentAdminList = await db
    .select()
    .from(users)
    .where(eq(users.role, "admin"));
  if (currentAdminList.length > 0) {
    adminId = currentAdminList[0].id;
  }
  const builtins = [
    {
      id: "builtin-claude-code",
      name: "Claude Code Built-in",
      protocol: "anthropic",
      injectPosition: "replace_system",
      injectMode: "once_per_conversation",
      content: "You are Claude Code, an AI assistant.",
      version: 1,
      conversationKeySource: "header",
      conversationKeyName: "x-conversation-id",
      enabled: true,
    },
    {
      id: "builtin-codex-cli",
      name: "Codex CLI Built-in",
      protocol: "openai",
      injectPosition: "replace_system",
      injectMode: "once_per_conversation",
      content: "You are Codex CLI, a coding assistant.",
      version: 1,
      conversationKeySource: "header",
      conversationKeyName: "x-conversation-id",
      enabled: true,
    },
  ];
  for (const policy of builtins) {
    const existing = await db
      .select()
      .from(promptPolicies)
      .where(eq(promptPolicies.id, policy.id));
    if (existing.length === 0) {
      await db.insert(promptPolicies).values({
        ...policy,
        userId: adminId,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }
  }
}

export async function syncManualModels() {
  try {
    const allProviders = await db.select().from(providers);
    for (const p of allProviders) {
      if (p.manualModels) {
        let parsedManualModels = [];
        try {
          parsedManualModels = JSON.parse(p.manualModels);
        } catch (e) {
          console.warn(`[PromptGate Bootstrap] Failed to parse manualModels for provider ${p.id}`);
          continue;
        }

        if (Array.isArray(parsedManualModels) && parsedManualModels.length > 0) {
          const defaultProtocol = p.openaiBaseUrl ? "openai" : (p.anthropicBaseUrl ? "anthropic" : "openai");
          const existingModels = await db
            .select()
            .from(providerModels)
            .where(eq(providerModels.providerId, p.id));
          const existingKeys = new Set(existingModels.map(m => m.modelId));

          for (const modelId of parsedManualModels) {
            if (!existingKeys.has(modelId)) {
              await db.insert(providerModels).values({
                id: crypto.randomUUID(),
                providerId: p.id,
                modelId: modelId,
                displayName: modelId,
                enabled: true,
                active: true,
                createdAt: new Date(),
              });
            }
          }
        }
      }
    }
  } catch (err) {
    console.error("[PromptGate Bootstrap] Error syncing manualModels to provider_models:", err);
  }
}

export async function ensureDefaultGroup() {
  const defaultGroups = await db
    .select()
    .from(userGroups)
    .where(eq(userGroups.isDefault, true));

  let defaultGroup: typeof userGroups.$inferSelect;

  if (defaultGroups.length === 0) {
    const now = new Date();
    const groupId = crypto.randomUUID();
    await db.insert(userGroups).values({
      id: groupId,
      name: "默认组",
      description: "系统默认用户组，包含所有普通用户",
      isDefault: true,
      maxInputTokens: 0,
      createdAt: now,
      updatedAt: now,
    });
    defaultGroup = {
      id: groupId,
      name: "默认组",
      description: "系统默认用户组，包含所有普通用户",
      isDefault: true,
      maxInputTokens: 0,
      createdAt: now,
      updatedAt: now,
    };
    console.log("[PromptGate Bootstrap] 已创建默认用户组");
  } else {
    defaultGroup = defaultGroups[0];
  }
}
