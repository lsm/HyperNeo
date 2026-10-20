import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { normalizeSQLiteQuery } from '../packages/daemon/src/storage/sqlite-query-normalization.ts';

interface LagEvent {
  message: string;
  timestamp?: number;
  kind: 'blocked' | 'unresponsive';
  durationMs: number;
  sql: string;
}

interface Day {
  day: string;
  blocks: number;
  unresponsive: number;
  worstBlockMs: number;
}

interface Group {
  day: string;
  sql: string;
  blocks: number;
  totalMs: number;
  worstMs: number;
}

interface Window {
  since?: number;
  until?: number;
}

interface Report {
  days: Day[];
  groups: Group[];
  undated: { blocks: number; unresponsive: number };
}

function timestampOf(value: unknown): number | undefined {
  const timestamp = typeof value === 'number' ? value : Date.parse(String(value));
  return Number.isFinite(timestamp) && !Number.isNaN(new Date(timestamp).getTime())
    ? timestamp
    : undefined;
}

function parseEvents(text: string): LagEvent[] {
  const events: LagEvent[] = [];
  for (const line of text.split(/\r?\n/)) {
    let message = line;
    let timestamp: number | undefined;
    if (line.startsWith('{')) {
      try {
        const record = JSON.parse(line);
        if (typeof record?.message !== 'string') continue;
        message = record.message;
        timestamp = timestampOf(record.timestamp);
      } catch {
        continue;
      }
    } else {
      const prefix = line.match(/^\[?(\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2}))\]?\s+/);
      if (prefix) {
        timestamp = timestampOf(prefix[1]);
        message = line.slice(prefix[0].length);
      }
    }
    const match = message.match(
      /^\[Daemon\] Event loop (blocked|unresponsive) for (\d+)ms(?:; slowest SQL \d+ms: (.+))?/
    );
    if (!match || Number(match[2]) < 1000) continue;
    events.push({
      message,
      timestamp,
      kind: match[1] as LagEvent['kind'],
      durationMs: Number(match[2]),
      sql: match[3]
        ? normalizeSQLiteQuery(match[3]).replace(/\(\s*\?\s*\.\s*\.\s*\)/g, '(?..)')
        : 'no SQL',
    });
  }
  return events;
}

export function readLagEvents(text: string, timestamps?: string): LagEvent[] {
  const events = parseEvents(text);
  if (timestamps === undefined) return events;
  const mirror = parseEvents(timestamps);
  const offset = events.length - mirror.length;
  if (offset < 0 || mirror.some((event, i) => event.message !== events[offset + i].message)) {
    throw new Error(
      'Timestamp log does not match the console lag-event suffix; use matching logs.'
    );
  }
  return events.map((event, i) =>
    i < offset ? event : { ...event, timestamp: mirror[i - offset].timestamp }
  );
}

export function summarizeLag(events: LagEvent[], window: Window = {}): Report {
  const days = new Map<string, Day>();
  const groups = new Map<string, Group>();
  const undated = { blocks: 0, unresponsive: 0 };
  for (const event of events) {
    if (
      event.timestamp === undefined &&
      (window.since !== undefined || window.until !== undefined)
    ) {
      undated[event.kind === 'blocked' ? 'blocks' : 'unresponsive']++;
      continue;
    }
    if (
      event.timestamp !== undefined &&
      (event.timestamp < (window.since ?? -Infinity) ||
        event.timestamp >= (window.until ?? Infinity))
    )
      continue;
    const day =
      event.timestamp === undefined
        ? 'undated'
        : new Date(event.timestamp).toISOString().slice(0, 10);
    const daily = days.get(day) ?? { day, blocks: 0, unresponsive: 0, worstBlockMs: 0 };
    days.set(day, daily);
    if (event.kind === 'unresponsive') {
      daily.unresponsive++;
      continue;
    }
    daily.blocks++;
    daily.worstBlockMs = Math.max(daily.worstBlockMs, event.durationMs);
    const key = `${day}\0${event.sql}`;
    const group = groups.get(key) ?? { day, sql: event.sql, blocks: 0, totalMs: 0, worstMs: 0 };
    group.blocks++;
    group.totalMs += event.durationMs;
    group.worstMs = Math.max(group.worstMs, event.durationMs);
    groups.set(key, group);
  }
  return {
    days: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)),
    groups: [...groups.values()].sort(
      (a, b) => a.day.localeCompare(b.day) || b.totalMs - a.totalMs || a.sql.localeCompare(b.sql)
    ),
    undated,
  };
}

export function renderLagReport(report: Report): string {
  return [
    '| Day (UTC) | Blocks | Unresponsive | Worst block (ms) |',
    '| --- | ---: | ---: | ---: |',
    ...report.days.map((d) => `| ${d.day} | ${d.blocks} | ${d.unresponsive} | ${d.worstBlockMs} |`),
    ...(report.days.length ? [] : ['No dated events in the selected window.']),
    '',
    '| Day (UTC) | Blocks | Total blocked (ms) | Worst block (ms) | Slowest SQL |',
    '| --- | ---: | ---: | ---: | --- |',
    ...report.groups.map(
      (g) =>
        `| ${g.day} | ${g.blocks} | ${g.totalMs} | ${g.worstMs} | ${g.sql.replaceAll('|', '\\|')} |`
    ),
    '',
    `Undated events excluded: ${report.undated.blocks} blocks, ${report.undated.unresponsive} unresponsive.`,
    'SQL groups rank total blocked time, not SQL execution time. Watchdog stalls are counted separately.',
  ].join('\n');
}

if (import.meta.main) {
  try {
    const { values, positionals } = parseArgs({
      args: process.argv.slice(2),
      allowPositionals: true,
      options: {
        timestamps: { type: 'string' },
        since: { type: 'string' },
        until: { type: 'string' },
      },
    });
    if (positionals.length !== 1) {
      throw new Error(
        'Usage: bun scripts/daemon-lag-tally.ts <log> [--timestamps <jsonl>] [--since <ISO>] [--until <ISO>]'
      );
    }
    const window: Window = {};
    for (const key of ['since', 'until'] as const) {
      if (values[key] === undefined) continue;
      const value = values[key];
      if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(value) || timestampOf(value) === undefined) {
        throw new Error(`--${key} must be an ISO timestamp with timezone`);
      }
      window[key] = timestampOf(value);
    }
    if ((window.since ?? -Infinity) >= (window.until ?? Infinity)) {
      throw new Error('--since must precede --until');
    }
    const events = readLagEvents(
      readFileSync(positionals[0], 'utf8'),
      values.timestamps === undefined ? undefined : readFileSync(values.timestamps, 'utf8')
    );
    console.log(
      `Window (UTC): ${values.since ?? 'unbounded'} <= timestamp < ${values.until ?? 'unbounded'}`
    );
    console.log(renderLagReport(summarizeLag(events, window)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
