import { db } from "../db";
import { systemSettings } from "../db/schema";
import { inArray } from "drizzle-orm";

export async function getStartDateFromTimeRange(timeRange: string | undefined): Promise<Date> {
  if (!timeRange) timeRange = "30";
  const settings = await db.select().from(systemSettings).where(inArray(systemSettings.key, ["analyticsStartOfDay", "analyticsStartOfWeek"]));
  let startOfDayStr = "00:00";
  let startOfWeekStr = "1";
  for (const s of settings) {
    if (s.key === "analyticsStartOfDay") startOfDayStr = s.value;
    if (s.key === "analyticsStartOfWeek") startOfWeekStr = s.value;
  }
  const bounds = getTimeRangeBounds(timeRange, startOfDayStr, startOfWeekStr);
  return bounds || new Date(0);
}

export async function getQueryDateRange(query: any, defaultRange?: string): Promise<{ startDate: Date; endDate: Date | null }> {
  const { timeRange, startDate, endDate } = query || {};
  let start: Date | null = null;
  let end: Date | null = null;

  if (startDate) {
    const d = new Date(startDate);
    if (!isNaN(d.getTime())) {
      start = d;
    }
  }

  if (endDate) {
    const d = new Date(endDate);
    if (!isNaN(d.getTime())) {
      end = d;
    }
  }

  if (start || end) {
    return {
      startDate: start || new Date(0),
      endDate: end,
    };
  }

  const calculatedStart = await getStartDateFromTimeRange(timeRange || defaultRange);
  return { startDate: calculatedStart, endDate: null };
}

export function getTimeRangeBounds(
  timeRange: string,
  startOfDayStr: string = "00:00",
  startOfWeekStr: string = "1",
  now: Date = new Date()
): Date | null {
  // Parse startOfDayStr "HH:mm"
  let startHour = 0;
  let startMinute = 0;
  try {
    const parts = startOfDayStr.split(":");
    if (parts.length === 2) {
      startHour = parseInt(parts[0], 10);
      startMinute = parseInt(parts[1], 10);
    }
  } catch (e) {}

  const startOfWeek = parseInt(startOfWeekStr, 10); // 0 = Sunday, 1 = Monday

  // Get current date adjusted by the start of day.
  // If current time is before the startOfDay time, we belong to the "previous" logical day.
  const currentDayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), startHour, startMinute, 0, 0);

  let logicalTodayStart = new Date(currentDayStart.getTime());
  if (now.getTime() < currentDayStart.getTime()) {
    // Before start of day, so logical "today" started yesterday
    logicalTodayStart.setDate(logicalTodayStart.getDate() - 1);
  }

  switch (timeRange) {
    case "day":
      return logicalTodayStart;
    case "week": {
      // Find the start of the current logical week
      let dayOfWeek = logicalTodayStart.getDay(); // 0 (Sun) to 6 (Sat)
      let diff = dayOfWeek - startOfWeek;
      if (diff < 0) {
        diff += 7; // Wrap around if startOfWeek is after current day of week
      }
      const logicalWeekStart = new Date(logicalTodayStart.getTime());
      logicalWeekStart.setDate(logicalWeekStart.getDate() - diff);
      return logicalWeekStart;
    }
    case "month": {
      const logicalMonthStart = new Date(logicalTodayStart.getFullYear(), logicalTodayStart.getMonth(), 1, startHour, startMinute, 0, 0);
      return logicalMonthStart;
    }
    case "year": {
      const logicalYearStart = new Date(logicalTodayStart.getFullYear(), 0, 1, startHour, startMinute, 0, 0);
      return logicalYearStart;
    }
    case "all":
      return null; // Return null to indicate no start date limit
    default: {
      // Fallback for "30" or "7" (legacy format `days`)
      let days = parseInt(timeRange, 10);
      if (isNaN(days) || days <= 0) days = 30; // default to 30 days
      return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    }
  }
}
