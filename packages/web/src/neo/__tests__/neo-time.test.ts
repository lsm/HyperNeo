import { describe, expect, it } from 'vitest';
import { neoRelativeTime } from '../neo-time.ts';

const now = new Date(2026, 10, 9, 18, 30).getTime();

describe('neoRelativeTime', () => {
  it.each([undefined, null, 0, -1, NaN, Infinity, 9e20])('omits invalid time %s', (at) => {
    expect(neoRelativeTime(at, now, 'en')).toBeNull();
  });
  it('uses localized ranges and retains an accessible full date', () => {
    expect(neoRelativeTime(now - 59_000, now, 'en')?.label).toBe('just now');
    expect(neoRelativeTime(now - 120_000, now, 'en')?.label).toBe('2 minutes ago');
    expect(neoRelativeTime(now - 7_200_000, now, 'zh-Hans')?.label).toBe('2小时前');
    const value = neoRelativeTime(now, now, 'en')!;
    expect(value.iso).toBe(new Date(now).toISOString());
    expect(value.full).toContain('2026');
    expect(value.full).toContain('18:30');
    expect(value.full).toContain('Mon');
  });
  it('shows yesterday after 24 hours, otherwise dates with the year only when needed', () => {
    const yesterday = new Date(2026, 10, 8, 17, 39).getTime();
    expect(neoRelativeTime(yesterday, now, 'en')?.label).toBe('Yesterday 17:39');
    expect(neoRelativeTime(yesterday, now, 'zh-Hans')?.label).toBe('昨天 17:39');
    expect(neoRelativeTime(new Date(2026, 9, 2, 9, 5).getTime(), now, 'en')?.label).not.toContain(
      '2026'
    );
    expect(neoRelativeTime(new Date(2025, 9, 2, 9, 5).getTime(), now, 'en')?.label).toContain(
      '2025'
    );
  });
});
