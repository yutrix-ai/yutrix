import { FastifyRequest, FastifyReply } from "fastify";
import { db } from "../db";
import { chatLogs, systemSettings, users, providerModels } from "../db/schema";
import { eq, and, sql, gte, lt, like, desc, asc, inArray, ne } from "drizzle-orm";
import { logEmitter } from "../utils/events";
import { PassThrough } from "stream";
import { fingerprintLogInput, normalizeChatLogTurn } from "../utils/chatTurns";
import { getStartDateFromTimeRange } from "../utils/timeRange";

const SIMILAR_SESSION_WINDOW_MS = 30 * 60 * 1000;
const SESSION_SCAN_MIN_ROWS = 200;
const SESSION_SCAN_MAX_BATCH_ROWS = 800;
const SESSION_SCAN_MAX_ROWS = 20000;
const SESSION_SCAN_OVERFETCH_FACTOR = 12;
const CANDIDATE_SCAN_MAX_ROWS = 1000;
const PREVIEW_TEXT_CHARS = 500;

type SessionSummary = {
  serverSessionId: string | null;
  clientSessionId: string | null;
  userId: string | null;
  clientName: string | null;
  detectedClient: string | null;
  model: string | null;
  turnCount: number;
  inputTokens: number;
  outputTokens: number;
  firstInputText: string | null;
  sessionTitle: string | null;
  firstCreatedAt: string;
  lastUpdatedAt: string;
  relatedSessionIds: string[];
};

const toDate = (val: any) => {
  if (!val) return new Date();
  if (val instanceof Date) return val;
  const num = Number(val);
  if (!isNaN(num)) {
    return new Date(num < 10000000000 ? num * 1000 : num);
  }
  return new Date(val);
};

const normalizedInputFingerprint = (inputText: string | null | undefined) => {
  if (!inputText) return null;
  return normalizeChatLogTurn(inputText, null).inputFingerprint || fingerprintLogInput(inputText);
};

const normalizeSessionTitle = (title: string | null | undefined) => {
  const value = (title || "").trim().replace(/\s+/g, " ");
  if (!value || value === "Unknown Input" || value === "No prompt") return null;
  return value;
};

const sessionIdentityPrefix = (session: SessionSummary) => [
  session.userId || "",
  session.clientName || "",
  session.model || "",
  session.clientSessionId || "",
].join("\u001f");

const sessionKey = (session: SessionSummary) => {
  const title = normalizeSessionTitle(session.sessionTitle);
  if (title) {
    return `${sessionIdentityPrefix(session)}\u001ftitle:${title}`;
  }

  const inputFingerprint = normalizedInputFingerprint(session.firstInputText);
  if (inputFingerprint) {
    return `${sessionIdentityPrefix(session)}\u001finput:${inputFingerprint}`;
  }

  return null;
};

const foldSimilarSessions = (sessions: SessionSummary[]) => {
  const groups = new Map<string, SessionSummary[]>();
  const passthrough: SessionSummary[] = [];

  for (const session of sessions) {
    const key = sessionKey(session);
    if (!session.serverSessionId || !key) {
      passthrough.push(session);
      continue;
    }

    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(session);
  }

  const folded: SessionSummary[] = [...passthrough];
  for (const groupedSessions of groups.values()) {
    groupedSessions.sort((a, b) => new Date(a.firstCreatedAt).getTime() - new Date(b.firstCreatedAt).getTime());

    let active: SessionSummary | null = null;
    for (const session of groupedSessions) {
      if (!active) {
        active = { ...session, relatedSessionIds: [...session.relatedSessionIds] };
        continue;
      }

      const activeLast = new Date(active.lastUpdatedAt).getTime();
      const nextFirst = new Date(session.firstCreatedAt).getTime();
      if (nextFirst - activeLast <= SIMILAR_SESSION_WINDOW_MS) {
        active.turnCount += session.turnCount;
        active.inputTokens += session.inputTokens;
        active.outputTokens += session.outputTokens;
        active.lastUpdatedAt = new Date(Math.max(activeLast, new Date(session.lastUpdatedAt).getTime())).toISOString();
        active.firstCreatedAt = new Date(Math.min(new Date(active.firstCreatedAt).getTime(), nextFirst)).toISOString();
        active.sessionTitle = active.sessionTitle || session.sessionTitle;
        active.relatedSessionIds = Array.from(new Set([...active.relatedSessionIds, ...session.relatedSessionIds]));
      } else {
        folded.push(active);
        active = { ...session, relatedSessionIds: [...session.relatedSessionIds] };
      }
    }

    if (active) folded.push(active);
  }

  folded.sort((a, b) => new Date(b.lastUpdatedAt).getTime() - new Date(a.lastUpdatedAt).getTime());
  return folded;
};

const buildSessionSummariesFromTurns = (turns: any[]): SessionSummary[] => {
  const map = new Map<string, SessionSummary>();

  for (const turn of turns) {
    const serverSessionId = turn.serverSessionId || turn.requestId || turn.id;
    const key = serverSessionId || turn.id;
    const createdAt = toDate(turn.createdAt).toISOString();
    const existing = map.get(key);

    if (!existing) {
      map.set(key, {
        serverSessionId,
        clientSessionId: turn.clientSessionId,
        userId: turn.userId,
        clientName: turn.clientName,
        detectedClient: turn.detectedClient,
        model: turn.model,
        turnCount: 1,
        inputTokens: turn.inputTokens || 0,
        outputTokens: turn.outputTokens || 0,
        firstInputText: turn.inputText,
        sessionTitle: turn.sessionTitle,
        firstCreatedAt: createdAt,
        lastUpdatedAt: createdAt,
        relatedSessionIds: serverSessionId ? [serverSessionId] : [],
      });
      continue;
    }

    existing.turnCount += 1;
    existing.inputTokens += turn.inputTokens || 0;
    existing.outputTokens += turn.outputTokens || 0;
    existing.lastUpdatedAt = new Date(
      Math.max(new Date(existing.lastUpdatedAt).getTime(), new Date(createdAt).getTime()),
    ).toISOString();
    existing.firstCreatedAt = new Date(
      Math.min(new Date(existing.firstCreatedAt).getTime(), new Date(createdAt).getTime()),
    ).toISOString();
    existing.sessionTitle = existing.sessionTitle || turn.sessionTitle;
  }

  return Array.from(map.values());
};

const sessionSummarySelect = {
  serverSessionId: chatLogs.serverSessionId,
  clientSessionId: sql<string>`MAX(${chatLogs.clientSessionId})`,
  userId: sql<string>`MAX(${chatLogs.userId})`,
  clientName: sql<string>`MAX(${chatLogs.clientName})`,
  detectedClient: sql<string>`MAX(${chatLogs.detectedClient})`,
  model: sql<string>`MAX(${chatLogs.model})`,
  turnCount: sql<number>`COUNT(*)`,
  inputTokens: sql<number>`SUM(${chatLogs.inputTokens})`,
  outputTokens: sql<number>`SUM(${chatLogs.outputTokens})`,
  firstInputText: sql<string>`(SELECT substr(cl2."inputText", 1, 500) FROM chat_logs cl2 WHERE cl2.serverSessionId = chat_logs.serverSessionId ORDER BY cl2.createdAt ASC, cl2.turnId ASC LIMIT 1)`,
  sessionTitle: sql<string>`MAX(${chatLogs.sessionTitle})`,
  firstCreatedAt: sql<Date>`MIN(${chatLogs.createdAt})`,
  lastUpdatedAt: sql<Date>`MAX(${chatLogs.createdAt})`,
};

const formatSessionSummaries = (rows: any[]): SessionSummary[] => rows.map((s) => ({
  ...s,
  serverSessionId: s.serverSessionId || null,
  clientSessionId: s.clientSessionId || null,
  userId: s.userId || null,
  clientName: s.clientName || null,
  detectedClient: s.detectedClient || null,
  model: s.model || null,
  turnCount: Number(s.turnCount || 0),
  inputTokens: Number(s.inputTokens || 0),
  outputTokens: Number(s.outputTokens || 0),
  firstInputText: s.firstInputText || null,
  sessionTitle: s.sessionTitle || null,
  firstCreatedAt: toDate(s.firstCreatedAt).toISOString(),
  lastUpdatedAt: toDate(s.lastUpdatedAt).toISOString(),
  relatedSessionIds: s.serverSessionId ? [s.serverSessionId] : [],
}));

const foldingSelect = {
  id: chatLogs.id,
  requestId: chatLogs.requestId,
  serverSessionId: chatLogs.serverSessionId,
  clientSessionId: chatLogs.clientSessionId,
  turnId: chatLogs.turnId,
  userId: chatLogs.userId,
  clientName: chatLogs.clientName,
  detectedClient: chatLogs.detectedClient,
  model: chatLogs.model,
  inputText: sql<string>`substr(${chatLogs.inputText}, 1, 500)`,
  responseHash: chatLogs.responseHash,
  conversationRootHash: chatLogs.conversationRootHash,
  inputTokens: chatLogs.inputTokens,
  outputTokens: chatLogs.outputTokens,
  latencyMs: chatLogs.latencyMs,
  ttftMs: chatLogs.ttftMs,
  cachedTokens: chatLogs.cachedTokens,
  isAborted: chatLogs.isAborted,
  status: chatLogs.status,
  error: chatLogs.error,
  sessionTitle: chatLogs.sessionTitle,
  createdAt: chatLogs.createdAt,
};

const resolveRelatedSessionIds = async (sessionId: string) => {
  const anchorTurns = await db
    .select(foldingSelect)
    .from(chatLogs)
    .where(eq(chatLogs.serverSessionId, sessionId))
    .orderBy(asc(chatLogs.createdAt), asc(chatLogs.turnId));

  if (anchorTurns.length === 0) return [sessionId];

  const anchor = anchorTurns[0];
  const anchorSummary = buildSessionSummariesFromTurns(anchorTurns as any)[0];
  const windowStart = new Date(new Date(anchorSummary.firstCreatedAt).getTime() - SIMILAR_SESSION_WINDOW_MS);
  const windowEnd = new Date(new Date(anchorSummary.lastUpdatedAt).getTime() + SIMILAR_SESSION_WINDOW_MS);
  const candidateConditions = [
    eq(chatLogs.userId, anchor.userId),
    gte(chatLogs.createdAt, windowStart),
    lt(chatLogs.createdAt, windowEnd),
  ];

  if (anchor.clientName) candidateConditions.push(eq(chatLogs.clientName, anchor.clientName));
  if (anchor.model) candidateConditions.push(eq(chatLogs.model, anchor.model));
  if (anchor.clientSessionId) candidateConditions.push(eq(chatLogs.clientSessionId, anchor.clientSessionId));

  const candidateTurns = await db
    .select(foldingSelect)
    .from(chatLogs)
    .where(and(...candidateConditions))
    .orderBy(asc(chatLogs.createdAt), asc(chatLogs.turnId))
    .limit(CANDIDATE_SCAN_MAX_ROWS);

  const foldedSessions = foldSimilarSessions(buildSessionSummariesFromTurns(candidateTurns as any));
  const matched = foldedSessions.find((session) => session.relatedSessionIds.includes(sessionId));
  return matched?.relatedSessionIds?.length ? matched.relatedSessionIds : [sessionId];
};

export async function getSessions(request: FastifyRequest, reply: FastifyReply) {
  const {
    page = "1",
    limit = "50",
    startDate,
    endDate,
    timeRange,
    userId,
    model,
    clientName,
  } = request.query as any;

  const pageNum = parseInt(page);
  const limitNum = parseInt(limit);
  const offset = (pageNum - 1) * limitNum;

  const conditions = [];

  if (startDate) {
    conditions.push(gte(chatLogs.createdAt, new Date(startDate)));
  } else if (timeRange) {
    conditions.push(gte(chatLogs.createdAt, await getStartDateFromTimeRange(timeRange)));
  }
  if (endDate) {
    conditions.push(lt(chatLogs.createdAt, new Date(endDate)));
  }
  if (userId) {
    conditions.push(eq(chatLogs.userId, userId));
  }
  if (model) {
    conditions.push(like(chatLogs.model, `%${model}%`));
  }
  if (clientName) {
    conditions.push(like(chatLogs.clientName, `%${clientName}%`));
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const targetCount = offset + limitNum + 1;
  const scanBatchSize = Math.min(
    SESSION_SCAN_MAX_BATCH_ROWS,
    Math.max(SESSION_SCAN_MIN_ROWS, limitNum * SESSION_SCAN_OVERFETCH_FACTOR),
  );
  const maxRowsToScan = Math.min(
    SESSION_SCAN_MAX_ROWS,
    Math.max(scanBatchSize, targetCount * SESSION_SCAN_OVERFETCH_FACTOR * 2),
  );

  // Bounded recency scan by createdAt DESC (uses idx_chat_logs_createdat) instead of
  // full-table GROUP BY serverSessionId ORDER BY MAX(createdAt).
  const orderedSessionIds: string[] = [];
  const seen = new Set<string>();
  let rowsScanned = 0;
  let scanOffset = 0;

  while (orderedSessionIds.length < targetCount && rowsScanned < maxRowsToScan) {
    const batchLimit = Math.min(scanBatchSize, maxRowsToScan - rowsScanned);
    const batch = await db
      .select({
        serverSessionId: chatLogs.serverSessionId,
        createdAt: chatLogs.createdAt,
      })
      .from(chatLogs)
      .where(whereClause)
      .orderBy(desc(chatLogs.createdAt))
      .limit(batchLimit)
      .offset(scanOffset);

    if (batch.length === 0) break;

    rowsScanned += batch.length;
    scanOffset += batch.length;

    for (const row of batch) {
      const sid = row.serverSessionId;
      if (!sid || seen.has(sid)) continue;
      seen.add(sid);
      orderedSessionIds.push(sid);
      if (orderedSessionIds.length >= targetCount) break;
    }

    if (batch.length < batchLimit) break;
  }

  const pageSessionIds = orderedSessionIds.slice(offset, offset + limitNum);
  const hasMore = orderedSessionIds.length > offset + limitNum;

  let foldedSessions: SessionSummary[] = [];
  if (pageSessionIds.length > 0) {
    const sessionRows = await db
      .select(sessionSummarySelect)
      .from(chatLogs)
      .where(inArray(chatLogs.serverSessionId, pageSessionIds))
      .groupBy(chatLogs.serverSessionId);

    const byId = new Map(
      formatSessionSummaries(sessionRows).map((s) => [s.serverSessionId || "", s]),
    );
    // Preserve recency order from the bounded scan
    const ordered = pageSessionIds
      .map((id) => byId.get(id))
      .filter(Boolean) as SessionSummary[];
    foldedSessions = foldSimilarSessions(ordered);
  }

  const total = hasMore ? offset + foldedSessions.length + 1 : offset + foldedSessions.length;

  return {
    data: foldedSessions,
    pagination: {
      page: pageNum,
      limit: limitNum,
      total,
      totalPages: hasMore ? pageNum + 1 : Math.max(pageNum, Math.ceil(total / limitNum) || 1),
      hasMore,
      rowsScanned,
      scanCapped: rowsScanned >= maxRowsToScan && orderedSessionIds.length < targetCount,
    },
  };
}

export async function getRequests(request: FastifyRequest, reply: FastifyReply) {
  const {
    page = "1",
    limit = "50",
    startDate,
    endDate,
    timeRange,
    userId,
    model,
    clientName,
  } = request.query as any;

  const pageNum = parseInt(page);
  const limitNum = parseInt(limit);
  const offset = (pageNum - 1) * limitNum;

  const conditions = [];

  if (startDate) {
    conditions.push(gte(chatLogs.createdAt, new Date(startDate)));
  } else if (timeRange) {
    conditions.push(gte(chatLogs.createdAt, await getStartDateFromTimeRange(timeRange)));
  }
  if (endDate) {
    conditions.push(lt(chatLogs.createdAt, new Date(endDate)));
  }
  if (userId) {
    conditions.push(eq(chatLogs.userId, userId));
  }
  if (model) {
    conditions.push(like(chatLogs.model, `%${model}%`));
  }
  if (clientName) {
    conditions.push(like(chatLogs.clientName, `%${clientName}%`));
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const requestListSelect = {
    id: chatLogs.id,
    requestId: chatLogs.requestId,
    serverSessionId: chatLogs.serverSessionId,
    clientSessionId: chatLogs.clientSessionId,
    turnId: chatLogs.turnId,
    userId: chatLogs.userId,
    clientName: chatLogs.clientName,
    detectedClient: chatLogs.detectedClient,
    model: chatLogs.model,
    inputText: sql<string>`substr(${chatLogs.inputText}, 1, 500)`,
    outputText: sql<string>`substr(${chatLogs.outputText}, 1, 500)`,
    responseHash: chatLogs.responseHash,
    conversationRootHash: chatLogs.conversationRootHash,
    inputTokens: chatLogs.inputTokens,
    outputTokens: chatLogs.outputTokens,
    latencyMs: chatLogs.latencyMs,
    ttftMs: chatLogs.ttftMs,
    cachedTokens: chatLogs.cachedTokens,
    isAborted: chatLogs.isAborted,
    status: chatLogs.status,
    error: chatLogs.error,
    sessionTitle: chatLogs.sessionTitle,
    createdAt: chatLogs.createdAt,
  };

  const logs = await db
    .select(requestListSelect)
    .from(chatLogs)
    .where(whereClause)
    .orderBy(desc(chatLogs.createdAt))
    .limit(limitNum + 1)
    .offset(offset);

  const hasMore = logs.length > limitNum;
  const pageLogs = hasMore ? logs.slice(0, limitNum) : logs;
  const total = hasMore ? offset + pageLogs.length + 1 : offset + pageLogs.length;

  return {
    data: pageLogs,
    pagination: {
      page: pageNum,
      limit: limitNum,
      total,
      totalPages: hasMore ? pageNum + 1 : Math.max(pageNum, Math.ceil(total / limitNum) || 1),
      hasMore,
    },
  };
}

export async function getSessionTurns(request: FastifyRequest, reply: FastifyReply) {
  const { sessionId } = request.params as any;
  const relatedSessionIds = await resolveRelatedSessionIds(sessionId);
  const turns = await db
    .select()
    .from(chatLogs)
    .where(inArray(chatLogs.serverSessionId, relatedSessionIds))
    .orderBy(asc(chatLogs.createdAt), asc(chatLogs.turnId));

  return { data: turns };
}

export async function getUsers(request: FastifyRequest, reply: FastifyReply) {
  const rows = await db
    .select({ id: users.id, username: users.username })
    .from(users)
    .where(ne(users.status, "deleted"));

  return {
    data: rows.map((u) => ({
      id: u.id,
      username: u.username || u.id,
    })),
  };
}

export async function getModels(request: FastifyRequest, reply: FastifyReply) {
  const enabled = await db
    .select({ modelId: providerModels.modelId, alias: providerModels.alias })
    .from(providerModels)
    .where(and(eq(providerModels.enabled, true), eq(providerModels.active, true)));

  const names = new Set<string>();
  for (const row of enabled) {
    if (row.modelId) names.add(row.modelId);
    if (row.alias) names.add(row.alias);
  }

  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const recent = await db
    .select({ model: chatLogs.model })
    .from(chatLogs)
    .where(gte(chatLogs.createdAt, since))
    .orderBy(desc(chatLogs.createdAt))
    .limit(1000);

  for (const row of recent) {
    if (row.model) names.add(row.model);
  }

  return { data: Array.from(names).filter(Boolean).sort() };
}

export async function getStream(request: FastifyRequest, reply: FastifyReply) {
  const settings = await db
    .select()
    .from(systemSettings)
    .where(eq(systemSettings.key, "realtimeLogsEnabled"));
  const realtimeLogsEnabled = settings.length === 0 || settings[0].value !== "false";

  const stream = new PassThrough();

  reply.header("Content-Type", "text/event-stream");
  reply.header("Cache-Control", "no-cache, no-transform");
  reply.header("Connection", "keep-alive");
  reply.header("X-Accel-Buffering", "no");

  const writeEvent = (event: string | null, data: unknown) => {
    if (event) stream.write(`event: ${event}\n`);
    stream.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  let isClosed = false;

  if (!realtimeLogsEnabled) {
    writeEvent("disabled", { message: "实时日志已关闭" });
  } else {
    writeEvent("connected", { message: "Chat Log Stream Connected" });

    const onChatLogCreated = (payload: any) => {
      if (payload.noSummary) return;
      if (!isClosed) writeEvent("chatLog", payload);
    };

    const onChatSessionTitleUpdate = (payload: any) => {
      if (!isClosed) writeEvent("sessionTitleUpdate", payload);
    };

    const onChatSessionMerged = (payload: any) => {
      if (!isClosed) writeEvent("sessionMerged", payload);
    };

    logEmitter.on("chatLogCreated", onChatLogCreated);
    logEmitter.on("chatSessionTitleUpdate", onChatSessionTitleUpdate);
    logEmitter.on("chatSessionMerged", onChatSessionMerged);

    request.raw.on("close", () => {
      isClosed = true;
      logEmitter.off("chatLogCreated", onChatLogCreated);
      logEmitter.off("chatSessionTitleUpdate", onChatSessionTitleUpdate);
      logEmitter.off("chatSessionMerged", onChatSessionMerged);
    });
  }

  const interval = setInterval(() => {
    if (!isClosed) writeEvent("ping", {});
  }, 15000);

  request.raw.on("close", () => {
    isClosed = true;
    clearInterval(interval);
    stream.end();
  });

  return reply.send(stream);
}
