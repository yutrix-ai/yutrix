import React, { createContext, useContext, useState, useMemo } from 'react';

export type TimeRange = 'day' | 'week' | 'month' | 'year' | 'all' | 'custom';

interface TimeRangeContextType {
  timeRange: TimeRange;
  setTimeRange: (range: TimeRange) => void;
  customStart: Date | null;
  customEnd: Date | null;
  setCustomRange: (start: Date | null, end: Date | null) => void;
  timeRangeQuery: string;
}

const TimeRangeContext = createContext<TimeRangeContextType | undefined>(undefined);

export function TimeRangeProvider({ children }: { children: React.ReactNode }) {
  const [timeRange, setTimeRangeState] = useState<TimeRange>(() => {
    return (localStorage.getItem('promptgate_timeRange') as TimeRange) || 'month';
  });

  const [customStart, setCustomStart] = useState<Date | null>(() => {
    const s = localStorage.getItem('promptgate_customStart');
    if (s) {
      const d = new Date(s);
      return isNaN(d.getTime()) ? null : d;
    }
    return null;
  });

  const [customEnd, setCustomEnd] = useState<Date | null>(() => {
    const e = localStorage.getItem('promptgate_customEnd');
    if (e) {
      const d = new Date(e);
      return isNaN(d.getTime()) ? null : d;
    }
    return null;
  });

  const setTimeRange = (range: TimeRange) => {
    setTimeRangeState(range);
    localStorage.setItem('promptgate_timeRange', range);
  };

  const setCustomRange = (start: Date | null, end: Date | null) => {
    setCustomStart(start);
    setCustomEnd(end);
    if (start) {
      localStorage.setItem('promptgate_customStart', start.toISOString());
    } else {
      localStorage.removeItem('promptgate_customStart');
    }
    if (end) {
      localStorage.setItem('promptgate_customEnd', end.toISOString());
    } else {
      localStorage.removeItem('promptgate_customEnd');
    }
  };

  const timeRangeQuery = useMemo(() => {
    if (timeRange === 'custom') {
      const parts = [`timeRange=custom`];
      if (customStart) parts.push(`startDate=${encodeURIComponent(customStart.toISOString())}`);
      if (customEnd) parts.push(`endDate=${encodeURIComponent(customEnd.toISOString())}`);
      return parts.join('&');
    }
    return `timeRange=${timeRange}`;
  }, [timeRange, customStart, customEnd]);

  return (
    <TimeRangeContext.Provider value={{ timeRange, setTimeRange, customStart, customEnd, setCustomRange, timeRangeQuery }}>
      {children}
    </TimeRangeContext.Provider>
  );
}

export function useTimeRange() {
  const context = useContext(TimeRangeContext);
  if (context === undefined) {
    throw new Error('useTimeRange must be used within a TimeRangeProvider');
  }
  return context;
}
