import { describe, expect, test } from 'bun:test';
import { workStartConfiguration } from '../../../../src/lib/drivers/start-configuration';
import type {
  WorkAdapter,
  WorkRef,
  WorkStatus,
  WorkTurnQuestion,
} from '../../../../src/lib/drivers/types';
import {
  createWorkVerbOperations,
  type WorkVerbDeps,
} from '../../../../src/lib/drivers/work-operations';
import { invokeOperation } from '../../../../src/lib/operations/invoke';
import { createOperationRpcHandler } from '../../../../src/lib/operations/rpc-adapter';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry';

const place = { machine: 'imac', folder: '/focus/dolmen', name: 'dolmen' };
const neo: OperationCaller = { source: 'internal', sessionId: 'neo', role: 'neo' };

function harness(
  workers: {
    id: string;
    status: WorkStatus;
    liveStatus?: WorkStatus;
    workerTemplate?: string;
    copilotClient?: 'cli' | 'desktop';
    turnQuestion?: WorkTurnQuestion;
    folder?: string;
    refusal?: 'not_open' | 'uncertain' | 'throws';
  }[],
  free: string[],
  config?: {
    adapter: string;
    model?: string;
    effort?: string;
    unavailable?: boolean;
    statusThrows?: boolean;
    waitResult?: 'none' | 'instruction';
    provider?: string;
    requestedProvider?: string;
    unresolvedDefault?: boolean;
    reuse?: 'long_lived' | 'per_ask' | 'per_todo';
    sameAsk?: string[];
    reconfigure?: 'applies' | 'refused' | 'unchanged';
    compact?: boolean | 'throws' | 'unconfirmed';
    copilotClients?: WorkAdapter['copilotClients'];
  },
  history?: ReadonlyMap<string, { sameAskAt: number | null; settledAt: number | null }>,
  claim?: Pick<WorkVerbDeps, 'claimWorker' | 'unclaimWorker' | 'isOpenTodo'>,
  recorded?: Record<string, { model?: string; effort?: string }>
) {
  const sent: string[] = [];
  const events: string[] = [];
  const messages: string[] = [];
  const started: string[] = [];
  const unusable: WorkRef[] = [];
  const waiting: string[] = [];
  const compaction = config && 'compact' in config ? config.compact : true;
  const adapter: WorkAdapter = {
    id: config?.adapter ?? 'claude-desktop',
    copilotClients: config?.copilotClients,
    supportsStartEffort: true,
    identity: { fixedProvider: 'anthropic', configurable: !recorded },
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
    reconfigure: config?.reconfigure
      ? async (_ref, settings) => {
          if (config.reconfigure === 'refused') return false;
          if (config.reconfigure === 'applies') {
            config.model = settings.model ?? config.model;
            config.effort = settings.effort ?? config.effort;
            config.provider = settings.provider ?? config.provider;
          }
          return true;
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
            copilotClient: worker.copilotClient,
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
      if (config?.statusThrows) throw new Error('Synthetic status failure');
      return config?.unavailable
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
              turnQuestion: workers.find((worker) => worker.id === ref.id)?.turnQuestion,
              lastActivityAt: 1,
              model: config?.model ?? (config ? 'gpt-6.1-sol' : 'claude-opus-5-5'),
              effort: config?.effort ?? (config ? 'high' : 'medium'),
              ...(config?.provider ? { provider: config.provider } : {}),
            },
          };
    },
    compact:
      compaction === undefined
        ? undefined
        : async (ref) => {
            events.push(`compact ${ref.id}`);
            if (compaction === 'throws') throw new Error('Synthetic compaction failure');
            if (compaction === 'unconfirmed') return { ok: true, value: { compacted: false } };
            return compaction
              ? { ok: true, value: { compacted: true } }
              : { ok: false, reason: 'busy', detail: 'Synthetic refusal' };
          },
    send: async (ref, message) => {
      messages.push(message);
      events.push(`send ${ref.id}`);
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
      startedIdentity: async (ref) => recorded?.[ref.id] ?? null,
      remote: { list: () => [], invoke: async () => ({}) },
      daemonName: 'imac',
      freeWorkers: () =>
        history
          ? new Map(free.map((id) => [id, history.get(id) ?? { sameAskAt: null, settledAt: null }]))
          : new Set(free),
      workerTemplate: (ref) => workers.find(({ id }) => id === ref.id)?.workerTemplate,
      markUnusable: (ref) => void unusable.push(ref),
      ...{
        reusePolicy: async () => ({
          mode: config?.reuse ?? 'long_lived',
          sameAsk: config?.reuse
            ? (config.sameAsk ?? [])
            : history
              ? free.filter((id) => history.get(id)?.sameAskAt != null)
              : free,
        }),
        todoWorker: {
          on: () => false,
          wait: async (_todoId: string, ref: WorkRef) => {
            waiting.push(ref.id);
            return config?.waitResult ?? 'instruction';
          },
        },
      },
      ...claim,
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
        model: config ? 'gpt-6.1-sol' : 'claude-opus-5-5',
        effort: config ? 'high' : 'medium',
        ...request,
      },
      caller
    );
    if (outcome.kind !== 'completed') throw new Error(outcome.message);
    return outcome.value as { ok: boolean; value?: { ref: WorkRef; reused?: true } };
  };
  return { start, sent, events, started, unusable, messages, waiting, registry };
}

describe('work.start session reuse preference', () => {
  test.each([
    [undefined, 'worker.desktop'],
    ['worker.desktop', undefined],
  ])('does not reuse a %s worker for a %s todo', async (existing, expected) => {
    const id = existing ? 'templated' : 'plain';
    const run = harness([{ id, status: 'done', workerTemplate: existing }], [id], {
      adapter: 'hyperneo',
      sameAsk: [id],
    });
    const identity = { ...neo, workerTemplate: expected };
    expect((await run.start(identity)).value?.ref.id).toBe('fresh');
    expect(run.sent).toEqual([]);
  });

  test('per todo starts a new session even when another worker is free', async () => {
    const run = harness([{ id: 'other', status: 'done' }], ['other'], {
      adapter: 'claude-desktop',
      reuse: 'per_todo',
    });
    expect((await run.start(neo, false, { todoId: 'next' })).value?.ref.id).toBe('fresh');
    expect(run.sent).toEqual([]);
  });

  test.each(['long_lived', 'per_ask'] as const)(
    '%s starts a new session instead of another matter’s worker',
    async (reuse) => {
      const run = harness([{ id: 'other', status: 'done' }], ['other'], {
        adapter: 'claude-desktop',
        reuse,
        sameAsk: [],
      });
      expect((await run.start(neo, false, { todoId: 'next' })).value?.ref.id).toBe('fresh');
      expect(run.sent).toEqual([]);
    }
  );

  test('compacts the matter’s own worker before reusing it', async () => {
    const own = 'compacted';
    const run = harness([{ id: own, status: 'done' }], [own], {
      adapter: 'claude-desktop',
      reuse: 'long_lived',
      sameAsk: [own],
      compact: true,
    });
    expect((await run.start(neo, false, { todoId: 'next' })).value?.reused).toBe(true);
    expect(run.events).toEqual([`compact ${own}`, `send ${own}`]);
  });

  test.each([false, 'throws', 'unconfirmed', undefined] as const)(
    'starts fresh when compaction cannot be confirmed (%s)',
    async (compact) => {
      const own = `compacted-${compact}`;
      const run = harness([{ id: own, status: 'done' }], [own], {
        adapter: 'claude-desktop',
        reuse: 'long_lived',
        sameAsk: [own],
        compact,
      });
      expect((await run.start(neo, false, { todoId: 'next' })).value?.ref.id).toBe('fresh');
      expect(run.sent).toEqual([]);
    }
  );

  test('does not message a todo that closed while its worker compacted', async () => {
    const own = 'closed-while-compacting';
    const undone: string[] = [];
    const run = harness(
      [{ id: own, status: 'done' }],
      [own],
      { adapter: 'claude-desktop', reuse: 'long_lived', sameAsk: [own], compact: true },
      undefined,
      {
        claimWorker: async () => true,
        unclaimWorker: async (_todoId, ref) => void undone.push(ref.id),
        isOpenTodo: () => !run.events.includes(`compact ${own}`),
      }
    );
    const result = await run.start(neo, false, { todoId: 'next' });
    expect(result).toMatchObject({ ok: false, reason: 'todo_required', notSent: true });
    expect(run.events).toEqual([`compact ${own}`]);
    expect(run.started).toEqual([]);
    expect(undone).toEqual([own]);
  });

  test('per ask waits when that matter’s worker is busy', async () => {
    const run = harness([{ id: 'own', status: 'running' }], ['own'], {
      adapter: 'claude-desktop',
      reuse: 'per_ask',
      sameAsk: ['own'],
    });
    expect((await run.start(neo, false, { todoId: 'next' })).ok).toBe(false);
    expect(run.waiting).toEqual(['own']);
    expect(run.started).toEqual([]);
  });

  test('a todo that cannot be queued starts a fresh session', async () => {
    const run = harness([{ id: 'own', status: 'running' }], ['own'], {
      adapter: 'claude-desktop',
      reuse: 'per_ask',
      sameAsk: ['own'],
      waitResult: 'none',
    });
    expect((await run.start(neo, false, { todoId: 'next' })).value?.ref.id).toBe('fresh');
    expect(run.waiting).toEqual(['own']);
  });

  test('a failing busy-worker status check falls back to a fresh start', async () => {
    const run = harness([{ id: 'own', status: 'running' }], ['own'], {
      adapter: 'claude-desktop',
      reuse: 'per_ask',
      sameAsk: ['own'],
      statusThrows: true,
    });
    expect((await run.start(neo, false, { todoId: 'next' })).value?.ref.id).toBe('fresh');
    expect(run.waiting).toEqual([]);
  });
});

describe('work.start against a worker release', () => {
  const claims = () => {
    const undone: string[] = [];
    return {
      undone,
      deps: {
        claimWorker: async () => true,
        unclaimWorker: async (_todoId: string, ref: WorkRef) => void undone.push(ref.id),
      },
    };
  };

  test('claims the picked worker before its first message', async () => {
    const order: string[] = [];
    let sent: string[] = [];
    const run = harness(
      [{ id: 'fence-idle', status: 'done' }],
      ['fence-idle'],
      undefined,
      undefined,
      {
        claimWorker: async (ref) => {
          order.push(`claim ${ref.id} after ${sent.length} sends`);
          return true;
        },
      }
    );
    sent = run.sent;
    expect((await run.start(neo, false, { todoId: 'next' })).value?.ref.id).toBe('fence-idle');
    expect(order).toEqual(['claim fence-idle after 0 sends']);
  });

  test('starts fresh when the release won the worker first', async () => {
    const run = harness([{ id: 'released', status: 'done' }], ['released'], undefined, undefined, {
      claimWorker: async () => false,
    });
    expect((await run.start(neo, false, { todoId: 'next' })).value?.ref.id).toBe('fresh');
    expect(run.sent).toEqual([]);
    expect(run.started).toEqual(['loader']);
  });

  test('a claim that fails leaves the worker free for the next start', async () => {
    let calls = 0;
    const run = harness(
      [{ id: 'claim-throws', status: 'done' }],
      ['claim-throws'],
      undefined,
      undefined,
      {
        claimWorker: async () => {
          calls += 1;
          if (calls === 1) throw new Error('db gateway write queue full');
          return true;
        },
      }
    );
    await run.start(neo, false, { todoId: 'next' }).catch(() => null);
    expect((await run.start(neo, false, { todoId: 'next' })).value?.ref.id).toBe('claim-throws');
    expect(run.sent).toEqual(['claim-throws']);
  });

  test('gives the claim back only when the first message was proven unsent', async () => {
    const claim = claims();
    const run = harness(
      [{ id: 'closed', status: 'done', refusal: 'not_open' }],
      ['closed'],
      undefined,
      undefined,
      claim.deps
    );
    expect((await run.start(neo, false, { todoId: 'next' })).value?.ref.id).toBe('fresh');
    expect(claim.undone).toEqual(['closed']);
  });

  test('keeps the claim when the worker may have accepted the message but the reply was lost', async () => {
    const claim = claims();
    const run = harness(
      [{ id: 'lost-reply', status: 'done', refusal: 'uncertain' }],
      ['lost-reply'],
      undefined,
      undefined,
      claim.deps
    );
    await run.start(neo, false, { todoId: 'next' });
    expect(run.sent).toEqual(['lost-reply']);
    expect(claim.undone).toEqual([]);
  });

  test('keeps the claim when the first message throws', async () => {
    const claim = claims();
    const run = harness(
      [{ id: 'send-throws', status: 'done', refusal: 'throws' }],
      ['send-throws'],
      undefined,
      undefined,
      claim.deps
    );
    await run.start(neo, false, { todoId: 'next' }).catch(() => null);
    expect(claim.undone).toEqual([]);
  });
});

describe('work.start reuses an idle worker', () => {
  test.each(['claude-desktop', 'copilot-cli'])(
    'offers a follow-up to its most recently used same-ask worker first (%s)',
    async (adapter) => {
      const run = harness(
        [
          { id: 'affinity-other', status: 'done', copilotClient: 'desktop' },
          { id: 'affinity-older', status: 'done', copilotClient: 'desktop' },
          { id: 'affinity-latest', status: 'done', copilotClient: 'cli' },
        ],
        ['affinity-other', 'affinity-older', 'affinity-latest'],
        { adapter, copilotClients: adapter === 'copilot-cli' ? ['desktop', 'cli'] : undefined },
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
    }
  );

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

  test('starts fresh instead of reusing workers from a different ask', async () => {
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
    expect((await run.start(neo, false, { todoId: 'different-ask' })).value?.ref.id).toBe('fresh');
    expect(run.started).toEqual(['loader']);
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

  test('tells a reused worker its own id in the reply line', async () => {
    const run = harness([{ id: 'reply-idle', status: 'done' }], ['reply-idle']);
    expect((await run.start(neo, true)).value?.reused).toBe(true);
    expect(run.messages[0]).toContain('hyperneo send neo --from claude-desktop:reply-idle --kind');
    expect(run.messages[0].split('hyperneo send ')).toHaveLength(2);
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

  test('starts fresh instead of overwriting an unanswered turn question', async () => {
    const question = {
      id: 'tool-question',
      at: 1,
      text: 'Continue this plan?',
      actions: ['Yes', 'Wait'],
    };
    const run = harness(
      [
        {
          id: 'asking',
          status: 'done',
          liveStatus: 'needs_you',
          turnQuestion: question,
        },
      ],
      ['asking']
    );
    expect((await run.start()).value?.ref.id).toBe('fresh');
    expect(run.sent).toEqual([]);
    expect(run.started).toEqual(['loader']);
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

describe('work.start reuse for a shared model id whose default is not the first provider', () => {
  test('a pinned selector starts fresh on another provider', async () => {
    const config = {
      adapter: 'hyperneo',
      model: 'gpt-6.1-sol',
      provider: 'first',
      requestedProvider: 'second',
    };
    const pinned = harness([{ id: 'idle-first', status: 'done' }], ['idle-first'], config);
    expect((await pinned.start(neo, false, { model: 'Sol 6.1' })).value?.ref.id).toBe('fresh');
    expect(pinned.sent).toEqual([]);
  });
});

describe('work.start required identity', () => {
  test('refuses a Neo start that omits effort before reusing or starting anything', async () => {
    const run = harness([{ id: 'idle', status: 'done' }], ['idle']);
    const result = await run.start(neo, false, { effort: undefined, todoId: 'next' });
    expect(result).toMatchObject({ ok: false, reason: 'identity_required' });
    expect(run.sent).toEqual([]);
    expect(run.started).toEqual([]);
  });

  test('lets a non-Neo caller start without the triple', async () => {
    const run = harness([], []);
    const result = await run.start({ source: 'rpc' }, false, {
      model: undefined,
      effort: undefined,
    });
    expect(result.ok).toBe(true);
    expect(run.started).toEqual(['loader']);
  });
});

describe('work.start reuse of a non-configurable adapter', () => {
  test.each([
    { recorded: { model: 'claude-opus-5-5', effort: 'medium' }, reuse: true },
    { recorded: { model: 'claude-opus-5-5', effort: 'low' }, reuse: false },
    { recorded: {}, reuse: false },
  ])('matches the recorded request: %j', async ({ recorded, reuse }) => {
    const id = `recorded-${JSON.stringify(recorded)}`;
    const run = harness([{ id, status: 'done' }], [id], undefined, undefined, undefined, {
      [id]: recorded,
    });
    const result = await run.start(neo, false, { todoId: 'next' });
    expect(result.value?.ref.id).toBe(reuse ? id : 'fresh');
    expect(run.sent).toEqual(reuse ? [id] : []);
    if (reuse) expect(result.value).toMatchObject({ model: 'claude-opus-5-5', effort: 'medium' });
  });
});

describe('work.start with a mismatched idle worker', () => {
  test('starts fresh and never switches the worker', async () => {
    const config = {
      adapter: 'hyperneo',
      model: 'other-model',
      effort: 'low',
      reconfigure: 'applies' as const,
    };
    const run = harness([{ id: 'idle', status: 'done' }], ['idle'], config);
    const result = await run.start(neo, false, { model: 'Sol 6.1', effort: 'high' });
    expect(result.value?.ref.id).toBe('fresh');
    expect(run.sent).toEqual([]);
    expect(config).toMatchObject({ model: 'other-model', effort: 'low' });
  });
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

describe('work.start desktop worker reuse', () => {
  test('a desktop worker is reused when the requested triple matches it', async () => {
    const run = harness(
      [{ id: 'desk', status: 'done', workerTemplate: 'worker.desktop' }],
      ['desk'],
      { adapter: 'hyperneo', model: 'gpt-6.1-sol', effort: 'high' }
    );
    const r = await run.start({ ...neo, workerTemplate: 'worker.desktop' }, false, {});
    expect(r.value?.ref.id).toBe('desk');
  });
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
  test('a forwarded start creates a fresh session instead of reusing a remote worker', async () => {
    const destination = harness([{ id: 'other', status: 'done' }], ['other'], {
      adapter: 'claude-desktop',
      reuse: 'per_ask',
      sameAsk: [],
    });
    const rpc = createOperationRpcHandler(destination.registry, () => ({}));
    const sender = createOperationRegistry(
      createWorkVerbOperations({
        adapters: () => [],
        daemonName: 'origin',
        remote: {
          list: () => [{ daemonId: 'peer' }],
          invoke: async (_daemon, name, input) =>
            rpc(
              { name, input },
              {
                messageId: 'synthetic',
                sessionId: 'global',
                method: 'operation.invoke',
                timestamp: new Date().toISOString(),
              }
            ),
        },
      })
    );
    const result = await invokeOperation(
      sender,
      'work.start',
      {
        adapter: 'claude-desktop',
        place: { ...place, daemon: 'peer' },
        todoId: 'remote-todo',
        title: 'loader',
        message: 'Fix the loader.',
      },
      neo
    );
    expect(result).toMatchObject({
      value: { ok: true, value: { ref: { id: 'fresh', daemon: 'peer' } } },
    });
    expect(destination.sent).toEqual([]);
    expect(destination.started).toEqual(['loader']);
  });

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
