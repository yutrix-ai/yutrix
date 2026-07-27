import { db } from "../db";
import { systemSettings } from "../db/schema";
import { eq } from "drizzle-orm";

export interface RouteScheduleItem {
  id: string;
  name: string;
  daysOfWeek: number[]; // 0 for Sunday, 1-6 for Monday-Saturday
  startTime: string; // "HH:MM"
  endTime: string; // "HH:MM"
  endNextDay: boolean;
  useDailyStartAsEnd: boolean;

  providerId: string;
  providerProtocol: string;
  modelId: string;
  allowClientModel: boolean;
  promptPolicyId?: string | null;
  targets?: any;
  fallbackEnabled: boolean;
  fallbackProviderId?: string | null;
  fallbackProviderProtocol?: string | null;
  fallbackModelId?: string | null;
  fallbackPromptPolicyId?: string | null;
  fallbackMatchTarget: boolean;
}

export interface RouteProperties {
  providerId: string;
  providerProtocol: string;
  modelId: string;
  promptPolicyId: string | null;
  allowClientModel: boolean;
  targets?: any;
  fallbackEnabled: boolean;
  fallbackProviderId: string | null;
  fallbackProviderProtocol: string | null;
  fallbackModelId: string | null;
  fallbackPromptPolicyId: string | null;
  fallbackMatchTarget: boolean;
  strategyRoutingEnabled?: boolean;
}

/**
 * Safely parses the schedules JSON string. Returns an empty array if empty, null, or invalid JSON.
 */
export function safeParseSchedules(schedulesStr: string | null | undefined): RouteScheduleItem[] {
  if (!schedulesStr) return [];
  try {
    const parsed = JSON.parse(schedulesStr);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Finds the first active schedule from a list of schedules given a specific time.
 * @param schedules List of schedules to check
 * @param now Current time (defaults to new Date())
 * @param dailyStartTime System-wide start of day, e.g. "08:00" or "00:00"
 */
export function findActiveSchedule(
  schedules: RouteScheduleItem[],
  now: Date,
  dailyStartTime: string = "00:00"
): RouteScheduleItem | null {
  if (!Array.isArray(schedules) || schedules.length === 0) return null;

  for (const schedule of schedules) {
    const { daysOfWeek, startTime, useDailyStartAsEnd, endNextDay } = schedule;
    if (!daysOfWeek || daysOfWeek.length === 0) continue;

    // Resolve end time and next day flag
    const resolvedEndTime = useDailyStartAsEnd ? dailyStartTime : schedule.endTime;
    const resolvedEndNextDay = useDailyStartAsEnd ? true : endNextDay;

    const [startHour, startMinute] = startTime.split(":").map(Number);
    const [endHour, endMinute] = resolvedEndTime.split(":").map(Number);

    // Check candidate days around 'now' (handle midnight/next-day crossings)
    for (const offset of [-1, 0]) {
      const candidateDate = new Date(now);
      candidateDate.setDate(now.getDate() + offset);

      const candidateDayOfWeek = candidateDate.getDay();
      if (daysOfWeek.includes(candidateDayOfWeek)) {
        const windowStart = new Date(candidateDate);
        windowStart.setHours(startHour, startMinute, 0, 0);

        const windowEnd = new Date(candidateDate);
        if (resolvedEndNextDay) {
          windowEnd.setDate(candidateDate.getDate() + 1);
        }
        windowEnd.setHours(endHour, endMinute, 0, 0);

        if (now >= windowStart && now < windowEnd) {
          return schedule;
        }
      }
    }
  }

  return null;
}

/**
 * Gets the active schedule directly from a raw schedules string.
 */
export function getActiveRouteSchedule(
  schedulesStr: string | null | undefined,
  now: Date,
  dailyStartTime: string
): RouteScheduleItem | null {
  const schedules = safeParseSchedules(schedulesStr);
  return findActiveSchedule(schedules, now, dailyStartTime);
}

/**
 * Clones the route and applies active schedule overrides to target provider and fallback rules.
 */
export function resolveActiveRouteProperties<T extends RouteProperties>(
  route: T,
  activeSchedule: RouteScheduleItem | null
): T {
  if (!activeSchedule) return route;

  let resolvedTargets = activeSchedule.targets;
  if (!resolvedTargets) {
    const t = [{
      providerId: activeSchedule.providerId,
      providerProtocol: activeSchedule.providerProtocol || "openai",
      modelId: activeSchedule.modelId,
      promptPolicyId: activeSchedule.promptPolicyId || "none",
      bestEffort: false,
      strategyRoutingEnabled: false,
      strategyRoutingRules: []
    }];
    if (activeSchedule.fallbackEnabled && activeSchedule.fallbackProviderId && activeSchedule.fallbackProviderId !== "none") {
      t.push({
        providerId: activeSchedule.fallbackProviderId,
        providerProtocol: activeSchedule.fallbackProviderProtocol || "openai",
        modelId: activeSchedule.fallbackModelId || "",
        promptPolicyId: activeSchedule.fallbackPromptPolicyId || "none",
        bestEffort: !!activeSchedule.fallbackMatchTarget,
        strategyRoutingEnabled: false,
        strategyRoutingRules: []
      });
    }
    resolvedTargets = JSON.stringify(t);
  } else {
    resolvedTargets = typeof resolvedTargets === 'string' ? resolvedTargets : JSON.stringify(resolvedTargets);
  }

  return {
    ...route,
    targets: resolvedTargets,
    providerId: activeSchedule.providerId,
    providerProtocol: activeSchedule.providerProtocol,
    modelId: activeSchedule.modelId,
    promptPolicyId: activeSchedule.promptPolicyId || null,
    allowClientModel: !!activeSchedule.allowClientModel,
    fallbackEnabled: !!activeSchedule.fallbackEnabled,
    fallbackProviderId: activeSchedule.fallbackProviderId || null,
    fallbackProviderProtocol: activeSchedule.fallbackProviderProtocol || null,
    fallbackModelId: activeSchedule.fallbackModelId || null,
    fallbackPromptPolicyId: activeSchedule.fallbackPromptPolicyId || null,
    fallbackMatchTarget: !!activeSchedule.fallbackMatchTarget,
    strategyRoutingEnabled: false,
  } as T;
}

/**
 * Helper to fetch the system start of day setting from the database.
 */
export async function getDailyStartTime(): Promise<string> {
  try {
    const startOfDaySetting = await db
      .select()
      .from(systemSettings)
      .where(eq(systemSettings.key, "analyticsStartOfDay"))
      .limit(1);
    return startOfDaySetting.length > 0 && startOfDaySetting[0].value
      ? startOfDaySetting[0].value
      : "00:00";
  } catch {
    return "00:00";
  }
}
