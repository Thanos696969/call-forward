import { describe, expect, it } from 'vitest';
import {
  isTerminalCallStatus,
  mapDialStatus,
  mapParentStatusWithoutDialResult,
  parseDurationSeconds,
} from '../src/outcome';
import { billedSecondsPlaceholder, billedSecondsWithIncrement } from '../src/billing';

describe('dial outcome mapping', () => {
  it.each([
    ['completed', 'completed'],
    ['no-answer', 'no_answer'],
    ['busy', 'busy'],
    ['failed', 'failed'],
    ['canceled', 'abandoned'],
    ['COMPLETED', 'completed'],
    ['something-new', 'failed'],
    [undefined, 'failed'],
  ] as const)('%s → %s', (status, outcome) => {
    expect(mapDialStatus(status)).toBe(outcome);
  });

  it('maps a terminal parent status when no dial result arrived', () => {
    expect(mapParentStatusWithoutDialResult('completed')).toBe('abandoned');
    expect(mapParentStatusWithoutDialResult('canceled')).toBe('abandoned');
    expect(mapParentStatusWithoutDialResult('busy')).toBe('busy');
    expect(mapParentStatusWithoutDialResult('ringing')).toBeNull();
  });

  it('knows terminal statuses', () => {
    expect(isTerminalCallStatus('completed')).toBe(true);
    expect(isTerminalCallStatus('in-progress')).toBe(false);
  });

  it('parses durations defensively', () => {
    expect(parseDurationSeconds('42')).toBe(42);
    expect(parseDurationSeconds('-3')).toBe(0);
    expect(parseDurationSeconds('abc')).toBe(0);
    expect(parseDurationSeconds(undefined)).toBe(0);
  });
});

describe('billed seconds', () => {
  it('Phase 1 placeholder equals talk seconds', () => {
    expect(billedSecondsPlaceholder(42)).toBe(42);
    expect(billedSecondsPlaceholder(0)).toBe(0);
    expect(billedSecondsPlaceholder(null)).toBe(0);
    expect(billedSecondsPlaceholder(undefined)).toBe(0);
    expect(billedSecondsPlaceholder(-5)).toBe(0);
    expect(billedSecondsPlaceholder(12.7)).toBe(12);
  });

  it('increment billing rounds up with a minimum (Phase 3)', () => {
    expect(billedSecondsWithIncrement(1)).toBe(60);
    expect(billedSecondsWithIncrement(60)).toBe(60);
    expect(billedSecondsWithIncrement(61)).toBe(120);
    expect(billedSecondsWithIncrement(61, 6, 6)).toBe(66);
    expect(billedSecondsWithIncrement(0)).toBe(0);
  });
});
