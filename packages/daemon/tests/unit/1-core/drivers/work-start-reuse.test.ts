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
    hiddenFromFind?: boolean;
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
  owned: string[] = [],
  bound: string[] = owned
) {
  const sent: string[] = [];
  const messages: string[] = [];
  const started: string[] = [];
  const unusable: WorkRef[] = [];
  const recorded: { ref: WorkRef; todoId?: string }[] = [];
  const adapter: WorkAdapter = {
    id: config?.adapter ?? 'claude-desktop',
    supportsStartEffort: true,
    supportsStartPreparation: true,
    resolveStartConfiguration: config
      ? async (request) => {
          if (config.unresolvedDefault && !request.model) return null;
          const selected = workStartConfiguration.select(request, [
            { id: 'gpt-6.1-sol', aliases: ['Sol 6.1'], efforts: ['high', 'low'], isDefault: true },
            { id: 'older-model', efforts: ['high', 'low'] },
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
          .filter(
            (worker) => !worker.hiddenFromFind && (worker.folder ?? place.folder) === query.folder
          )
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
    status: async (ref) => {
      const worker = workers.find((worker) => worker.id === ref.id);
      return config?.unavailable
        ? { ok: false, reason: 'unreachable', detail: 'offline' }
        : {
            ok: true,
            value: {
              ref,
              title: 'fixture',
              place: { ...place, folder: worker?.folder ?? place.folder },
              status: worker?.liveStatus ?? worker?.status ?? 'done',
              lastActivityAt: 1,
              model: config?.model ?? 'claude-opus-5-5',
              effort: config?.effort ?? 'medium',
              ...(config?.provider ? { provider: config.provider } : {}),
            },
          };
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
      freeWorkers: () => new Set(free),
      ...{ askWorkers: () => new Set(owned), boundWorkers: () => new Set(bound) },
      recordStarted: (ref: WorkRef, input?: { todoId?: string }) =>
        void recorded.push({ ref, todoId: input?.todoId }),
      markUnusable: (ref) => void unusable.push(ref),
    })
  );
  const start = async (
    caller: OperationCaller = neo,
    provenance = false,
    request: {
      model?: string;
      effort?: string;
      excludeRefs?: WorkRef[];
      todoId?: string;
      preparation?: { pack: string; parameters: Record<string, unknown> };
    } = {}
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
  return { start, sent, started, unusable, messages, recorded };
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

describe('matter-bound reuse through work.start', () => {
  test('uses its own idle worker before a free worker from another matter', async () => {
    const run = harness(
      [
        { id: 'spare-matter', status: 'done' },
        { id: 'own-idle', status: 'done' },
      ],
      ['spare-matter'],
      undefined,
      ['own-idle']
    );
    expect((await run.start(neo, false, { todoId: 'next-in-A' })).value?.ref.id).toBe('own-idle');
    expect(run.recorded).toEqual([
      { ref: { adapter: 'claude-desktop', id: 'own-idle' }, todoId: 'next-in-A' },
    ]);
  });
  test('uses the most recently used same-ask worker in the supplied ownership order', async () => {
    const run = harness(
      [
        { id: 'old-own', status: 'done' },
        { id: 'latest-own', status: 'done' },
      ],
      [],
      undefined,
      ['latest-own', 'old-own']
    );
    expect((await run.start(neo, false, { todoId: 'next-A' })).value?.ref.id).toBe('latest-own');
  });
  test('starts a new worker when all its own workers are busy, even if another matter has a spare', async () => {
    const run = harness(
      [
        { id: 'own-busy', status: 'running' },
        { id: 'other-spare', status: 'done' },
      ],
      ['other-spare'],
      undefined,
      ['own-busy']
    );
    expect((await run.start(neo, false, { todoId: 'busy-A-next' })).value?.ref.id).toBe('fresh');
    expect(run.recorded).toEqual([
      { ref: { adapter: 'claude-desktop', id: 'fresh' }, todoId: 'busy-A-next' },
    ]);
  });
  test('different-matter reuse follows longest-settled order instead of discovery order', async () => {
    const run = harness(
      [
        { id: 'recent-free', status: 'done' },
        { id: 'long-free', status: 'done' },
      ],
      ['long-free', 'recent-free']
    );
    expect((await run.start()).value?.ref.id).toBe('long-free');
  });
  test('keeps the same-ask model when none was explicitly requested', async () => {
    const run = harness(
      [{ id: 'same-old-model', status: 'done' }],
      [],
      { adapter: 'hyperneo', model: 'older-model', effort: 'high' },
      ['same-old-model']
    );
    expect((await run.start(neo, false, { todoId: 'same-model-A' })).value?.ref.id).toBe(
      'same-old-model'
    );
  });
  test('effort-only same-ask reuse resolves against that workers model, not the current default', async () => {
    const run = harness(
      [{ id: 'same-effort-old', status: 'done' }],
      [],
      { adapter: 'hyperneo', model: 'older-model', effort: 'high', unresolvedDefault: true },
      ['same-effort-old']
    );
    expect(
      (await run.start(neo, false, { todoId: 'same-effort-A', effort: 'high' })).value?.ref.id
    ).toBe('same-effort-old');
  });
  test('finds a long-lived owned worker even outside the recent discovery page', async () => {
    const run = harness(
      [
        { id: 'months-old', status: 'done', hiddenFromFind: true },
        { id: 'recent-foreign', status: 'done' },
      ],
      ['recent-foreign'],
      undefined,
      ['months-old']
    );
    expect((await run.start(neo, false, { todoId: 'next-month' })).value?.ref.id).toBe(
      'months-old'
    );
    expect(run.sent).toEqual(['months-old']);
    expect(run.started).toEqual([]);
  });

  test('a busy owned worker outside recent discovery still requires a new worker', async () => {
    const run = harness(
      [
        { id: 'old-busy', status: 'running', hiddenFromFind: true },
        { id: 'free-foreign', status: 'done' },
      ],
      ['free-foreign'],
      undefined,
      ['old-busy']
    );
    expect((await run.start(neo, false, { todoId: 'next-busy' })).value?.ref.id).toBe('fresh');
    expect(run.sent).toEqual([]);
  });

  test('ownership in another folder does not borrow that worker', async () => {
    const run = harness(
      [
        { id: 'other-folder', status: 'done', folder: '/elsewhere' },
        { id: 'same-folder-free', status: 'done' },
      ],
      ['same-folder-free'],
      undefined,
      ['other-folder']
    );
    expect((await run.start(neo, false, { todoId: 'folder-step' })).value?.ref.id).toBe(
      'same-folder-free'
    );
    expect(run.sent).toEqual(['same-folder-free']);
  });

  test('starts fresh when its bound worker is unavailable rather than borrowing another matter', async () => {
    const run = harness(
      [
        { id: 'unavailable-owned', status: 'done' },
        { id: 'free-other-matter', status: 'done' },
      ],
      ['free-other-matter'],
      undefined,
      [],
      ['unavailable-owned']
    );
    expect((await run.start(neo, false, { todoId: 'unavailable-next' })).value?.ref.id).toBe(
      'fresh'
    );
    expect(run.sent).toEqual([]);
  });

  test('reserves a worker for this ask before a delivery with an unknown outcome', async () => {
    const run = harness(
      [{ id: 'uncertain-matter', status: 'done', refusal: 'uncertain' }],
      ['uncertain-matter']
    );
    expect((await run.start(neo, false, { todoId: 'uncertain-A' })).ok).toBe(false);
    expect(run.started).toEqual([]);
    expect(run.recorded).toEqual([
      { ref: { adapter: 'claude-desktop', id: 'uncertain-matter' }, todoId: 'uncertain-A' },
    ]);
  });

  test('an explicit model still refuses an unequal same-ask identity', async () => {
    const run = harness(
      [{ id: 'explicit-same-old', status: 'done' }],
      [],
      { adapter: 'hyperneo', model: 'older-model', effort: 'high' },
      ['explicit-same-old']
    );
    expect(
      (await run.start(neo, false, { todoId: 'explicit-A', model: 'Sol 6.1' })).value?.ref.id
    ).toBe('fresh');
  });
  test.each(['review', 'verify'])('%s preparation always starts a distinct actor', async (role) => {
    const run = harness([{ id: 'author-' + role, status: 'done' }], [], undefined, [
      'author-' + role,
    ]);
    expect(
      (
        await run.start(neo, false, {
          todoId: 'role-A',
          preparation: { pack: 'coding', parameters: { role } },
        })
      ).value?.ref.id
    ).toBe('fresh');
    expect(run.sent).toEqual([]);
  });
});
