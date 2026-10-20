import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  readLagEvents,
  renderLagReport,
  summarizeLag,
} from '../../../../../scripts/daemon-lag-tally.ts';

const fixture = readFileSync(join(import.meta.dirname, 'fixtures/daemon-lag-tally.txt'), 'utf8');

describe('daemon lag tally', () => {
  test('reports UTC days and ranks attributed blocked time without counting watchdog time twice', () => {
    const report = summarizeLag(readLagEvents(fixture));
    expect(report.days).toEqual([
      { day: '2026-10-19', blocks: 1, unresponsive: 0, worstBlockMs: 1200 },
      { day: '2026-10-20', blocks: 3, unresponsive: 1, worstBlockMs: 5000 },
    ]);
    expect(report.groups).toEqual([
      {
        day: '2026-10-19',
        sql: 'select * from jobs where id = ? limit ?',
        blocks: 1,
        totalMs: 1200,
        worstMs: 1200,
      },
      { day: '2026-10-20', sql: 'no SQL', blocks: 1, totalMs: 5000, worstMs: 5000 },
      {
        day: '2026-10-20',
        sql: 'select * from jobs where id = ? limit ?',
        blocks: 2,
        totalMs: 4000,
        worstMs: 2500,
      },
    ]);
    const output = renderLagReport(report);
    expect(output).toContain('| 2026-10-20 | 3 | 1 | 5000 |');
    expect(output).toContain('| 2026-10-20 | 1 | 5000 | 5000 | no SQL |');
    expect(output).not.toContain('private');
    expect(output).not.toContain('60080');
  });

  test('bounds a last-24-hours report by timestamp and includes a zero-SQL group', () => {
    const report = summarizeLag(readLagEvents(fixture), {
      since: Date.parse('2026-10-20T00:00:00Z'),
      until: Date.parse('2026-10-21T00:00:00Z'),
    });
    expect(report.days).toEqual([
      { day: '2026-10-20', blocks: 3, unresponsive: 1, worstBlockMs: 5000 },
    ]);
    expect(report.groups[0].sql).toBe('no SQL');
  });

  test('uses timestamped JSONL for an exact console suffix and exposes older undated events', () => {
    const events = readLagEvents(fixture);
    const message = '[Daemon] Event loop blocked for 1500ms';
    const plain = `${message}\n${message}\n`;
    const mirror = JSON.stringify({ timestamp: Date.parse('2026-10-20T00:00:00Z'), message });
    const aligned = readLagEvents(plain, mirror);
    const report = summarizeLag(aligned, {
      since: Date.parse('2026-10-19T00:00:00Z'),
      until: Date.parse('2026-10-21T00:00:00Z'),
    });
    expect(report.days).toEqual([
      { day: '2026-10-20', blocks: 1, unresponsive: 0, worstBlockMs: 1500 },
    ]);
    expect(report.undated).toEqual({ blocks: 1, unresponsive: 0 });
    expect(renderLagReport(report)).toContain('Undated events excluded: 1 blocks, 0 unresponsive');
    expect(events).toHaveLength(5);
  });

  test('accepts JSONL directly, retains missing dates, and refuses to guess from a mismatched mirror', () => {
    const message =
      '[Daemon] Event loop unresponsive for 61000ms; the daemon is not serving requests.';
    const json = JSON.stringify({ timestamp: '2026-10-20T00:00:00+02:00', message });
    expect(summarizeLag(readLagEvents(json)).days).toEqual([
      { day: '2026-10-19', blocks: 0, unresponsive: 1, worstBlockMs: 0 },
    ]);
    expect(summarizeLag(readLagEvents(message)).days[0].day).toBe('undated');
    expect(() => readLagEvents(fixture, json)).toThrow('does not match');
  });

  test('renders an empty observation without inventing a successful day', () => {
    expect(renderLagReport(summarizeLag(readLagEvents('not JSON\n{invalid\n')))).toContain(
      'No dated events in the selected window.'
    );
  });
});
