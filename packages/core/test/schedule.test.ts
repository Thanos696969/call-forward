import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  addDays,
  capWindowKeys,
  clockMinutes,
  isOpenAt,
  localParts,
  validateWindows,
} from '../src/routing/schedule';
import type { ScheduleSpec, ScheduleWindow } from '../src/routing/types';

const utc = (iso: string) => new Date(`${iso}Z`);
const spec = (windows: ScheduleWindow[], timezone = 'UTC'): ScheduleSpec => ({ timezone, windows });

// 2026-10-30 is a Friday.
describe('weekly windows', () => {
  const s = spec([{ type: 'weekly', dayOfWeek: 5, open: '09:00', close: '17:00' }]);
  it('opens inside and closes outside the window', () => {
    expect(isOpenAt(s, utc('2026-10-30T09:00:00'))).toBe(true);
    expect(isOpenAt(s, utc('2026-10-30T16:59:00'))).toBe(true);
    expect(isOpenAt(s, utc('2026-10-30T17:00:00'))).toBe(false);
    expect(isOpenAt(s, utc('2026-10-30T08:59:00'))).toBe(false);
    expect(isOpenAt(s, utc('2026-10-31T10:00:00'))).toBe(false); // Saturday
  });
  it('no schedule means always open', () => {
    expect(isOpenAt(null, utc('2026-10-31T03:00:00'))).toBe(true);
  });
  it('treats open == close as 24 hours', () => {
    const allDay = spec([{ type: 'weekly', dayOfWeek: 5, open: '00:00', close: '00:00' }]);
    expect(isOpenAt(allDay, utc('2026-10-30T23:59:00'))).toBe(true);
    expect(isOpenAt(allDay, utc('2026-10-31T00:00:00'))).toBe(false);
  });
});

describe('cross-midnight windows', () => {
  const late = spec([{ type: 'weekly', dayOfWeek: 5, open: '22:00', close: '02:00' }]);
  it('spill over into the next morning', () => {
    expect(isOpenAt(late, utc('2026-10-30T21:59:00'))).toBe(false);
    expect(isOpenAt(late, utc('2026-10-30T22:00:00'))).toBe(true);
    expect(isOpenAt(late, utc('2026-10-31T01:59:00'))).toBe(true); // Saturday early
    expect(isOpenAt(late, utc('2026-10-31T02:00:00'))).toBe(false);
    expect(isOpenAt(late, utc('2026-10-30T01:00:00'))).toBe(false); // Friday early: Thursday has no window
  });
  it('a closed date also closes yesterday’s spill-over', () => {
    const s = spec([
      { type: 'weekly', dayOfWeek: 5, open: '22:00', close: '02:00' },
      {
        type: 'date',
        start: '2026-10-31',
        end: '2026-10-31',
        kind: 'closed',
        open: null,
        close: null,
      },
    ]);
    expect(isOpenAt(s, utc('2026-10-30T23:00:00'))).toBe(true);
    expect(isOpenAt(s, utc('2026-10-31T01:00:00'))).toBe(false);
  });
  it('property: matches a minute-by-minute oracle', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            dayOfWeek: fc.integer({ min: 0, max: 6 }),
            open: fc.integer({ min: 0, max: 1439 }),
            close: fc.integer({ min: 0, max: 1439 }),
          }),
          { minLength: 1, maxLength: 4 },
        ),
        fc.integer({ min: 0, max: 7 * 1440 - 1 }),
        (ws, minuteOfWeek) => {
          const hhmm = (m: number) =>
            `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
          const windows: ScheduleWindow[] = ws.map((w) => ({
            type: 'weekly',
            dayOfWeek: w.dayOfWeek,
            open: hhmm(w.open),
            close: hhmm(w.close),
          }));
          // 2026-11-01 is a Sunday (dayOfWeek 0).
          const at = new Date(Date.UTC(2026, 10, 1) + minuteOfWeek * 60_000);
          const dow = Math.floor(minuteOfWeek / 1440);
          const min = minuteOfWeek % 1440;
          const oracle = ws.some((w) => {
            if (w.open === w.close) return w.dayOfWeek === dow;
            if (w.close > w.open) return w.dayOfWeek === dow && min >= w.open && min < w.close;
            return (
              (w.dayOfWeek === dow && min >= w.open) ||
              ((w.dayOfWeek + 1) % 7 === dow && min < w.close)
            );
          });
          return isOpenAt(spec(windows), at) === oracle;
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe('dated windows', () => {
  const weekly: ScheduleWindow = { type: 'weekly', dayOfWeek: 5, open: '09:00', close: '17:00' };
  it('closed dates black out the day', () => {
    const s = spec([
      weekly,
      {
        type: 'date',
        start: '2026-10-30',
        end: '2026-10-30',
        kind: 'closed',
        open: null,
        close: null,
      },
    ]);
    expect(isOpenAt(s, utc('2026-10-30T12:00:00'))).toBe(false);
  });
  it('open dates replace weekly hours, all day when no times are given', () => {
    const s = spec([
      weekly,
      {
        type: 'date',
        start: '2026-10-31',
        end: '2026-11-01',
        kind: 'open',
        open: null,
        close: null,
      },
    ]);
    expect(isOpenAt(s, utc('2026-10-31T03:00:00'))).toBe(true);
    const timed = spec([
      weekly,
      {
        type: 'date',
        start: '2026-10-30',
        end: '2026-10-30',
        kind: 'open',
        open: '18:00',
        close: '20:00',
      },
    ]);
    expect(isOpenAt(timed, utc('2026-10-30T12:00:00'))).toBe(false);
    expect(isOpenAt(timed, utc('2026-10-30T19:00:00'))).toBe(true);
  });
  it('a holidays-only schedule is open every other day', () => {
    const s = spec([
      {
        type: 'date',
        start: '2026-12-25',
        end: '2026-12-25',
        kind: 'closed',
        open: null,
        close: null,
      },
    ]);
    expect(isOpenAt(s, utc('2026-12-24T12:00:00'))).toBe(true);
    expect(isOpenAt(s, utc('2026-12-25T12:00:00'))).toBe(false);
  });
});

describe('timezones and DST', () => {
  const ny = spec(
    [{ type: 'weekly', dayOfWeek: 5, open: '09:00', close: '17:00' }],
    'America/New_York',
  );
  it('evaluates in the schedule timezone', () => {
    expect(isOpenAt(ny, utc('2026-10-30T13:00:00'))).toBe(true); // 09:00 EDT
    expect(isOpenAt(ny, utc('2026-10-30T12:59:00'))).toBe(false);
    expect(localParts('Asia/Kolkata', utc('2026-10-30T20:00:00'))).toMatchObject({
      date: '2026-10-31',
      minutes: 90,
    });
  });
  it('follows the wall clock across the spring-forward gap', () => {
    // 2026-03-08 (Sunday): New York clocks jump from 02:00 EST to 03:00 EDT.
    const s = spec(
      [{ type: 'weekly', dayOfWeek: 0, open: '01:00', close: '03:00' }],
      'America/New_York',
    );
    expect(isOpenAt(s, utc('2026-03-08T06:59:00'))).toBe(true); // 01:59 EST
    expect(isOpenAt(s, utc('2026-03-08T07:00:00'))).toBe(false); // 03:00 EDT
  });
  it('cap windows use the local clock', () => {
    expect(capWindowKeys('America/New_York', utc('2026-10-31T03:30:00'))).toEqual({
      day: '20261030',
      hour: '2026103023',
    });
  });
});

describe('helpers', () => {
  it('parses clock times and adds days across months', () => {
    expect(clockMinutes('24:00')).toBe(1440);
    expect(clockMinutes('09:30:00')).toBe(570);
    expect(() => clockMinutes('25:00')).toThrow();
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
  it('validates windows', () => {
    expect(
      validateWindows([{ type: 'weekly', dayOfWeek: 7, open: '09:00', close: '10:00' }]),
    ).toMatch(/Day/);
    expect(
      validateWindows([
        {
          type: 'date',
          start: '2026-02-02',
          end: '2026-02-01',
          kind: 'open',
          open: null,
          close: null,
        },
      ]),
    ).toMatch(/before/);
    expect(
      validateWindows([
        {
          type: 'date',
          start: '2026-02-01',
          end: '2026-02-01',
          kind: 'open',
          open: '09:00',
          close: null,
        },
      ]),
    ).toMatch(/both/);
    expect(
      validateWindows([{ type: 'weekly', dayOfWeek: 1, open: '22:00', close: '02:00' }]),
    ).toBeNull();
  });
});
