#!/usr/bin/env bun

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

interface ActionSummary {
  typed: number;
  dispatched: number;
  denied: number;
  failed: number;
  diff: number;
}

interface LogEvent {
  message: string;
  module?: string;
  timestamp?: number;
  metadata?: Record<string, unknown>;
}

export interface SoakOptions {
  logPaths: string[];
  json?: boolean;
  since?: number;
  until?: number;
}

function isStructuredLogEvent(value: unknown): value is LogEvent {
  if (typeof value !== 'object' || value === null) return false;
  const event = value as Record<string, unknown>;
  return typeof event.message === 'string';
}

function parseTimestamp(raw: string): number {
  const numeric = Number(raw);
  if (!Number.isNaN(numeric)) return numeric;
  const parsed = Date.parse(raw);
  if (!Number.isNaN(parsed)) return parsed;
  throw new Error(`invalid timestamp: ${raw}`);
}

function isInWindow(
  event: LogEvent,
  since: number | undefined,
  until: number | undefined
): boolean {
  if (since === undefined && until === undefined) return true;
  if (typeof event.timestamp !== 'number') return false;
  if (since !== undefined && event.timestamp < since) return false;
  if (until !== undefined && event.timestamp > until) return false;
  return true;
}

function aggregateActionEvent(totals: Map<string, ActionSummary>, event: LogEvent): void {
  const action = event.metadata?.action;
  if (typeof action !== 'string') return;

  if (event.message === 'action.typed' && event.module === 'hyperneo:daemon:space-actions.typed') {
    const row = totals.get(action) ?? { typed: 0, dispatched: 0, denied: 0, failed: 0, diff: 0 };
    row.typed++;
    row.diff = row.typed + row.denied + row.failed;
    totals.set(action, row);
    return;
  }

  if (
    event.message === 'action.dispatched' &&
    event.module === 'hyperneo:daemon:space-actions.dispatch'
  ) {
    const outcome = event.metadata?.outcome;
    if (typeof outcome !== 'string') return;
    const row = totals.get(action) ?? { typed: 0, dispatched: 0, denied: 0, failed: 0, diff: 0 };
    if (outcome === 'dispatched') row.dispatched++;
    else if (outcome === 'denied') row.denied++;
    else if (outcome === 'failed') row.failed++;
    else row.failed++;
    row.diff = row.typed + row.denied + row.failed;
    totals.set(action, row);
  }
}

function toRecord(totals: Map<string, ActionSummary>): Record<string, ActionSummary> {
  const result: Record<string, ActionSummary> = Object.create(null);
  for (const [action, row] of totals) result[action] = row;
  return result;
}

export function aggregateActionDispatchedTelemetry(
  events: Array<LogEvent>
): Record<string, ActionSummary> {
  const totals = new Map<string, ActionSummary>();
  for (const event of events) aggregateActionEvent(totals, event);
  return toRecord(totals);
}

export function formatSoakSummary(totals: Record<string, ActionSummary>): string {
  const actions = Object.keys(totals).sort();
  if (actions.length === 0) return 'No action telemetry found.';

  const header = 'action                              typed  dispatched  denied  failed  diff';
  const lines = [header, '-'.repeat(header.length)];
  let totalTyped = 0;
  let totalDispatched = 0;
  let totalDenied = 0;
  let totalFailed = 0;
  let totalDiff = 0;
  for (const action of actions) {
    const row = totals[action];
    totalTyped += row.typed;
    totalDispatched += row.dispatched;
    totalDenied += row.denied;
    totalFailed += row.failed;
    totalDiff += row.diff;
    const padded = action.padEnd(36);
    lines.push(
      `${padded}  ${String(row.typed).padStart(5)}  ${String(row.dispatched).padStart(10)}  ${String(row.denied).padStart(6)}  ${String(row.failed).padStart(6)}  ${String(row.diff).padStart(4)}`
    );
  }
  lines.push('-'.repeat(header.length));
  lines.push(
    `${'total'.padEnd(36)}  ${String(totalTyped).padStart(5)}  ${String(totalDispatched).padStart(10)}  ${String(totalDenied).padStart(6)}  ${String(totalFailed).padStart(6)}  ${String(totalDiff).padStart(4)}`
  );
  return lines.join('\n');
}

export async function loadLogEvents(
  paths: string[],
  since?: number,
  until?: number
): Promise<Array<LogEvent>> {
  const events: Array<LogEvent> = [];
  for (const path of paths) {
    let lineNumber = 0;
    const rl = createInterface({
      input: createReadStream(path, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      lineNumber++;
      if (line.trim().length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        process.stderr.write(`skipped ${path}:${lineNumber} (invalid JSON)\n`);
        continue;
      }
      if (isStructuredLogEvent(parsed) && isInWindow(parsed, since, until)) {
        events.push(parsed);
      } else if (!isStructuredLogEvent(parsed)) {
        process.stderr.write(`skipped ${path}:${lineNumber} (missing message field)\n`);
      }
    }
  }
  return events;
}

async function aggregateLogPaths(
  paths: string[],
  since?: number,
  until?: number
): Promise<Record<string, ActionSummary>> {
  const totals = new Map<string, ActionSummary>();
  for (const path of paths) {
    let lineNumber = 0;
    const rl = createInterface({
      input: createReadStream(path, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      lineNumber++;
      if (line.trim().length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        process.stderr.write(`skipped ${path}:${lineNumber} (invalid JSON)\n`);
        continue;
      }
      if (isStructuredLogEvent(parsed) && isInWindow(parsed, since, until)) {
        aggregateActionEvent(totals, parsed);
      } else if (!isStructuredLogEvent(parsed)) {
        process.stderr.write(`skipped ${path}:${lineNumber} (missing message field)\n`);
      }
    }
  }
  return toRecord(totals);
}

export async function runSoakSummary(options: SoakOptions): Promise<{
  exitCode: number;
  output: string;
  totals: Record<string, ActionSummary>;
}> {
  const totals = await aggregateLogPaths(options.logPaths, options.since, options.until);
  const output = options.json ? JSON.stringify(totals, null, 2) : formatSoakSummary(totals);
  const rows = Object.values(totals);
  const exitCode = rows.length === 0 || rows.some((row) => row.diff !== 0) ? 1 : 0;
  return { exitCode, output, totals };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let json = false;
  let since: number | undefined;
  let until: number | undefined;
  const logPaths: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') {
      json = true;
    } else if (arg === '--since') {
      const next = args[++i];
      if (!next) {
        process.stderr.write('usage: --since requires a timestamp\n');
        process.exit(1);
      }
      since = parseTimestamp(next);
    } else if (arg === '--until') {
      const next = args[++i];
      if (!next) {
        process.stderr.write('usage: --until requires a timestamp\n');
        process.exit(1);
      }
      until = parseTimestamp(next);
    } else if (arg.startsWith('--')) {
      process.stderr.write(`unknown option: ${arg}\n`);
      process.exit(1);
    } else {
      logPaths.push(arg);
    }
  }
  if (logPaths.length === 0) {
    process.stderr.write(
      'usage: space-actions-dispatcher-soak.ts [--json] [--since <ts>] [--until <ts>] <structured-log.ndjson>...\n'
    );
    process.exit(1);
  }
  const { exitCode, output } = await runSoakSummary({ logPaths, json, since, until });
  process.stdout.write(`${output}\n`);
  process.exit(exitCode);
}

if (import.meta.main) {
  void main();
}
