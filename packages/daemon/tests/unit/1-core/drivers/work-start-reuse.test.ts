import { describe, expect, test } from 'bun:test';
import { createWorkVerbOperations } from '../../../../src/lib/drivers/work-operations';
import type { WorkAdapter, WorkRef, WorkStatus } from '../../../../src/lib/drivers/types';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry';
import { invokeOperation } from '../../../../src/lib/operations/invoke';

const place = { machine: 'imac', folder: '/focus/dolmen', name: 'dolmen' };
const neo: OperationCaller = { source: 'internal', sessionId: 'neo', role: 'neo' };

function harness(
  workers: {
    id: string;
    status: WorkStatus;
    folder?: string;
    refusal?: 'not_open' | 'uncertain' | 'throws';
  }[],
  free: string[]
) {
  const sent: string[] = [];
  const messages: string[] = [];
  const started: string[] = [];
  const unusable: WorkRef[] = [];
  const adapter: WorkAdapter = {
    id: 'claude-desktop',
    capabilities: ['find', 'start', 'send'],
    find: (query) => [
      {
        place,
        lastActivityAt: 1,
        openCount: workers.length,
        archivedCount: 0,
        adapters: ['claude-desktop'],
        work: workers
          .filter((worker) => (worker.folder ?? place.folder) === query.folder)
          .map((worker) => ({
            ref: { adapter: 'claude-desktop', id: worker.id },
            title: worker.id,
            place: { ...place, folder: worker.folder ?? place.folder },
            status: worker.status,
            lastActivityAt: 1,
          })),
      },
    ],
    start: async (request) => {
      started.push(request.title);
      return {
        ok: true,
        value: {
          ref: { adapter: 'claude-desktop', id: 'fresh' },
          title: request.title,
          place,
          status: 'running',
          lastActivityAt: 2,
        },
      };
    },
    status: async (ref) => ({
      ok: true,
      value: {
        ref,
        title: 'fixture',
        place,
        status: 'done',
        lastActivityAt: 1,
        model: 'claude-opus-5-5',
        effort: 'medium',
      },
    }),
    send: async (ref, message) => {
      messages.push(message);
      sent.push(ref.id);
      await Promise.resolve();
      const refusal = workers.find((worker) => worker.id === ref.id)?.refusal;
      if (refusal === 'throws') throw new Error('synthetic transport fault');
      if (refusal === 'uncertain') return { ok: false, reason: 'not_delivered', detail: 'unknown' };
      return refusal
        ? { ok: false, reason: 'not_open', detail: 'archived', notSent: true }
        : { ok: true, value: { delivered: true, receipt: { executionId: 'e', inputId: 'i' } } };
    },
  };
  const registry = createOperationRegistry(
    createWorkVerbOperations({
      adapters: () => [adapter],
      remote: { list: () => [], invoke: async () => ({}) },
      daemonName: 'imac',
      freeWorkers: () => new Set(free),
      markUnusable: (ref) => void unusable.push(ref),
    })
  );
  const start = async (caller: OperationCaller = neo, provenance = false) => {
    const outcome = await invokeOperation(
      registry,
      'work.start',
      { adapter: 'claude-desktop', place, title: 'loader', message: 'Fix the loader.', provenance },
      caller
    );
    if (outcome.kind !== 'completed') throw new Error(outcome.message);
    return outcome.value as { ok: boolean; value?: { ref: WorkRef; reused?: true } };
  };
  return { start, sent, started, unusable, messages };
}

describe('work.start reuses an idle worker', () => {
  test('sends to an idle free worker in the same place instead of starting one', async () => {
    const run = harness([{ id: 'idle', status: 'done' }], ['idle']);
    const result = await run.start();
    expect(result.ok).toBe(true);
    expect(result.value?.ref.id).toBe('idle');
    expect(result.value?.reused).toBe(true);
    expect(run.sent).toEqual(['idle']);
    expect(run.started).toEqual([]);
  });

  test('refreshes identity before delivering a new todo to a reused worker', async () => {
    const run = harness([{ id: 'provenance-idle', status: 'done' }], ['provenance-idle']);
    expect((await run.start(neo, true)).value?.reused).toBe(true);
    expect(run.messages[0]).toContain('Agent: claude-opus-5-5 (effort: medium) via Claude');
  });

  test('starts a new worker when the only same-place worker is busy', async () => {
    const run = harness([{ id: 'busy', status: 'running' }], ['busy']);
    const result = await run.start();
    expect(result.value?.ref.id).toBe('fresh');
    expect(result.value?.reused).toBeUndefined();
    expect(run.sent).toEqual([]);
  });

  test('skips a worker that holds an open todo or sits in another folder', async () => {
    const run = harness(
      [
        { id: 'leased', status: 'done' },
        { id: 'elsewhere', status: 'done', folder: '/focus/other' },
      ],
      ['elsewhere']
    );
    expect((await run.start()).value?.ref.id).toBe('fresh');
    expect(run.sent).toEqual([]);
  });

  test('marks a worker unusable when the send proves not delivered, then starts fresh', async () => {
    const run = harness([{ id: 'gone', status: 'done', refusal: 'not_open' }], ['gone']);
    const result = await run.start();
    expect(result.value?.ref.id).toBe('fresh');
    expect(run.unusable).toEqual([{ adapter: 'claude-desktop', id: 'gone' }]);
  });

  test('two concurrent starts never send to the same idle worker', async () => {
    const run = harness([{ id: 'raced', status: 'done' }], ['raced']);
    const results = await Promise.all([run.start(), run.start()]);
    expect(results.map((result) => result.value?.ref.id).sort()).toEqual(['fresh', 'raced']);
    expect(run.sent).toEqual(['raced']);
  });

  test('an uncertain send marks the worker for reconciliation and starts nothing new', async () => {
    const run = harness([{ id: 'maybe', status: 'done', refusal: 'uncertain' }], ['maybe']);
    const result = await run.start();
    expect(result.ok).toBe(false);
    expect(run.started).toEqual([]);
    expect(run.unusable).toEqual([{ adapter: 'claude-desktop', id: 'maybe' }]);
  });

  test('a send that throws releases its hold so the worker stays reusable', async () => {
    const workers: Parameters<typeof harness>[0] = [
      { id: 'flaky', status: 'done', refusal: 'throws' },
    ];
    const run = harness(workers, ['flaky']);
    await expect(run.start()).rejects.toThrow();
    delete workers[0].refusal;
    expect((await run.start()).value?.ref.id).toBe('flaky');
  });

  test('the human starting work always gets a new session', async () => {
    const run = harness([{ id: 'idle', status: 'done' }], ['idle']);
    expect((await run.start({ source: 'rpc' })).value?.ref.id).toBe('fresh');
    expect(run.sent).toEqual([]);
  });
});
