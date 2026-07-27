import { db } from "../db";
import { requestLogs, providerModels, systemSettings } from "../db/schema";
import { eq, and, sql, gte, lt, isNull, inArray } from "drizzle-orm";
import { summedRequestCostSql } from "../utils/requestCostSql";
import { publicModelSql } from "../utils/modelAlias";

export * from "./analyticsFormatter";
export * from "./analyticsQueryBuilder";
import { getRadarMetrics } from "./analyticsQueryBuilder";

export async function getDetailedAnalytics(type: string, value: string, startDate: Date, endDate?: Date, timeRange: string = "30") {
  const settings = await db
    .select()
    .from(systemSettings)
    .where(inArray(systemSettings.key, ["analyticsStartOfDay", "analyticsStartOfWeek"]));
  let startOfDayStr = "00:00";
  let startOfWeekStr = "1";
  for (const s of settings) {
    if (s.key === "analyticsStartOfDay") startOfDayStr = s.value;
    if (s.key === "analyticsStartOfWeek") startOfWeekStr = s.value;
  }
  const startHour = parseInt(startOfDayStr.split(":")[0] || "0", 10);
  const startMinute = parseInt(startOfDayStr.split(":")[1] || "0", 10);
  const startOfWeek = parseInt(startOfWeekStr, 10); // 0 = Sunday, 1 = Monday
  const conditions = [gte(requestLogs.createdAt, startDate)];
  if (endDate) {
    conditions.push(lt(requestLogs.createdAt, endDate));
  }

  // Add dimension filter
  if (type === "user") {
    conditions.push(eq(requestLogs.userId, value));
  } else if (type === "provider") {
    if (!value || value === "null") {
      conditions.push(isNull(requestLogs.providerId));
    } else {
      conditions.push(eq(requestLogs.providerId, value));
    }
  } else if (type === "model") {
    if (!value || value === "null") {
      conditions.push(sql`${publicModelSql()} IS NULL`);
    } else {
      conditions.push(sql`${publicModelSql()} = ${value}`);
    }
  } else if (type === "endpoint") {
    if (!value || value === "null") {
      conditions.push(isNull(requestLogs.endpointId));
    } else {
      conditions.push(eq(requestLogs.endpointId, value));
    }
  } else if (type === "subdomain") {
    if (!value || value === "null") {
      conditions.push(isNull(requestLogs.subdomainId));
    } else {
      conditions.push(eq(requestLogs.subdomainId, value));
    }
  } else if (type === "apiKey") {
    if (!value || value === "null") {
      conditions.push(isNull(requestLogs.apiKeyId));
    } else {
      conditions.push(eq(requestLogs.apiKeyId, value));
    }
  } else {
    throw new Error(`Invalid type: ${type}`);
  }

  const now = new Date();
  const actualEnd = endDate || now;

  // Grouping and buckets generation
  let buckets: any[] = [];
  let dbBuckets: any[] = [];

  const startSecs = Math.floor(startDate.getTime() / 1000);
  const diffMs = actualEnd.getTime() - startDate.getTime();

  if (timeRange === "day") {
    // Hourly buckets: 24 hours
    const bucketSize = 3600000;
    for (let i = 0; i < 24; i++) {
      const d = new Date(startDate.getTime() + i * bucketSize);
      const hourStr = d.getHours().toString().padStart(2, "0");
      const minuteStr = d.getMinutes().toString().padStart(2, "0");
      buckets.push({
        label: `${hourStr}:${minuteStr}`,
        key: i,
        requests: 0,
        tokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        cost: 0,
        successCount: 0,
        avgLatencyMs: 0,
      });
    }

    dbBuckets = await db
      .select({
        key: sql<number>`CAST((${requestLogs.createdAt} - ${startSecs}) / 3600 AS INTEGER)`,
        requests: sql<number>`COUNT(*)`,
        tokens: sql<number>`COALESCE(SUM(${requestLogs.inputTokens} + ${requestLogs.outputTokens}), 0)`,
        inputTokens: sql<number>`COALESCE(SUM(${requestLogs.inputTokens}), 0)`,
        outputTokens: sql<number>`COALESCE(SUM(${requestLogs.outputTokens}), 0)`,
        cost: summedRequestCostSql,
        successCount: sql<number>`SUM(CASE WHEN ${requestLogs.statusCode} >= 200 AND ${requestLogs.statusCode} < 300 THEN 1 ELSE 0 END)`,
        avgLatencyMs: sql<number>`AVG(${requestLogs.latencyMs})`,
      })
      .from(requestLogs)
      .leftJoin(
        providerModels,
        and(
          eq(requestLogs.providerId, providerModels.providerId),
          eq(requestLogs.model, providerModels.modelId)
        )
      )
      .where(and(...conditions))
      .groupBy(sql`CAST((${requestLogs.createdAt} - ${startSecs}) / 3600 AS INTEGER)`);

  } else if (timeRange === "week") {
    // Daily buckets for a week: 7 days
    const bucketSize = 86400000;
    for (let i = 0; i < 7; i++) {
      const d = new Date(startDate.getTime() + i * bucketSize);
      const monthStr = (d.getMonth() + 1).toString().padStart(2, "0");
      const dayStr = d.getDate().toString().padStart(2, "0");
      buckets.push({
        label: `${monthStr}-${dayStr}`,
        key: i,
        requests: 0,
        tokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        cost: 0,
        successCount: 0,
        avgLatencyMs: 0,
      });
    }

    dbBuckets = await db
      .select({
        key: sql<number>`CAST((${requestLogs.createdAt} - ${startSecs}) / 86400 AS INTEGER)`,
        requests: sql<number>`COUNT(*)`,
        tokens: sql<number>`COALESCE(SUM(${requestLogs.inputTokens} + ${requestLogs.outputTokens}), 0)`,
        inputTokens: sql<number>`COALESCE(SUM(${requestLogs.inputTokens}), 0)`,
        outputTokens: sql<number>`COALESCE(SUM(${requestLogs.outputTokens}), 0)`,
        cost: summedRequestCostSql,
        successCount: sql<number>`SUM(CASE WHEN ${requestLogs.statusCode} >= 200 AND ${requestLogs.statusCode} < 300 THEN 1 ELSE 0 END)`,
        avgLatencyMs: sql<number>`AVG(${requestLogs.latencyMs})`,
      })
      .from(requestLogs)
      .leftJoin(
        providerModels,
        and(
          eq(requestLogs.providerId, providerModels.providerId),
          eq(requestLogs.model, providerModels.modelId)
        )
      )
      .where(and(...conditions))
      .groupBy(sql`CAST((${requestLogs.createdAt} - ${startSecs}) / 86400 AS INTEGER)`);

  } else if (timeRange === "month") {
    // Query daily aggregates from db
    const dbDaily = await db
      .select({
        key: sql<number>`CAST((${requestLogs.createdAt} - ${startSecs}) / 86400 AS INTEGER)`,
        requests: sql<number>`COUNT(*)`,
        tokens: sql<number>`COALESCE(SUM(${requestLogs.inputTokens} + ${requestLogs.outputTokens}), 0)`,
        inputTokens: sql<number>`COALESCE(SUM(${requestLogs.inputTokens}), 0)`,
        outputTokens: sql<number>`COALESCE(SUM(${requestLogs.outputTokens}), 0)`,
        cost: summedRequestCostSql,
        successCount: sql<number>`SUM(CASE WHEN ${requestLogs.statusCode} >= 200 AND ${requestLogs.statusCode} < 300 THEN 1 ELSE 0 END)`,
        totalLatencyMs: sql<number>`COALESCE(SUM(${requestLogs.latencyMs}), 0)`,
      })
      .from(requestLogs)
      .leftJoin(
        providerModels,
        and(
          eq(requestLogs.providerId, providerModels.providerId),
          eq(requestLogs.model, providerModels.modelId)
        )
      )
      .where(and(...conditions))
      .groupBy(sql`CAST((${requestLogs.createdAt} - ${startSecs}) / 86400 AS INTEGER)`);

    // Dynamically build calendar-week bounds
    const nextMonthStart = new Date(startDate.getFullYear(), startDate.getMonth() + 1, 1, startDate.getHours(), startDate.getMinutes());
    const endMs = nextMonthStart.getTime();

    const weeks: { wStart: Date; wEnd: Date }[] = [];
    let currentDay = new Date(startDate.getTime());
    let currentWeekStart = new Date(currentDay.getTime());

    while (currentDay.getTime() < endMs) {
      const tomorrow = new Date(currentDay.getTime() + 86400000);
      const isNewWeekStart = tomorrow.getTime() < endMs && tomorrow.getDay() === startOfWeek;

      if (isNewWeekStart) {
        const currentWeekEnd = new Date(tomorrow.getTime() - 1);
        weeks.push({ wStart: currentWeekStart, wEnd: currentWeekEnd });
        currentWeekStart = new Date(tomorrow.getTime());
      }
      currentDay = tomorrow;
    }
    const lastWeekEnd = new Date(endMs - 1);
    weeks.push({ wStart: currentWeekStart, wEnd: lastWeekEnd });

    // Build buckets in buckets list
    const formatMD = (dt: Date) => {
      const adjusted = new Date(dt.getTime() - (startHour * 3600000 + startMinute * 60000));
      const monthStr = (adjusted.getMonth() + 1).toString().padStart(2, "0");
      const dayStr = adjusted.getDate().toString().padStart(2, "0");
      return `${monthStr}-${dayStr}`;
    };
    const tempBuckets = weeks.map((wk, index) => ({
      label: `${formatMD(wk.wStart)} ~ ${formatMD(wk.wEnd)}`,
      key: index,
      wStart: wk.wStart,
      wEnd: wk.wEnd,
      requests: 0,
      tokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
      successCount: 0,
      totalLatencyMs: 0,
      avgLatencyMs: 0,
    }));

    // Merge daily db results into weekly buckets
    dbDaily.forEach((dbB: any) => {
      const logDayStart = new Date(startDate.getTime() + dbB.key * 86400000);
      const b = tempBuckets.find(wk => logDayStart.getTime() >= wk.wStart.getTime() && logDayStart.getTime() <= wk.wEnd.getTime());
      if (b) {
        b.requests += Number(dbB.requests) || 0;
        b.tokens += Number(dbB.tokens) || 0;
        b.inputTokens += Number(dbB.inputTokens) || 0;
        b.outputTokens += Number(dbB.outputTokens) || 0;
        b.cost += Number(dbB.cost) || 0;
        b.successCount += Number(dbB.successCount) || 0;
        b.totalLatencyMs += Number(dbB.totalLatencyMs) || 0;
      }
    });

    // Compute average latency and set final buckets
    tempBuckets.forEach(b => {
      b.avgLatencyMs = b.requests > 0 ? Math.round(b.totalLatencyMs / b.requests) : 0;
    });

    buckets = tempBuckets;
    dbBuckets = []; // Clear dbBuckets so default merge block is skipped

  } else if (timeRange === "year") {
    // Monthly buckets: this year by month
    let current = new Date(startDate.getTime());
    for (let m = 0; m < 12; m++) {
      const year = current.getFullYear();
      const month = (current.getMonth() + 1).toString().padStart(2, "0");
      const key = `${year}-${month}`;
      buckets.push({
        label: `${year}-${month}`,
        key: key,
        requests: 0,
        tokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        cost: 0,
        successCount: 0,
        avgLatencyMs: 0,
      });
      current.setMonth(current.getMonth() + 1);
    }

    dbBuckets = await db
      .select({
        key: sql<string>`strftime('%Y-%m', datetime(${requestLogs.createdAt}, 'unixepoch', 'localtime'))`,
        requests: sql<number>`COUNT(*)`,
        tokens: sql<number>`COALESCE(SUM(${requestLogs.inputTokens} + ${requestLogs.outputTokens}), 0)`,
        inputTokens: sql<number>`COALESCE(SUM(${requestLogs.inputTokens}), 0)`,
        outputTokens: sql<number>`COALESCE(SUM(${requestLogs.outputTokens}), 0)`,
        cost: summedRequestCostSql,
        successCount: sql<number>`SUM(CASE WHEN ${requestLogs.statusCode} >= 200 AND ${requestLogs.statusCode} < 300 THEN 1 ELSE 0 END)`,
        avgLatencyMs: sql<number>`AVG(${requestLogs.latencyMs})`,
      })
      .from(requestLogs)
      .leftJoin(
        providerModels,
        and(
          eq(requestLogs.providerId, providerModels.providerId),
          eq(requestLogs.model, providerModels.modelId)
        )
      )
      .where(and(...conditions))
      .groupBy(sql`strftime('%Y-%m', datetime(${requestLogs.createdAt}, 'unixepoch', 'localtime'))`);

  } else {
    // Custom or other range: <= 25 hours -> hourly; > 25 hours -> daily
    const isHourly = diffMs <= 90000000;

    if (isHourly) {
      const bucketSize = 3600000;
      const numHours = Math.max(1, Math.ceil(diffMs / bucketSize));
      for (let i = 0; i < numHours; i++) {
        const d = new Date(startDate.getTime() + i * bucketSize);
        const hourStr = d.getHours().toString().padStart(2, "0");
        const minuteStr = d.getMinutes().toString().padStart(2, "0");
        buckets.push({
          label: `${hourStr}:${minuteStr}`,
          key: i,
          requests: 0,
          tokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          cost: 0,
          successCount: 0,
          avgLatencyMs: 0,
        });
      }

      dbBuckets = await db
        .select({
          key: sql<number>`CAST((${requestLogs.createdAt} - ${startSecs}) / 3600 AS INTEGER)`,
          requests: sql<number>`COUNT(*)`,
          tokens: sql<number>`COALESCE(SUM(${requestLogs.inputTokens} + ${requestLogs.outputTokens}), 0)`,
          inputTokens: sql<number>`COALESCE(SUM(${requestLogs.inputTokens}), 0)`,
          outputTokens: sql<number>`COALESCE(SUM(${requestLogs.outputTokens}), 0)`,
          cost: summedRequestCostSql,
          successCount: sql<number>`SUM(CASE WHEN ${requestLogs.statusCode} >= 200 AND ${requestLogs.statusCode} < 300 THEN 1 ELSE 0 END)`,
          avgLatencyMs: sql<number>`AVG(${requestLogs.latencyMs})`,
        })
        .from(requestLogs)
        .leftJoin(
          providerModels,
          and(
            eq(requestLogs.providerId, providerModels.providerId),
            eq(requestLogs.model, providerModels.modelId)
          )
        )
        .where(and(...conditions))
        .groupBy(sql`CAST((${requestLogs.createdAt} - ${startSecs}) / 3600 AS INTEGER)`);

    } else {
      const bucketSize = 86400000;
      let numDays = Math.max(1, Math.ceil(diffMs / bucketSize));
      if (numDays > 120) {
        numDays = 120;
      }

      for (let i = 0; i < numDays; i++) {
        const d = new Date(startDate.getTime() + i * bucketSize);
        const monthStr = (d.getMonth() + 1).toString().padStart(2, "0");
        const dayStr = d.getDate().toString().padStart(2, "0");
        buckets.push({
          label: `${monthStr}-${dayStr}`,
          key: i,
          requests: 0,
          tokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          cost: 0,
          successCount: 0,
          avgLatencyMs: 0,
        });
      }

      dbBuckets = await db
        .select({
          key: sql<number>`CAST((${requestLogs.createdAt} - ${startSecs}) / 86400 AS INTEGER)`,
          requests: sql<number>`COUNT(*)`,
          tokens: sql<number>`COALESCE(SUM(${requestLogs.inputTokens} + ${requestLogs.outputTokens}), 0)`,
          inputTokens: sql<number>`COALESCE(SUM(${requestLogs.inputTokens}), 0)`,
          outputTokens: sql<number>`COALESCE(SUM(${requestLogs.outputTokens}), 0)`,
          cost: summedRequestCostSql,
          successCount: sql<number>`SUM(CASE WHEN ${requestLogs.statusCode} >= 200 AND ${requestLogs.statusCode} < 300 THEN 1 ELSE 0 END)`,
          avgLatencyMs: sql<number>`AVG(${requestLogs.latencyMs})`,
        })
        .from(requestLogs)
        .leftJoin(
          providerModels,
          and(
            eq(requestLogs.providerId, providerModels.providerId),
            eq(requestLogs.model, providerModels.modelId)
          )
        )
        .where(and(...conditions))
        .groupBy(sql`CAST((${requestLogs.createdAt} - ${startSecs}) / 86400 AS INTEGER)`);
    }
  }

  // Merge database results into generated buckets
  dbBuckets.forEach((dbB: any) => {
    const b = buckets.find((x) => x.key === dbB.key);
    if (b) {
      b.requests = Number(dbB.requests) || 0;
      b.tokens = Number(dbB.tokens) || 0;
      b.inputTokens = Number(dbB.inputTokens) || 0;
      b.outputTokens = Number(dbB.outputTokens) || 0;
      b.cost = Number(dbB.cost) || 0;
      b.successCount = Number(dbB.successCount) || 0;
      b.avgLatencyMs = Math.round(Number(dbB.avgLatencyMs) || 0);
    }
  });

  // Construct final formatted response
  const responseList = buckets.map((b) => ({
    label: b.label,
    requests: b.requests,
    tokens: b.tokens,
    inputTokens: b.inputTokens,
    outputTokens: b.outputTokens,
    cost: b.cost,
    avgLatencyMs: b.avgLatencyMs,
    successRate: b.requests > 0 ? Math.round((b.successCount / b.requests) * 10000) / 100 : 100,
  }));

  const formatTime = (d: Date) => {
    const Y = d.getFullYear();
    const M = (d.getMonth() + 1).toString().padStart(2, "0");
    const D = d.getDate().toString().padStart(2, "0");
    const h = d.getHours().toString().padStart(2, "0");
    const m = d.getMinutes().toString().padStart(2, "0");
    return `${Y}-${M}-${D} ${h}:${m}`;
  };

  const radarMetrics = await getRadarMetrics(type, value, startDate, actualEnd);

  return {
    startDate: formatTime(startDate),
    endDate: formatTime(actualEnd),
    data: responseList,
    radarMetrics,
  };
}
