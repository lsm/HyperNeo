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

const typedEvent = (action: string, timestamp?: number) => ({
  message: 'action.typed',
  module: 'hyperneo:daemon:space-actions.typed',
  metadata: { action },
  timestamp,
});

const dispatchedEvent = (action: string, outcome: string, timestamp?: number) => ({
  message: 'action.dispatched',
  module: 'hyperneo:daemon:space-actions.dispatch',
  metadata: { action, outcome },
  timestamp,
});

describe('aggregateActionDispatchedTelemetry', () => {
  it('counts typed, dispatched, denied, and failed per action', () => {
    const events = [
      typedEvent('list_sessions'),
      typedEvent('list_sessions'),
      dispatchedEvent('list_sessions', 'dispatched'),
      dispatchedEvent('list_sessions', 'dispatched'),
      typedEvent('update_task'),
      dispatchedEvent('update_task', 'denied'),
      dispatchedEvent('update_task', 'failed'),
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
      diff: 2,
    });
    expect(totals['update_task']).toEqual({
      typed: 1,
      dispatched: 0,
      denied: 1,
      failed: 1,
      diff: 3,
    });
  });

  it('keeps the diff nonzero when dispatched calls coexist with typed fallbacks', () => {
    const events = [
      typedEvent('list_sessions'),
      typedEvent('list_sessions'),
      dispatchedEvent('list_sessions', 'dispatched'),
      dispatchedEvent('list_sessions', 'dispatched'),
      dispatchedEvent('list_sessions', 'dispatched'),
    ];

    const totals = aggregateActionDispatchedTelemetry(events);
    expect(totals['list_sessions']).toEqual({
      typed: 2,
      dispatched: 3,
      denied: 0,
      failed: 0,
      diff: 2,
    });
  });

  it('treats action names like __proto__ as untrusted map keys', () => {
    const events = [typedEvent('__proto__'), dispatchedEvent('__proto__', 'denied')];

    const totals = aggregateActionDispatchedTelemetry(events);
    expect(totals['__proto__']).toEqual({
      typed: 1,
      dispatched: 0,
      denied: 1,
      failed: 0,
      diff: 2,
    });
    expect(Object.keys(totals)).toEqual(['__proto__']);
    expect(Object.values(totals)).toHaveLength(1);
  });

  it('treats unrecognized dispatcher outcomes as failed', () => {
    const events = [
      dispatchedEvent('list_sessions', 'success'),
      dispatchedEvent('update_task', 'dispatched'),
    ];

    const totals = aggregateActionDispatchedTelemetry(events);
    expect(totals['list_sessions']).toEqual({
      typed: 0,
      dispatched: 0,
      denied: 0,
      failed: 1,
      diff: 1,
    });
    expect(totals['update_task']).toEqual({
      typed: 0,
      dispatched: 1,
      denied: 0,
      failed: 0,
      diff: 0,
    });
  });

  it('ignores events missing action or outcome metadata', () => {
    const events = [
      {
        message: 'action.typed',
        module: 'hyperneo:daemon:space-actions.typed',
        metadata: { role: 'coordinator' },
      },
      {
        message: 'action.dispatched',
        module: 'hyperneo:daemon:space-actions.dispatch',
        metadata: { action: 'list_sessions' },
      },
      {
        message: 'action.dispatched',
        module: 'hyperneo:daemon:space-actions.dispatch',
        metadata: { outcome: 'dispatched' },
      },
    ];

    expect(aggregateActionDispatchedTelemetry(events)).toEqual({});
  });
});

describe('formatSoakSummary', () => {
  it('renders a table with typed, dispatched, denied, failed and diff columns', () => {
    const totals = {
      list_sessions: { typed: 2, dispatched: 2, denied: 0, failed: 0, diff: 2 },
      update_task: { typed: 3, dispatched: 1, denied: 1, failed: 1, diff: 5 },
    };

    const summary = formatSoakSummary(totals);
    expect(summary).toContain('list_sessions');
    expect(summary).toContain('update_task');
    expect(summary).toContain('typed');
    expect(summary).toContain('dispatched');
    expect(summary).toContain('denied');
    expect(summary).toContain('failed');
    expect(summary).toContain('diff');
    expect(summary).toMatch(/2\s+2\s+0\s+0\s+2/);
    expect(summary).toMatch(/3\s+1\s+1\s+1\s+5/);
  });

  it('reports when no telemetry is found', () => {
    expect(formatSoakSummary({})).toBe('No action telemetry found.');
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

  it('filters events by timestamp when since and until are provided', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'soak-'));
    try {
      const path = join(dir, 'log.ndjson');
      const lines =
        [
          JSON.stringify(typedEvent('list_sessions', 500)),
          JSON.stringify(dispatchedEvent('list_sessions', 'dispatched', 1500)),
          JSON.stringify(dispatchedEvent('update_task', 'denied', 2500)),
        ].join('\n') + '\n';
      writeFileSync(path, lines);

      const events = await loadLogEvents([path], 1000, 2000);
      expect(events).toHaveLength(1);
      expect(events[0].metadata).toEqual({ action: 'list_sessions', outcome: 'dispatched' });
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

  it('returns exit code 1 when the log window is empty', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'soak-'));
    try {
      const path = join(dir, 'log.ndjson');
      writeFileSync(path, '');

      const { exitCode, totals } = await runSoakSummary({ logPaths: [path] });
      expect(exitCode).toBe(1);
      expect(Object.keys(totals)).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('only counts events within the requested time window', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'soak-'));
    try {
      const path = join(dir, 'log.ndjson');
      const lines =
        [
          JSON.stringify(typedEvent('list_sessions', 500)),
          JSON.stringify(typedEvent('list_sessions', 1500)),
          JSON.stringify(dispatchedEvent('list_sessions', 'dispatched', 1500)),
          JSON.stringify(dispatchedEvent('update_task', 'denied', 2500)),
        ].join('\n') + '\n';
      writeFileSync(path, lines);

      const { exitCode, totals } = await runSoakSummary({
        logPaths: [path],
        since: 1000,
        until: 2000,
      });
      expect(exitCode).toBe(1);
      expect(totals['list_sessions']).toEqual({
        typed: 1,
        dispatched: 1,
        denied: 0,
        failed: 0,
        diff: 1,
      });
      expect(totals['update_task']).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
