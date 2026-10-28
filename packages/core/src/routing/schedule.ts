import type { ClockTime, LocalDate, ScheduleSpec, ScheduleWindow } from './types';

/**
 * Wall-clock evaluation of schedules in an IANA timezone, using Intl only.
 * DST is handled by construction: we ask "what does the clock on the wall say
 * there right now?" and compare against local opening hours.
 */

export interface LocalParts {
  date: LocalDate;
  /** 0 = Sunday … 6 = Saturday. */
  dayOfWeek: number;
  /** Minutes since local midnight, 0..1439. */
  minutes: number;
  hour: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function localParts(timeZone: string, at: Date): LocalParts {
  const parts = formatter(timeZone).formatToParts(at);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? '';
  const hour = Number(get('hour')) % 24;
  const minute = Number(get('minute'));
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    dayOfWeek: WEEKDAYS[get('weekday')] ?? 0,
    minutes: hour * 60 + minute,
    hour,
  };
}

/** Parse "HH:MM" or "HH:MM:SS" into minutes since midnight ("24:00" → 1440). */
export function clockMinutes(value: ClockTime): number {
  const m = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(value);
  if (!m) throw new RangeError(`Invalid time: ${value}`);
  const total = Number(m[1]) * 60 + Number(m[2]);
  if (Number(m[1]) > 24 || Number(m[2]) > 59 || total > 1440)
    throw new RangeError(`Invalid time: ${value}`);
  return total;
}

export function addDays(date: LocalDate, days: number): LocalDate {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

type Range = [open: number, close: number];

interface DayRule {
  closed: boolean;
  ranges: Range[];
}

function rangeOf(open: ClockTime | null, close: ClockTime | null): Range {
  if (open === null || close === null) return [0, 1440];
  return [clockMinutes(open), clockMinutes(close)];
}

/** The opening ranges that start on `date` (before considering spill-over from the day before). */
function rulesFor(windows: ScheduleWindow[], date: LocalDate, dayOfWeek: number): DayRule {
  const dated = windows.filter((w) => w.type === 'date' && w.start <= date && date <= w.end);
  if (dated.some((w) => w.type === 'date' && w.kind === 'closed'))
    return { closed: true, ranges: [] };
  const datedOpen = dated.filter((w) => w.type === 'date' && w.kind === 'open');
  if (datedOpen.length > 0) {
    return {
      closed: false,
      ranges: datedOpen.map((w) => (w.type === 'date' ? rangeOf(w.open, w.close) : [0, 0])),
    };
  }
  const hasWeekly = windows.some((w) => w.type === 'weekly');
  if (!hasWeekly) return { closed: false, ranges: [[0, 1440]] };
  return {
    closed: false,
    ranges: windows
      .filter((w) => w.type === 'weekly' && w.dayOfWeek === dayOfWeek)
      .map((w) => (w.type === 'weekly' ? rangeOf(w.open, w.close) : [0, 0])),
  };
}

/**
 * Is the schedule open at `at`?
 *
 * Rules, in order:
 * 1. A `closed` dated window covering today's local date closes the whole day,
 *    including any spill-over from yesterday's late window.
 * 2. `open` dated windows covering today replace the weekly hours for today.
 * 3. Otherwise today's weekly windows apply. With no weekly windows at all, the
 *    schedule is open all day (so a schedule of holidays only works as expected).
 * 4. Yesterday's windows that cross midnight stay open until their close time.
 */
export function isOpenAt(schedule: ScheduleSpec | null, at: Date): boolean {
  if (!schedule) return true;
  const now = localParts(schedule.timezone, at);
  const today = rulesFor(schedule.windows, now.date, now.dayOfWeek);
  if (today.closed) return false;
  for (const [open, close] of today.ranges) {
    if (open === close) return true; // 24 hours
    if (close > open ? now.minutes >= open && now.minutes < close : now.minutes >= open)
      return true;
  }
  const yesterday = rulesFor(schedule.windows, addDays(now.date, -1), (now.dayOfWeek + 6) % 7);
  if (yesterday.closed) return false;
  for (const [open, close] of yesterday.ranges) {
    if (close < open && now.minutes < close) return true;
  }
  return false;
}

/** Hourly and daily cap window labels on the given timezone's clock. */
export function capWindowKeys(timeZone: string, at: Date): { hour: string; day: string } {
  const p = localParts(timeZone, at);
  const day = p.date.replace(/-/g, '');
  return { day, hour: `${day}${String(p.hour).padStart(2, '0')}` };
}

/** Validate a set of windows; returns an error message or null. */
export function validateWindows(windows: ScheduleWindow[]): string | null {
  for (const w of windows) {
    try {
      if (w.type === 'weekly') {
        if (!Number.isInteger(w.dayOfWeek) || w.dayOfWeek < 0 || w.dayOfWeek > 6)
          return 'Day must be 0–6';
        clockMinutes(w.open);
        clockMinutes(w.close);
      } else {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(w.start) || !/^\d{4}-\d{2}-\d{2}$/.test(w.end))
          return 'Dates must be YYYY-MM-DD';
        if (w.end < w.start) return 'End date is before start date';
        if ((w.open === null) !== (w.close === null))
          return 'Give both an opening and a closing time, or neither';
        if (w.open !== null) clockMinutes(w.open);
        if (w.close !== null) clockMinutes(w.close);
      }
    } catch (err) {
      return (err as Error).message;
    }
  }
  return null;
}
