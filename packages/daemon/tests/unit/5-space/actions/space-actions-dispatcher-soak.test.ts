import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  aggregateActionDispatchedTelemetry,
  formatSoakSummary,
  loadLogEvents,
  runSoakSummary,
} from '../../../../../../scripts/space-actions-dispatcher-soak.ts';

describe('aggregateActionDispatchedTelemetry', () => {
  it('counts typed, dispatched, denied, and failed per action', () => {
    const events = [
      {
        message: 'action.dispatched',
        module: 'hyperneo:daemon:space-actions.dispatch',
        metadata: { action: 'list_sessions', outcome: 'dispatched' },
      },
      {
        message: 'action.dispatched',
        module: 'hyperneo:daemon:space-actions.dispatch',
        metadata: { action: 'list_sessions', outcome: 'dispatched' },
      },
      {
        message: 'action.dispatched',
        module: 'hyperneo:daemon:space-actions.dispatch',
        metadata: { action: 'update_task', outcome: 'denied' },
      },
      {
        message: 'action.dispatched',
        module: 'hyperneo:daemon:space-actions.dispatch',
        metadata: { action: 'update_task', outcome: 'failed' },
      },
      {
        message: 'unrelated',
        module: 'hyperneo:daemon:space-actions.dispatch',
        metadata: { action: 'update_task', outcome: 'failed' },
      },
    ];

    const totals = aggregateActionDispatchedTelemetry(events);
    expect(totals['list_sessions']).toEqual({
      typed: 2,
      dispatched: 2,
      denied: 0,
      failed: 0,
      diff: 0,
    });
    expect(totals['update_task']).toEqual({
      typed: 2,
      dispatched: 0,
      denied: 1,
      failed: 1,
      diff: 2,
    });
  });

  it('ignores events missing action or outcome metadata', () => {
    const events = [
      {
        message: 'action.dispatched',
        module: 'hyperneo:daemon:space-actions.dispatch',
        metadata: { outcome: 'dispatched' },
      },
      {
        message: 'action.dispatched',
        module: 'hyperneo:daemon:space-actions.dispatch',
        metadata: { action: 'list_sessions' },
      },
    ];

    expect(aggregateActionDispatchedTelemetry(events)).toEqual({});
  });
});

describe('formatSoakSummary', () => {
  it('renders a table with typed, dispatched, denied, failed and diff columns', () => {
    const totals = {
      list_sessions: { typed: 2, dispatched: 2, denied: 0, failed: 0, diff: 0 },
      update_task: { typed: 3, dispatched: 1, denied: 1, failed: 1, diff: 2 },
    };

    const summary = formatSoakSummary(totals);
    expect(summary).toContain('list_sessions');
    expect(summary).toContain('update_task');
    expect(summary).toContain('typed');
    expect(summary).toContain('dispatched');
    expect(summary).toContain('denied');
    expect(summary).toContain('failed');
    expect(summary).toContain('diff');
    expect(summary).toMatch(/2\s+2\s+0\s+0\s+0/);
    expect(summary).toMatch(/3\s+1\s+1\s+1\s+2/);
  });

  it('reports when no telemetry is found', () => {
    expect(formatSoakSummary({})).toBe('No action.dispatched telemetry found.');
  });
});

describe('loadLogEvents', () => {
  it('reads ndjson log files and skips invalid lines', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'soak-'));
    try {
      const path = join(dir, 'log.ndjson');
      writeFileSync(
        path,
        '{"message":"action.dispatched","module":"hyperneo:daemon:space-actions.dispatch","metadata":{"action":"list_sessions","outcome":"dispatched"}}\n' +
          'not-json\n' +
          '{"message":"action.dispatched","module":"hyperneo:daemon:space-actions.dispatch","metadata":{"action":"update_task","outcome":"denied"}}\n'
      );

      const events = await loadLogEvents([path]);
      expect(events).toHaveLength(2);
      expect(events[0].metadata).toEqual({ action: 'list_sessions', outcome: 'dispatched' });
      expect(events[1].metadata).toEqual({ action: 'update_task', outcome: 'denied' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runSoakSummary', () => {
  it('returns exit code 1 when any action has a diff', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'soak-'));
    try {
      const path = join(dir, 'log.ndjson');
      writeFileSync(
        path,
        '{"message":"action.dispatched","module":"hyperneo:daemon:space-actions.dispatch","metadata":{"action":"update_task","outcome":"denied"}}\n'
      );

      const { exitCode, totals } = await runSoakSummary({ logPaths: [path] });
      expect(exitCode).toBe(1);
      expect(totals['update_task'].diff).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns exit code 0 when every call was dispatched', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'soak-'));
    try {
      const path = join(dir, 'log.ndjson');
      writeFileSync(
        path,
        '{"message":"action.dispatched","module":"hyperneo:daemon:space-actions.dispatch","metadata":{"action":"list_sessions","outcome":"dispatched"}}\n'
      );

      const { exitCode, totals } = await runSoakSummary({ logPaths: [path] });
      expect(exitCode).toBe(0);
      expect(totals['list_sessions'].diff).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
