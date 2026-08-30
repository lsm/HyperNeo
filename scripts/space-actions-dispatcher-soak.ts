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

export interface SoakOptions {
  logPaths: string[];
  json?: boolean;
}

function isStructuredLogEvent(value: unknown): value is {
  message: string;
  module?: string;
  metadata?: Record<string, unknown>;
} {
  return typeof value === 'object' && value !== null && 'message' in value;
}

export function aggregateActionDispatchedTelemetry(
  events: Array<{ message: string; module?: string; metadata?: Record<string, unknown> }>
): Record<string, ActionSummary> {
  const totals: Record<string, ActionSummary> = {};
  for (const event of events) {
    if (event.message !== 'action.dispatched') continue;
    if (event.module !== 'hyperneo:daemon:space-actions.dispatch') continue;
    const action = event.metadata?.action;
    const outcome = event.metadata?.outcome;
    if (typeof action !== 'string' || typeof outcome !== 'string') continue;
    const row = totals[action] ?? { typed: 0, dispatched: 0, denied: 0, failed: 0, diff: 0 };
    row.typed++;
    if (outcome === 'dispatched') row.dispatched++;
    else if (outcome === 'denied') row.denied++;
    else if (outcome === 'failed') row.failed++;
    row.diff = row.typed - row.dispatched;
    totals[action] = row;
  }
  return totals;
}

export function formatSoakSummary(totals: Record<string, ActionSummary>): string {
  const actions = Object.keys(totals).sort();
  if (actions.length === 0) return 'No action.dispatched telemetry found.';

  const header = 'action                              typed  dispatched  denied  failed  diff';
  const lines = [header, '-'.repeat(header.length)];
  let totalTyped = 0;
  let totalDispatched = 0;
  let totalDenied = 0;
  let totalFailed = 0;
  for (const action of actions) {
    const row = totals[action];
    totalTyped += row.typed;
    totalDispatched += row.dispatched;
    totalDenied += row.denied;
    totalFailed += row.failed;
    const padded = action.padEnd(36);
    lines.push(
      `${padded}  ${String(row.typed).padStart(5)}  ${String(row.dispatched).padStart(10)}  ${String(row.denied).padStart(6)}  ${String(row.failed).padStart(6)}  ${String(row.diff).padStart(4)}`
    );
  }
  lines.push('-'.repeat(header.length));
  lines.push(
    `${'total'.padEnd(36)}  ${String(totalTyped).padStart(5)}  ${String(totalDispatched).padStart(10)}  ${String(totalDenied).padStart(6)}  ${String(totalFailed).padStart(6)}  ${String(totalTyped - totalDispatched).padStart(4)}`
  );
  return lines.join('\n');
}

export async function loadLogEvents(
  paths: string[]
): Promise<Array<{ message: string; module?: string; metadata?: Record<string, unknown> }>> {
  const events: Array<{ message: string; module?: string; metadata?: Record<string, unknown> }> =
    [];
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
      if (isStructuredLogEvent(parsed)) {
        events.push(parsed);
      } else {
        process.stderr.write(`skipped ${path}:${lineNumber} (missing message field)\n`);
      }
    }
  }
  return events;
}

export async function runSoakSummary(options: SoakOptions): Promise<{
  exitCode: number;
  output: string;
  totals: Record<string, ActionSummary>;
}> {
  const events = await loadLogEvents(options.logPaths);
  const totals = aggregateActionDispatchedTelemetry(events);
  const output = options.json ? JSON.stringify(totals, null, 2) : formatSoakSummary(totals);
  const exitCode = Object.values(totals).some((row) => row.diff !== 0) ? 1 : 0;
  return { exitCode, output, totals };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const logPaths = args.filter((arg) => arg !== '--json');
  if (logPaths.length === 0) {
    process.stderr.write(
      'usage: space-actions-dispatcher-soak.ts [--json] <structured-log.ndjson>...\n'
    );
    process.exit(1);
  }
  const { exitCode, output } = await runSoakSummary({ logPaths, json });
  process.stdout.write(`${output}\n`);
  process.exit(exitCode);
}

if (import.meta.main) {
  void main();
}
