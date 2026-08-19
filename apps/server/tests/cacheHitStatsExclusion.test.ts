import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify from "fastify";
import crypto from "crypto";
import { eq } from "drizzle-orm";
import {
  isUsageStatEligible,
  liveUsageRequestDelta,
  LOCAL_RESPONSE_CACHE_HIT_STATUS,
} from "@promptgate/shared";
import { initTestDatabase, closeAndCleanup } from "./helpers/testDatabase";
import { normalizeChatLogTurn } from "../src/utils/chatTurns";
import * as actionLogger from "../src/utils/actionLogger";

const dbFile = "data/promptgate_test_cache_hit_stats.sqlite";

const BILLED_MODEL = "gpt-billed";
const CACHE_ONLY_MODEL = "gpt-cache-only";
const BILLED_USERNAME = "billed-stats-user";
const CACHE_ONLY_USERNAME = "cache-only-stats-user";

const BILLED_ROWS = [
  {
    suffix: "success",
    usageStatus: "success",
    inputTokens: 100,
    outputTokens: 50,
    statusCode: 200,
    latencyMs: 100,
    cost: 0.0123,
    model: BILLED_MODEL,
  },
  {
    suffix: "estimated",
    usageStatus: "estimated",
    inputTokens: 80,
    outputTokens: 20,
    statusCode: 200,
    latencyMs: 200,
    cost: 0.004,
    model: BILLED_MODEL,
  },
  {
    suffix: "failed",
    usageStatus: "failed",
    inputTokens: 10,
    outputTokens: 0,
    statusCode: 500,
    latencyMs: 50,
    cost: 0,
    model: BILLED_MODEL,
  },
  {
    suffix: "missing",
    usageStatus: "missing",
    inputTokens: 0,
    outputTokens: 0,
    statusCode: 200,
    latencyMs: 80,
    cost: 0,
    model: BILLED_MODEL,
  },
] as const;

const BILLED_REQUEST_COUNT = BILLED_ROWS.length;
const BILLED_INPUT_TOKENS = BILLED_ROWS.reduce((s, r) => s + r.inputTokens, 0);
const BILLED_OUTPUT_TOKENS = BILLED_ROWS.reduce((s, r) => s + r.outputTokens, 0);
const BILLED_TOKENS = BILLED_INPUT_TOKENS + BILLED_OUTPUT_TOKENS;
const BILLED_COST = BILLED_ROWS.reduce((s, r) => s + r.cost, 0);
const BILLED_SUCCESS_2XX = BILLED_ROWS.filter((r) => r.statusCode >= 200 && r.statusCode < 300).length;
const BILLED_AVG_LATENCY = Math.round(
  BILLED_ROWS.reduce((s, r) => s + r.latencyMs, 0) / BILLED_REQUEST_COUNT,
);

let db: any;
let client: any;
let users: any;
let requestLogs: any;
let chatLogs: any;
let responseCache: any;
let systemSettings: any;
let getStatisticsData: (start: Date, end: Date, excluded?: string[]) => Promise<any>;
let generateStatsReport: () => Promise<{ report: string; validTokenCount: number }>;
let getOverallStats: (start: Date, end?: Date) => Promise<any>;
let getUsageByUser: (start: Date, end?: Date) => Promise<any[]>;
let getTimeSeries: (start: Date, end?: Date) => Promise<any[]>;
let getDetailedAnalytics: (
  type: string,
  value: string,
  start: Date,
  end?: Date,
  timeRange?: string,
) => Promise<any>;
let getRadarMetrics: (
  type: string,
  value: string,
  start: Date,
  end?: Date,
) => Promise<any>;
let checkAndServeCachedResponse: (...args: any[]) => Promise<boolean>;

const windowStart = new Date(Date.now() - 60 * 60 * 1000);
const windowEnd = new Date(Date.now() + 60 * 60 * 1000);

let billedUserId = "";
let cacheOnlyUserId = "";
let persistRequestId = "";

function parseDingTalkTotalRequests(report: string): number {
  const match = report.match(/\*\*(?:总请求数|Total Requests)\*\*:\s*([\d,]+)/);
  expect(match, "DingTalk report must include a total-request line").toBeTruthy();
  return Number(match![1].replace(/,/g, ""));
}

function parseDingTalkRankingNames(report: string): string[] {
  const names: string[] = [];
  const rowRe = /^\| #\d+ \| ([^|]+) \|/gm;
  let match: RegExpExecArray | null;
  while ((match = rowRe.exec(report)) !== null) {
    names.push(match[1].trim());
  }
  return names;
}

function parseDingTalkCallsForName(report: string, name: string): number | null {
  const rowRe = new RegExp(
    `^\\| #\\d+ \\| ${name.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")} \\| ([\\d,]+) \\|`,
    "m",
  );
  const match = report.match(rowRe);
  if (!match) return null;
  return Number(match[1].replace(/,/g, ""));
}

async function waitFor<T>(fn: () => Promise<T | null | undefined>, timeoutMs = 4000): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error("timed out waiting for condition");
}

describe("local response-cache hits are excluded from usage statistics", () => {
  const fastify = Fastify();
  let savedDbFile: string | undefined;
  let authUser: { role: string; id: string } = { role: "admin", id: "admin" };
  const capturedActions: { code?: string }[] = [];
  let unsubscribe: (() => void) | undefined;

  beforeAll(async () => {
    savedDbFile = process.env.DB_FILE;
    ({ db, client } = await initTestDatabase({ dbFilePath: dbFile }));
    await import("../src/services/chatLogService");

    ({
      users,
      requestLogs,
      chatLogs,
      responseCache,
      systemSettings,
    } = await import("../src/db/schema"));
    ({ getStatisticsData } = await import("../src/services/statistics"));
    ({ generateStatsReport } = await import("../src/services/dingtalk"));
    ({
      getOverallStats,
      getUsageByUser,
      getTimeSeries,
      getRadarMetrics,
    } = await import("../src/services/analyticsQueryBuilder"));
    ({ getDetailedAnalytics } = await import("../src/services/analyticsService"));
    ({ checkAndServeCachedResponse } = await import("../src/routes/gateway/cache"));

    const dashboardRoutes = (await import("../src/routes/dashboard")).default;
    const usageRoutes = (await import("../src/routes/usage")).default;
    const logsRoutes = (await import("../src/routes/logs")).default;

    await fastify.register(require("@fastify/jwt"), { secret: "testsecret" });
    fastify.addHook("onRequest", async (request) => {
      request.jwtVerify = async () => {
        request.user = authUser;
      };
    });
    await fastify.register(dashboardRoutes);
    await fastify.register(usageRoutes);
    await fastify.register(logsRoutes);
    await fastify.ready();

    billedUserId = crypto.randomUUID();
    cacheOnlyUserId = crypto.randomUUID();
    const now = new Date();

    await db.insert(users).values([
      {
        id: billedUserId,
        username: BILLED_USERNAME,
        passwordHash: "hash",
        role: "user",
        status: "active",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: cacheOnlyUserId,
        username: CACHE_ONLY_USERNAME,
        passwordHash: "hash",
        role: "user",
        status: "active",
        createdAt: now,
        updatedAt: now,
      },
    ]);

    const logRows = BILLED_ROWS.map((row) => ({
      id: `billed-${row.suffix}`,
      requestId: `billed-${row.suffix}`,
      userId: billedUserId,
      model: row.model,
      statusCode: row.statusCode,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      totalTokens: row.inputTokens + row.outputTokens,
      latencyMs: row.latencyMs,
      usageStatus: row.usageStatus,
      cost: row.cost,
      createdAt: now,
    }));

    logRows.push({
      id: "billed-cached",
      requestId: "billed-cached",
      userId: billedUserId,
      model: BILLED_MODEL,
      statusCode: 200,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      latencyMs: 1,
      usageStatus: LOCAL_RESPONSE_CACHE_HIT_STATUS,
      cost: 0,
      createdAt: now,
    });
    logRows.push({
      id: "cache-only-cached",
      requestId: "cache-only-cached",
      userId: cacheOnlyUserId,
      model: CACHE_ONLY_MODEL,
      statusCode: 200,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      latencyMs: 1,
      usageStatus: LOCAL_RESPONSE_CACHE_HIT_STATUS,
      cost: 0,
      createdAt: now,
    });

    await db.insert(requestLogs).values(logRows);

    const cacheOnlyChatLogs = Array.from({ length: 5 }, (_, i) => ({
      id: `chat-cache-only-${i}`,
      requestId: i === 0 ? "cache-only-cached" : `cache-only-thrash-${i}`,
      serverSessionId: "sess-cache-only",
      turnId: i + 1,
      userId: cacheOnlyUserId,
      model: CACHE_ONLY_MODEL,
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: 1,
      status: LOCAL_RESPONSE_CACHE_HIT_STATUS,
      createdAt: now,
    }));

    await db.insert(chatLogs).values([
      {
        id: "chat-billed-success",
        requestId: "billed-success",
        serverSessionId: "sess-billed",
        turnId: 1,
        userId: billedUserId,
        model: BILLED_MODEL,
        inputTokens: 100,
        outputTokens: 50,
        latencyMs: 100,
        status: "success",
        createdAt: now,
      },
      {
        id: "chat-billed-cached",
        requestId: "billed-cached",
        serverSessionId: "sess-billed",
        turnId: 2,
        userId: billedUserId,
        model: BILLED_MODEL,
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: 1,
        status: LOCAL_RESPONSE_CACHE_HIT_STATUS,
        createdAt: now,
      },
      ...cacheOnlyChatLogs,
    ]);

    await db.delete(systemSettings).where(eq(systemSettings.key, "dingTalkLanguage"));
    await db.insert(systemSettings).values({
      key: "dingTalkLanguage",
      value: "zh",
      createdAt: now,
      updatedAt: now,
    });

    unsubscribe = actionLogger.subscribeActionLogs((entry: any) => {
      capturedActions.push({ code: entry.code || entry.params?.code });
    });
  });

  afterAll(async () => {
    if (unsubscribe) unsubscribe();
    await fastify.close();
    await closeAndCleanup(client, dbFile);
    if (savedDbFile !== undefined) {
      process.env.DB_FILE = savedDbFile;
    } else {
      delete process.env.DB_FILE;
    }
  });

  it("treats only local cache-hit status as usage-ineligible", () => {
    expect(isUsageStatEligible("cached")).toBe(false);
    expect(isUsageStatEligible(LOCAL_RESPONSE_CACHE_HIT_STATUS)).toBe(false);
    for (const status of ["success", "estimated", "missing", "failed", "queued", "processing", null, undefined]) {
      expect(isUsageStatEligible(status)).toBe(true);
    }
    expect(liveUsageRequestDelta({ usageStatus: "cached", isNewRequest: true })).toBe(0);
    expect(liveUsageRequestDelta({ usageStatus: "success", isNewRequest: true })).toBe(1);
    expect(liveUsageRequestDelta({ usageStatus: "success", isNewRequest: false })).toBe(0);
    expect(liveUsageRequestDelta({ usageStatus: "failed", isNewRequest: true })).toBe(1);
  });

  it("getStatisticsData ignores cached rows and cache-only users", async () => {
    const stats = await getStatisticsData(windowStart, windowEnd);
    expect(Number(stats.systemSummary.totalRequests)).toBe(BILLED_REQUEST_COUNT);
    expect(Number(stats.systemSummary.totalTokens)).toBe(BILLED_TOKENS);
    expect(Number(stats.systemSummary.totalInputTokens)).toBe(BILLED_INPUT_TOKENS);
    expect(Number(stats.systemSummary.totalOutputTokens)).toBe(BILLED_OUTPUT_TOKENS);
    expect(Number(stats.systemSummary.totalCost)).toBeCloseTo(BILLED_COST, 6);
    expect(Number(stats.systemSummary.validTokenCount)).toBe(BILLED_TOKENS);

    const billed = stats.userRanking.find((u: any) => u.userId === billedUserId);
    expect(billed).toBeTruthy();
    expect(Number(billed.totalRequests)).toBe(BILLED_REQUEST_COUNT);
    expect(Number(billed.totalTokens)).toBe(BILLED_TOKENS);

    expect(stats.userRanking.some((u: any) => u.userId === cacheOnlyUserId)).toBe(false);
    expect(stats.userRanking.some((u: any) => u.username === CACHE_ONLY_USERNAME)).toBe(false);

    const billedModel = stats.modelRanking.find((m: any) => m.modelId === BILLED_MODEL);
    expect(billedModel).toBeTruthy();
    expect(Number(billedModel.totalRequests)).toBe(BILLED_REQUEST_COUNT);

    expect(stats.modelRanking.some((m: any) => m.modelId === CACHE_ONLY_MODEL)).toBe(false);
  });

  it("generateStatsReport totals match billed-only aggregators", async () => {
    const stats = await getStatisticsData(windowStart, windowEnd);
    const { report, validTokenCount } = await generateStatsReport();

    const reportTotal = parseDingTalkTotalRequests(report);
    expect(reportTotal).toBe(Number(stats.systemSummary.totalRequests));
    expect(reportTotal).toBe(BILLED_REQUEST_COUNT);
    expect(validTokenCount).toBe(Number(stats.systemSummary.validTokenCount));
    expect(validTokenCount).toBe(BILLED_TOKENS);

    const names = parseDingTalkRankingNames(report);
    expect(names).toContain(BILLED_USERNAME);
    expect(names).not.toContain(CACHE_ONLY_USERNAME);
    expect(report).not.toContain(CACHE_ONLY_USERNAME);
    expect(report).not.toContain(CACHE_ONLY_MODEL);

    const billedCalls = parseDingTalkCallsForName(report, BILLED_USERNAME);
    expect(billedCalls).toBe(BILLED_REQUEST_COUNT);
  });

  it("overall analytics, time-series, and radar exclude cached rows", async () => {
    const overall = await getOverallStats(windowStart, windowEnd);
    expect(Number(overall.totalRequests)).toBe(BILLED_REQUEST_COUNT);
    expect(Number(overall.totalTokens)).toBe(BILLED_TOKENS);
    expect(Number(overall.avgLatencyMs)).toBe(BILLED_AVG_LATENCY);
    const expectedSuccessRate =
      Math.round((BILLED_SUCCESS_2XX / BILLED_REQUEST_COUNT) * 10000) / 100;
    expect(Number(overall.successRate)).toBe(expectedSuccessRate);

    const byUser = await getUsageByUser(windowStart, windowEnd);
    expect(byUser.some((u: any) => u.userId === cacheOnlyUserId)).toBe(false);
    const billed = byUser.find((u: any) => u.userId === billedUserId);
    expect(billed).toBeTruthy();
    expect(Number(billed.totalRequests)).toBe(BILLED_REQUEST_COUNT);

    const series = await getTimeSeries(windowStart, windowEnd);
    const seriesRequests = series.reduce((s: number, row: any) => s + Number(row.requests || 0), 0);
    expect(seriesRequests).toBe(BILLED_REQUEST_COUNT);

    const detail = await getDetailedAnalytics(
      "user",
      billedUserId,
      windowStart,
      windowEnd,
      "day",
    );
    const detailRequests = detail.data.reduce(
      (s: number, bucket: any) => s + Number(bucket.requests || 0),
      0,
    );
    expect(detailRequests).toBe(BILLED_REQUEST_COUNT);

    const cacheOnlyDetail = await getDetailedAnalytics(
      "user",
      cacheOnlyUserId,
      windowStart,
      windowEnd,
      "day",
    );
    const cacheOnlyRequests = cacheOnlyDetail.data.reduce(
      (s: number, bucket: any) => s + Number(bucket.requests || 0),
      0,
    );
    expect(cacheOnlyRequests).toBe(0);

    const emptyRadar = await getRadarMetrics("user", "missing-user-id", windowStart, windowEnd);
    const cacheOnlyRadar = await getRadarMetrics("user", cacheOnlyUserId, windowStart, windowEnd);
    expect(cacheOnlyRadar).toEqual(emptyRadar);
  });

  it("admin dashboard and /api/me/usage totals exclude cached rows but listings still show them", async () => {
    const adminRows = await db.select().from(users);
    const admin = adminRows.find((u: any) => u.role === "admin");
    expect(admin).toBeTruthy();

    authUser = { role: "admin", id: admin.id };
    const qs = `startDate=${encodeURIComponent(windowStart.toISOString())}&endDate=${encodeURIComponent(windowEnd.toISOString())}`;

    const dashStats = await fastify.inject({
      method: "GET",
      url: `/api/admin/dashboard/stats?${qs}`,
    });
    expect(dashStats.statusCode).toBe(200);
    const dashBody = dashStats.json();
    expect(Number(dashBody.todayRequests)).toBe(BILLED_REQUEST_COUNT);
    expect(Number(dashBody.avgLatencyMs)).toBe(BILLED_AVG_LATENCY);

    const dashSeries = await fastify.inject({
      method: "GET",
      url: `/api/admin/dashboard/logs-over-time?${qs}`,
    });
    expect(dashSeries.statusCode).toBe(200);
    const seriesBody = dashSeries.json();
    const seriesCount = seriesBody.reduce((s: number, row: any) => s + Number(row.count || 0), 0);
    expect(seriesCount).toBe(BILLED_REQUEST_COUNT);

    const logsStats = await fastify.inject({
      method: "GET",
      url: `/api/admin/logs/stats?${qs}`,
    });
    expect(logsStats.statusCode).toBe(200);
    expect(Number(logsStats.json().total)).toBe(BILLED_REQUEST_COUNT);

    const recent = await fastify.inject({
      method: "GET",
      url: "/api/admin/dashboard/recent-logs?limit=50",
    });
    expect(recent.statusCode).toBe(200);
    const recentIds = recent.json().map((row: any) => row.id);
    expect(recentIds).toContain("billed-cached");
    expect(recentIds).toContain("cache-only-cached");

    authUser = { role: "user", id: billedUserId };
    const meUsage = await fastify.inject({
      method: "GET",
      url: `/api/me/usage?${qs}`,
    });
    expect(meUsage.statusCode).toBe(200);
    const meBody = meUsage.json();
    expect(Number(meBody.totalRequests)).toBe(BILLED_REQUEST_COUNT);
    expect(Number(meBody.totalTokens)).toBe(BILLED_TOKENS);
    const meLogIds = (meBody.recentLogs || []).map((row: any) => row.id);
    expect(meLogIds).toContain("billed-cached");

    const meDash = await fastify.inject({
      method: "GET",
      url: `/api/me/usage/dashboard?${qs}`,
    });
    expect(meDash.statusCode).toBe(200);
    const meDashBody = meDash.json();
    expect(Number(meDashBody.avgLatencyMs)).toBe(BILLED_AVG_LATENCY);
    const modelReqs = (meDashBody.modelBreakdown || []).reduce(
      (s: number, row: any) => s + Number(row.totalRequests || 0),
      0,
    );
    expect(modelReqs).toBe(BILLED_REQUEST_COUNT);
    const recentReqIds = (meDashBody.recentRequests || []).map((row: any) => row.id);
    expect(recentReqIds).toContain("billed-cached");
  });

  it("cache-hit persist/serve still writes audit artifacts and does not change stats", async () => {
    const before = await getStatisticsData(windowStart, windowEnd);
    const beforeOverall = await getOverallStats(windowStart, windowEnd);

    const body = {
      model: BILLED_MODEL,
      messages: [{ role: "user", content: "cache-hit persist fixture" }],
      stream: false,
    };
    const normalized = normalizeChatLogTurn(JSON.stringify(body), null);
    expect(normalized.inputText).toBeTruthy();
    const inputHash = crypto.createHash("md5").update(normalized.inputText as string).digest("hex");
    const cacheId = crypto.randomUUID();
    persistRequestId = crypto.randomUUID();
    const now = new Date();

    await db.insert(responseCache).values({
      id: cacheId,
      inputHash,
      inputText: normalized.inputText,
      responseText: "cached-body-ok",
      model: BILLED_MODEL,
      hitCount: 3,
      createdAt: now,
      updatedAt: now,
    });

    capturedActions.length = 0;

    const payload: { status?: number; body?: any } = {};
    const reply: any = {
      code(status: number) {
        payload.status = status;
        return this;
      },
      send(bodyOut: any) {
        payload.body = bodyOut;
        return this;
      },
      raw: {
        write() {},
        end() {},
      },
    };
    const request: any = {
      headers: {},
      log: { warn() {} },
    };

    const served = await checkAndServeCachedResponse(
      request,
      reply,
      body,
      {
        providedKey: "pg_test_key",
        apiKeyRecord: {
          id: "key-cache-hit",
          userId: billedUserId,
          name: "Cache Key",
          keyPrefix: "pg_test",
          concurrencyLimit: 2,
        },
        userId: billedUserId,
        isSystemKey: false,
      },
      {
        incomingProtocol: "openai",
        reqPath: "/v1/chat/completions",
        endpoint: { id: "ep-cache" },
        route: { id: "rt-cache", endpointId: "ep-cache" },
        subdomainRecord: null,
      },
      {
        providerId: "prov-cache",
        providerProtocol: "openai",
        modelId: BILLED_MODEL,
        promptPolicyId: null,
        isFallback: false,
        fallbackReason: "",
        targetIndex: 0,
      },
      {
        requestId: persistRequestId,
        userId: billedUserId,
        apiKeyPrefix: "pg_test",
        host: "localhost",
        path: "/v1/chat/completions",
        routeName: "cache-test",
      },
      Date.now() - 5,
      null,
    );

    expect(served).toBe(true);
    expect(payload.status).toBe(200);
    expect(payload.body?.choices?.[0]?.message?.content).toBe("cached-body-ok");

    const cacheRows = await db.select().from(responseCache).where(eq(responseCache.id, cacheId));
    expect(cacheRows[0].hitCount).toBe(4);

    const persisted = await db.select().from(requestLogs).where(eq(requestLogs.id, persistRequestId));
    expect(persisted.length).toBe(1);
    expect(persisted[0].usageStatus).toBe(LOCAL_RESPONSE_CACHE_HIT_STATUS);
    expect(persisted[0].statusCode).toBe(200);

    expect(capturedActions.some((a) => a.code === "request.cache_hit")).toBe(true);

    const chatRow = await waitFor(async () => {
      const rows = await db.select().from(chatLogs).where(eq(chatLogs.requestId, persistRequestId));
      return rows[0] || null;
    });
    expect(chatRow.status).toBe(LOCAL_RESPONSE_CACHE_HIT_STATUS);

    const after = await getStatisticsData(windowStart, windowEnd);
    const afterOverall = await getOverallStats(windowStart, windowEnd);
    expect(Number(after.systemSummary.totalRequests)).toBe(Number(before.systemSummary.totalRequests));
    expect(Number(after.systemSummary.totalRequests)).toBe(BILLED_REQUEST_COUNT);
    expect(Number(afterOverall.totalRequests)).toBe(Number(beforeOverall.totalRequests));
  });

  it("usage-stat aggregators inherit the shared eligibility helper", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const root = path.resolve(
      process.cwd().endsWith("server") ? process.cwd() : path.join(process.cwd(), "apps/server"),
    );
    const files = [
      "src/services/statistics.ts",
      "src/services/analyticsQueryBuilder.ts",
      "src/services/analyticsService.ts",
      "src/routes/dashboard.ts",
      "src/routes/usage.ts",
      "src/routes/users.ts",
      "src/routes/logs.ts",
    ];
    for (const rel of files) {
      const src = fs.readFileSync(path.join(root, rel), "utf8");
      expect(
        src.includes("usageStatEligibleSql") || src.includes("requestLogUsageWindow") || src.includes("withUsageStatEligibility"),
        `${rel} must apply the shared usage-stat eligibility rule`,
      ).toBe(true);
    }

    const webRoot = path.resolve(root, "../web/src/pages");
    for (const rel of ["MyStats.tsx", "Dashboard.tsx"]) {
      const src = fs.readFileSync(path.join(webRoot, rel), "utf8");
      expect(src.includes("isUsageStatEligible"), `${rel} must skip cache hits on live usage counters`).toBe(true);
      expect(src.includes("liveUsageRequestDelta"), `${rel} must use the shared live request-count rule`).toBe(true);
    }

    const cacheSrc = fs.readFileSync(path.join(root, "src/routes/gateway/cache.ts"), "utf8");
    expect(cacheSrc).toContain('usageStatus: "cached"');
    expect(cacheSrc).toContain("insertRequestLog");
    expect(cacheSrc).toContain("hitCount");
    expect(cacheSrc).toContain("request.cache_hit");
    expect(cacheSrc).toContain('status: "cached"');
  });
});
