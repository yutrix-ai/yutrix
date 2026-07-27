import { eq } from "drizzle-orm";
import { db } from "../db";
import { userGroupMembers, userGroups, users } from "../db/schema";

export type EffectiveInputTokenLimitSource =
  | "user_override"
  | "group"
  | "unlimited"
  | "unknown_user";

export interface EffectiveInputTokenLimit {
  maxInputTokens: number;
  source: EffectiveInputTokenLimitSource;
  sourceLabel: string;
  groupId?: string;
  groupName?: string;
}

export function normalizeTokenLimit(value: unknown, fallback = 0): number {
  if (value === null || value === undefined || value === "") return fallback;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return fallback;
  return Math.floor(numeric);
}

export async function resolveEffectiveMaxInputTokens(
  userId: string,
): Promise<EffectiveInputTokenLimit> {
  const userRows = await db
    .select({
      id: users.id,
      maxInputTokensOverride: users.maxInputTokensOverride,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (userRows.length === 0) {
    return {
      maxInputTokens: 0,
      source: "unknown_user",
      sourceLabel: "unknown user",
    };
  }

  const userOverride = userRows[0].maxInputTokensOverride;
  if (userOverride !== null && userOverride !== undefined) {
    return {
      maxInputTokens: normalizeTokenLimit(userOverride),
      source: "user_override",
      sourceLabel: "user override",
    };
  }

  const groupRows = await db
    .select({
      id: userGroups.id,
      name: userGroups.name,
      maxInputTokens: userGroups.maxInputTokens,
    })
    .from(userGroupMembers)
    .innerJoin(userGroups, eq(userGroupMembers.groupId, userGroups.id))
    .where(eq(userGroupMembers.userId, userId));

  const positiveGroupLimits = groupRows
    .map((group) => ({
      ...group,
      maxInputTokens: normalizeTokenLimit(group.maxInputTokens),
    }))
    .filter((group) => group.maxInputTokens > 0)
    .sort((a, b) => a.maxInputTokens - b.maxInputTokens);

  if (positiveGroupLimits.length === 0) {
    return {
      maxInputTokens: 0,
      source: "unlimited",
      sourceLabel: "unlimited",
    };
  }

  const strictestGroup = positiveGroupLimits[0];
  return {
    maxInputTokens: strictestGroup.maxInputTokens,
    source: "group",
    sourceLabel: strictestGroup.name,
    groupId: strictestGroup.id,
    groupName: strictestGroup.name,
  };
}
