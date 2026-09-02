import { db } from "../../db";
import {
  chatLogs,
  distillationLearnedRecords,
  users,
} from "../../db/schema";
import { and, asc, eq, gte, inArray, lte, notInArray } from "drizzle-orm";
import type { LearningRecord } from "./analyzer";

export async function selectPendingLearningRecords(options: {
  userIds?: string[];
  timeRangeStart?: Date;
  timeRangeEnd?: Date;
  maxRecords?: number;
  fullRellearn?: boolean;
}): Promise<LearningRecord[]> {
  const learned = options.fullRellearn
    ? []
    : await db.select({ chatLogId: distillationLearnedRecords.chatLogId }).from(
        distillationLearnedRecords,
      );
  const learnedIds = learned.map((r) => r.chatLogId);

  const conditions = [];
  if (learnedIds.length > 0) {
    conditions.push(notInArray(chatLogs.id, learnedIds));
  }
  if (options.userIds?.length) {
    conditions.push(inArray(chatLogs.userId, options.userIds));
  }
  if (options.timeRangeStart) {
    conditions.push(gte(chatLogs.createdAt, options.timeRangeStart));
  }
  if (options.timeRangeEnd) {
    conditions.push(lte(chatLogs.createdAt, options.timeRangeEnd));
  }

  const limit = options.maxRecords ?? 500;
  const rows = await db
    .select({
      chatLogId: chatLogs.id,
      userId: chatLogs.userId,
      username: users.username,
      inputText: chatLogs.inputText,
      outputText: chatLogs.outputText,
      status: chatLogs.status,
      error: chatLogs.error,
      model: chatLogs.model,
      createdAt: chatLogs.createdAt,
    })
    .from(chatLogs)
    .innerJoin(users, eq(chatLogs.userId, users.id))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(asc(chatLogs.createdAt))
    .limit(limit);

  return rows.map((r) => ({
    chatLogId: r.chatLogId,
    userId: r.userId,
    username: r.username,
    inputText: r.inputText,
    outputText: r.outputText,
    status: r.status,
    error: r.error,
    model: r.model,
    createdAt: r.createdAt,
  }));
}

export async function resetLearnedRecords(): Promise<number> {
  const all = await db.select().from(distillationLearnedRecords);
  if (all.length === 0) return 0;
  await db.delete(distillationLearnedRecords);
  return all.length;
}
