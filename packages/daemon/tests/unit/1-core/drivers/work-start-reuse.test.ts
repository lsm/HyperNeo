import { describe, expect, test } from 'bun:test';
import { createWorkVerbOperations } from '../../../../src/lib/drivers/work-operations';
import { workStartConfiguration } from '../../../../src/lib/drivers/start-configuration';
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
    liveStatus?: WorkStatus;
    folder?: string;
    refusal?: 'not_open' | 'uncertain' | 'throws';
  }[],
  free: string[],
  config?: {
    adapter: string;
    model?: string;
    effort?: string;
    unavailable?: boolean;
    provider?: string;
    requestedProvider?: string;
    unresolvedDefault?: boolean;
  },
  history?: ReadonlyMap<string, { sameAskAt: number | null; settledAt: number | null }>
) {
  const sent: string[] = [];
  const messages: string[] = [];
  const started: string[] = [];
  const unusable: WorkRef[] = [];
  const adapter: WorkAdapter = {
    id: config?.adapter ?? 'claude-desktop',
    supportsStartEffort: true,
    resolveStartConfiguration: config
      ? async (request) => {
          if (config.unresolvedDefault) return null;
          const selected = workStartConfiguration.select(request, [
            { id: 'gpt-6.1-sol', aliases: ['Sol 6.1'], efforts: ['high', 'low'], isDefault: true },
          ]);
          return 'ok' in selected
            ? selected
            : {
                ok: true,
                value: {
                  ...selected,
                  ...(config.requestedProvider ? { provider: config.requestedProvider } : {}),
                },
              };
        }
      : undefined,
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
            ref: { adapter: config?.adapter ?? 'claude-desktop', id: worker.id },
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
    status: async (ref) =>
      config?.unavailable
        ? { ok: false, reason: 'unreachable', detail: 'offline' }
        : {
            ok: true,
            value: {
              ref,
              title: 'fixture',
              place,
              status:
                workers.find((worker) => worker.id === ref.id)?.liveStatus ??
                workers.find((worker) => worker.id === ref.id)?.status ??
                'done',
              lastActivityAt: 1,
              model: config?.model ?? 'claude-opus-5-5',
              effort: config?.effort ?? 'medium',
              ...(config?.provider ? { provider: config.provider } : {}),
            },
          },
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
      freeWorkers: () =>
        history
          ? new Map(free.map((id) => [id, history.get(id) ?? { sameAskAt: null, settledAt: null }]))
          : new Set(free),
      markUnusable: (ref) => void unusable.push(ref),
    })
  );
  const start = async (
    caller: OperationCaller = neo,
    provenance = false,
    request: { model?: string; effort?: string; excludeRefs?: WorkRef[]; todoId?: string } = {}
  ) => {
    const outcome = await invokeOperation(
      registry,
      'work.start',
      {
        adapter: config?.adapter ?? 'claude-desktop',
        place,
        title: 'loader',
        message: 'Fix the loader.',
        provenance,
        ...request,
      },
      caller
    );
    if (outcome.kind !== 'completed') throw new Error(outcome.message);
    return outcome.value as { ok: boolean; value?: { ref: WorkRef; reused?: true } };
  };
  return { start, sent, started, unusable, messages };
}

describe('work.start reuses an idle worker', () => {
  test('offers a follow-up to its most recently used same-ask worker first', async () => {
    const run = harness(
      [
        { id: 'affinity-other', status: 'done' },
        { id: 'affinity-older', status: 'done' },
        { id: 'affinity-latest', status: 'done' },
      ],
      ['affinity-other', 'affinity-older', 'affinity-latest'],
      undefined,
      new Map([
        ['affinity-other', { sameAskAt: null, settledAt: 1 }],
        ['affinity-older', { sameAskAt: 10, settledAt: null }],
        ['affinity-latest', { sameAskAt: 20, settledAt: null }],
      ])
    );
    expect((await run.start(neo, false, { todoId: 'follow-up' })).value?.ref.id).toBe(
      'affinity-latest'
    );
    expect(run.sent).toEqual(['affinity-latest']);
    expect(run.started).toEqual([]);
  });

  test('skips a busy same-ask worker and offers another free same-ask worker', async () => {
    const run = harness(
      [
        { id: 'busy-other', status: 'done' },
        { id: 'busy-latest', status: 'done', liveStatus: 'running' },
        { id: 'busy-previous', status: 'done' },
      ],
      ['busy-other', 'busy-latest', 'busy-previous'],
      undefined,
      new Map([
        ['busy-other', { sameAskAt: null, settledAt: 1 }],
        ['busy-latest', { sameAskAt: 30, settledAt: null }],
        ['busy-previous', { sameAskAt: 20, settledAt: null }],
      ])
    );
    expect((await run.start(neo, false, { todoId: 'busy-follow-up' })).value?.ref.id).toBe(
      'busy-previous'
    );
    expect(run.sent).toEqual(['busy-previous']);
  });

  test('for a different ask prefers the worker whose latest ask settled longest ago', async () => {
    const run = harness(
      [
        { id: 'settled-recent', status: 'done' },
        { id: 'settled-unknown', status: 'done' },
        { id: 'settled-oldest', status: 'done' },
      ],
      ['settled-recent', 'settled-unknown', 'settled-oldest'],
      undefined,
      new Map([
        ['settled-recent', { sameAskAt: null, settledAt: 500 }],
        ['settled-oldest', { sameAskAt: null, settledAt: 100 }],
      ])
    );
    expect((await run.start(neo, false, { todoId: 'different-ask' })).value?.ref.id).toBe(
      'settled-oldest'
    );
    expect(run.started).toEqual([]);
  });

  test('an excluded author cannot win same-ask affinity over an independent reviewer', async () => {
    const run = harness(
      [
        { id: 'independence-author', status: 'done' },
        { id: 'independence-other', status: 'done' },
        { id: 'independence-reviewer', status: 'done' },
      ],
      ['independence-author', 'independence-other', 'independence-reviewer'],
      undefined,
      new Map([
        ['independence-author', { sameAskAt: 30, settledAt: null }],
        ['independence-other', { sameAskAt: null, settledAt: 1 }],
        ['independence-reviewer', { sameAskAt: 20, settledAt: null }],
      ])
    );
    const result = await run.start(neo, false, {
      todoId: 'review-follow-up',
      excludeRefs: [{ adapter: 'claude-desktop', id: 'independence-author' }],
    });
    expect(result.value?.ref.id).toBe('independence-reviewer');
    expect(run.sent).toEqual(['independence-reviewer']);
  });

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

  test('reuses a just-finished native worker despite a recent running discovery summary', async () => {
    const run = harness(
      [{ id: 'recent-native', status: 'running', liveStatus: 'done' }],
      ['recent-native'],
      { adapter: 'codex-desktop' }
    );
    expect((await run.start()).value?.ref.id).toBe('recent-native');
    expect(run.sent).toEqual(['recent-native']);
    expect(run.started).toEqual([]);
  });

  test('does not reuse a worker that became busy after its idle discovery summary', async () => {
    const run = harness(
      [{ id: 'newly-busy', status: 'done', liveStatus: 'running' }],
      ['newly-busy']
    );
    expect((await run.start()).value?.ref.id).toBe('fresh');
    expect(run.sent).toEqual([]);
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

describe('work.start configured reuse', () => {
  test.each(['codex-desktop', 'hyperneo'])(
    'resolves aliases before reusing %s',
    async (adapter) => {
      const id = `configured-${adapter}`;
      const run = harness([{ id, status: 'done' }], [id], {
        adapter,
        model: 'gpt-6.1-sol',
        effort: 'high',
      });
      expect(
        (await run.start(neo, true, { model: 'Sol 6.1', effort: ' HIGH ' })).value?.reused
      ).toBe(true);
      expect(run.sent).toEqual([id]);
      expect(run.started).toEqual([]);
      expect(run.messages[0]).toContain('Agent: gpt-6.1-sol (effort: high)');
    }
  );
  test.each([
    { model: 'gpt-other', effort: 'high' },
    { model: 'gpt-6.1-sol', effort: 'low' },
    { model: 'gpt-6.1-sol', effort: 'high', unavailable: true },
  ])('starts fresh for a mismatched or unknown identity: %j', async (identity) => {
    const run = harness([{ id: 'mismatch', status: 'done' }], ['mismatch'], {
      adapter: 'codex-desktop',
      ...identity,
    });
    expect((await run.start(neo, false, { model: 'Sol 6.1', effort: 'high' })).value?.ref.id).toBe(
      'fresh'
    );
    expect(run.sent).toEqual([]);
  });
  test('does not bypass unsupported configuration through reuse', async () => {
    const run = harness([{ id: 'invalid', status: 'done' }], ['invalid'], {
      adapter: 'codex-desktop',
    });
    expect((await run.start(neo, false, { model: 'unknown' })).ok).toBe(false);
    expect(run.sent).toEqual([]);
    expect(run.started).toEqual([]);
  });
});

describe('work.start provider-aware reuse', () => {
  test.each(['selected', 'other', undefined])(
    'requires the resolved provider to be confirmed: %s',
    async (provider) => {
      const id = `provider-${provider}`;
      const run = harness([{ id, status: 'done' }], [id], {
        adapter: 'hyperneo',
        model: 'gpt-6.1-sol',
        effort: 'high',
        provider,
        requestedProvider: 'selected',
      });
      const result = await run.start(neo, false, { model: 'Sol 6.1', effort: 'high' });
      expect(result.value?.ref.id).toBe(provider === 'selected' ? id : 'fresh');
      expect(run.sent).toEqual(provider === 'selected' ? [id] : []);
    }
  );
});

describe('work.start effort-only reuse', () => {
  test.each([
    { model: 'gpt-6.1-sol', unresolvedDefault: false, reuse: true },
    { model: 'other-default', unresolvedDefault: false, reuse: false },
    { model: 'gpt-6.1-sol', unresolvedDefault: true, reuse: false },
  ])(
    'matches the effective model or starts fresh when unconfirmed: %j',
    async ({ model, unresolvedDefault, reuse }) => {
      const id = `effort-only-${model}-${unresolvedDefault}`;
      const run = harness([{ id, status: 'done' }], [id], {
        adapter: 'hyperneo',
        model,
        effort: 'high',
        unresolvedDefault,
      });
      expect((await run.start(neo, false, { effort: 'high' })).value?.ref.id).toBe(
        reuse ? id : 'fresh'
      );
      expect(run.sent).toEqual(reuse ? [id] : []);
    }
  );
});

describe('work.start independent worker reuse', () => {
  test('excludes the author before delivery and reuses another idle worker', async () => {
    const run = harness(
      [
        { id: 'pr-author', status: 'done' },
        { id: 'prior-reviewer', status: 'done' },
      ],
      ['pr-author', 'prior-reviewer']
    );
    const result = await run.start(neo, false, {
      excludeRefs: [{ adapter: 'claude-desktop', id: 'pr-author' }],
    });
    expect(result.value?.ref.id).toBe('prior-reviewer');
    expect(run.sent).toEqual(['prior-reviewer']);
  });
});

describe('work.start remote actor exclusions', () => {
  test('qualifies exclusions for the destination before forwarding a start', async () => {
    const forwarded: unknown[] = [];
    const registry = createOperationRegistry(
      createWorkVerbOperations({
        adapters: () => [],
        daemonName: 'local',
        remote: {
          list: () => [{ daemonId: 'peer' }],
          invoke: async (_daemon, _name, input) => {
            forwarded.push(input);
            return {
              ok: true,
              value: {
                ref: { adapter: 'codex-desktop', id: 'new' },
                place,
                title: 'task',
                status: 'running',
                lastActivityAt: 1,
              },
            };
          },
        },
      })
    );
    const result = await invokeOperation(
      registry,
      'work.start',
      {
        adapter: 'codex-desktop',
        place: { ...place, daemon: 'peer' },
        title: 'review',
        message: 'review',
        excludeRefs: [
          { adapter: 'codex-desktop', id: 'author', daemon: 'peer' },
          { adapter: 'codex-desktop', id: 'local-author' },
          { adapter: 'codex-desktop', id: 'elsewhere', daemon: 'other' },
        ],
      },
      neo
    );
    expect(result).toMatchObject({ kind: 'completed', value: { ok: true } });
    expect(forwarded[0]).toMatchObject({
      excludeRefs: [{ adapter: 'codex-desktop', id: 'author' }],
    });
  });
});
