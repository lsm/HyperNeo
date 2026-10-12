import { describe, expect, test } from 'bun:test';
import type { NeoBinding } from '@hyperneo/shared/types/neo-context';
import {
  createNeoAskForwardOperation,
  type NeoAskForwardRuntime,
  neoForwardContent,
  neoForwardedText,
  planNeoAskForward,
  requireForwardingHolder,
  staleNeoForwardHops,
} from '../../../../src/lib/neo/ask-forward-operation.ts';
import { NeoService } from '../../../../src/lib/neo/service.ts';
import {
  type DaemonInternalEventMap,
  InternalEventBus,
} from '../../../../src/lib/internal-event-bus.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';
import {
  type NeoAskForward,
  NeoAskForwardRepository,
} from '../../../../src/storage/repositories/neo-ask-forward-repository.ts';
import { runMigration344 } from '../../../../src/storage/schema/m344-neo-ask-forwards.ts';
import { Database as Sqlite } from '../../../../src/storage/sqlite-compat.ts';
import { createTestDb } from '../../../helpers/database.ts';

const garden: NeoBinding = { sessionId: 'neo:garden', concernId: 'garden', kind: 'concern' };
const pond: NeoBinding = { sessionId: 'neo:pond', concernId: 'pond', kind: 'concern' };
const root: NeoBinding = { sessionId: 'neo:root', concernId: null, kind: 'neo' };
const ask = { sessionId: garden.sessionId, messageId: 'ask-1' };

const caller = (sessionId: string, messageId: string, live = true): OperationCaller => ({
  source: 'mcp',
  sessionId,
  neoTurn: { messageId, human: false, isLive: () => live },
});

describe('staleNeoForwardHops', () => {
  test('marks the hops whose note never reached its receiver', () => {
    const forwards = [
      { hop: 0, toSessionId: pond.sessionId },
      { hop: 1, toSessionId: root.sessionId },
    ];
    expect(
      staleNeoForwardHops(
        ask,
        forwards,
        (sessionId, id) => sessionId === pond.sessionId && id === 'neo-forward:ask-1:0'
      )
    ).toEqual([1]);
  });
});

describe('requireForwardingHolder', () => {
  test('admits only a topic holder in a live turn', () => {
    expect(requireForwardingHolder(caller(garden.sessionId, 'ask-1'), garden)).toEqual({
      value: { sessionId: garden.sessionId, concernId: 'garden', input: ask },
    });
    for (const [who, binding] of [
      [caller(root.sessionId, 'ask-1'), root],
      [caller('worker', 'ask-1'), { sessionId: 'worker', concernId: null, kind: 'worker' }],
      [caller(garden.sessionId, 'ask-1', false), garden],
      [{ source: 'rpc', principal: 'local' }, garden],
    ] as const)
      expect(requireForwardingHolder(who as OperationCaller, binding as NeoBinding)).toEqual({
        reason: { ok: false, reason: 'topic_holder_only' },
      });
  });
});

describe('planNeoAskForward', () => {
  const holder = { sessionId: garden.sessionId, concernId: 'garden', input: ask };
  const second = {
    sessionId: pond.sessionId,
    concernId: 'pond',
    input: { sessionId: pond.sessionId, messageId: 'neo-forward:ask-1:0' },
  };

  test('the routed holder forwards once, to another topic or main, never to itself', () => {
    expect(planNeoAskForward({ to: 'pond' }, holder, ask, [])).toEqual({
      value: { hop: 0, to: 'pond' },
    });
    expect(planNeoAskForward({ to: 'main' }, holder, ask, [])).toEqual({
      value: { hop: 0, to: 'main' },
    });
    expect(planNeoAskForward({ to: 'garden' }, holder, ask, [])).toEqual({
      reason: { ok: false, reason: 'same_topic' },
    });
    expect(planNeoAskForward({ to: 'garden' }, second, ask, [])).toEqual({
      reason: { ok: false, reason: 'not_your_ask' },
    });
  });

  test('only the turn that carries the message itself can forward it, not a consultation or nudge', () => {
    const consulted = {
      ...holder,
      input: { sessionId: garden.sessionId, messageId: 'neo-consult:c1:request' },
    };
    expect(planNeoAskForward({ to: 'pond' }, consulted, ask, [])).toEqual({
      reason: { ok: false, reason: 'not_your_ask' },
    });
    const nudged = { ...second, input: { ...second.input, messageId: 'neo-nudge:x' } };
    expect(
      planNeoAskForward({ to: 'main' }, nudged, ask, [{ toSessionId: pond.sessionId }])
    ).toEqual({ reason: { ok: false, reason: 'not_your_ask' } });
  });

  test('the holder that received it may only send it on to main, and nothing goes further', () => {
    const forwarded = [{ toSessionId: pond.sessionId }];
    expect(planNeoAskForward({ to: 'main' }, second, ask, forwarded)).toEqual({
      value: { hop: 1, to: 'main' },
    });
    expect(planNeoAskForward({ to: 'garden' }, second, ask, forwarded)).toEqual({
      reason: { ok: false, reason: 'main_only' },
    });
    expect(planNeoAskForward({ to: 'main' }, holder, ask, forwarded)).toEqual({
      reason: { ok: false, reason: 'not_your_ask' },
    });
    expect(
      planNeoAskForward({ to: 'main' }, second, ask, [
        ...forwarded,
        { toSessionId: root.sessionId },
      ])
    ).toEqual({ reason: { ok: false, reason: 'forward_limit' } });
  });
});

describe('neoForwardedText', () => {
  test('reads the human text of the ask it was routed with', () => {
    expect(
      neoForwardedText(
        {
          askOrigin: ask,
          content: [
            { type: 'text', text: 'Fix the pond pump' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '' } },
          ],
        } as never,
        ask
      )
    ).toBe(
      'Fix the pond pump\n\n(The human also attached 1 file, not forwarded; ask them to resend it if you need it.)'
    );
    expect(
      neoForwardedText(
        {
          askOrigin: ask,
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '' } },
          ],
        } as never,
        ask
      )
    ).toContain('attached 1 file');
    expect(neoForwardedText({ askOrigin: { ...ask, sessionId: 'x' }, content: 'a' }, ask)).toBe(
      null
    );
    expect(neoForwardedText(null, ask)).toBe(null);
  });
});

describe('neoForwardContent', () => {
  test('tells a topic receiver it may still forward to main, and main or the last one nothing', () => {
    expect(neoForwardContent('Garden', true, 'Fix the pond pump')).toContain('forward it to main');
    expect(neoForwardContent('Pond', false, 'Fix the pond pump')).toContain(
      'neo.publication.publish'
    );
    expect(neoForwardContent('Pond', false, 'Fix the pond pump')).not.toContain(
      'forward it to main'
    );
  });
});

describe('neo.ask.forward', () => {
  function runtime() {
    const bindings = new Map([garden, pond, root].map((binding) => [binding.sessionId, binding]));
    const forwards: NeoAskForward[] = [];
    let failDelivery = false;
    const delivered: unknown[] = [];
    const deps: NeoAskForwardRuntime = {
      getBinding: (id) => bindings.get(id) ?? null,
      resolveAskOrigin: () => ask,
      forwards: () => forwards,
      getConcern: (id) => (id === 'garden' || id === 'pond' ? { id, title: id } : null),
      listTopics: () => [
        { id: 'garden', title: 'Garden' },
        { id: 'pond', title: 'Pond' },
      ],
      rootSessionId: () => root.sessionId,
      askText: () => 'Fix the pond pump',
      open: async (id) => `neo:${id}`,
      record: (_ask, forward) => {
        if (forwards.some((item) => item.hop === forward.hop)) return false;
        forwards.push(forward);
        return true;
      },
      unrecord: (_ask, hop) => {
        forwards.splice(
          forwards.findIndex((item) => item.hop === hop),
          1
        );
      },
      delivered: (sessionId, messageId) =>
        delivered.some((args) => {
          const [to, id] = args as [string, string];
          return to === sessionId && id === messageId;
        }),
      deliver: async (...args) => {
        if (failDelivery) throw new Error('mailbox handoff rejected');
        delivered.push(args);
      },
    };
    const invoke = (who: OperationCaller, to: string) =>
      invokeOperation(
        createOperationRegistry([createNeoAskForwardOperation(deps)]),
        'neo.ask.forward',
        { to },
        who
      );
    return {
      invoke,
      forwards,
      delivered,
      failNextDelivery: (fail: boolean) => {
        failDelivery = fail;
      },
    };
  }

  test('hands the ask on once, then only to main, stamping each hand-off with the ask', async () => {
    const { invoke, forwards, delivered } = runtime();
    expect(await invoke(caller(garden.sessionId, 'ask-1'), 'pond')).toMatchObject({
      kind: 'completed',
      value: { ok: true, hop: 0, to: 'pond' },
    });
    expect(await invoke(caller(garden.sessionId, 'ask-1'), 'main')).toMatchObject({
      value: { ok: false, reason: 'not_your_ask' },
    });
    expect(await invoke(caller(pond.sessionId, 'neo-forward:ask-1:0'), 'main')).toMatchObject({
      value: { ok: true, hop: 1, to: 'main' },
    });
    expect(forwards.map((item) => [item.hop, item.fromSessionId, item.toSessionId])).toEqual([
      [0, garden.sessionId, pond.sessionId],
      [1, pond.sessionId, root.sessionId],
    ]);
    expect(delivered.map((args) => (args as unknown[]).filter((_, i) => i !== 2))).toEqual([
      [pond.sessionId, 'neo-forward:ask-1:0', garden.sessionId, ask],
      [root.sessionId, 'neo-forward:ask-1:1', pond.sessionId, ask],
    ]);
  });

  test('a failed delivery takes the hop back, so the holder can forward again', async () => {
    const { invoke, forwards, delivered, failNextDelivery } = runtime();
    failNextDelivery(true);
    expect(await invoke(caller(garden.sessionId, 'ask-1'), 'pond')).toMatchObject({
      kind: 'failed',
    });
    expect(forwards).toEqual([]);
    failNextDelivery(false);
    expect(await invoke(caller(garden.sessionId, 'ask-1'), 'pond')).toMatchObject({
      value: { ok: true, hop: 0 },
    });
    expect(delivered).toHaveLength(1);
  });

  test('a hop recorded but never delivered, as after a crash, is dropped and the holder can forward again', async () => {
    const { invoke, forwards, delivered } = runtime();
    forwards.push({
      hop: 0,
      fromSessionId: garden.sessionId,
      toSessionId: pond.sessionId,
      toConcernId: 'pond',
      forwardedAt: 1,
    });
    expect(await invoke(caller(garden.sessionId, 'ask-1'), 'pond')).toMatchObject({
      value: { ok: true, hop: 0 },
    });
    expect(forwards).toHaveLength(1);
    expect(delivered).toHaveLength(1);
  });

  test('a forward straight to main does not tell main to forward again', async () => {
    const { invoke, delivered } = runtime();
    expect(await invoke(caller(garden.sessionId, 'ask-1'), 'main')).toMatchObject({
      value: { ok: true, hop: 0, to: 'main' },
    });
    const content = (delivered[0] as unknown[])[2] as string;
    expect(content).toContain('neo.publication.publish');
    expect(content).not.toContain('forward it to main');
  });

  test('refuses a topic that does not exist', async () => {
    const { invoke, delivered } = runtime();
    expect(await invoke(caller(garden.sessionId, 'ask-1'), 'nowhere')).toMatchObject({
      value: {
        ok: false,
        reason: 'unknown_topic',
        topics: [
          { id: 'garden', title: 'Garden' },
          { id: 'pond', title: 'Pond' },
        ],
      },
    });
    expect(delivered).toEqual([]);
  });
});

describe('NeoService.recentAsksFor', () => {
  test('lists an ask forwarded to a holder under the forwarded note, so its reply fallback covers it', async () => {
    const db = await createTestDb();
    const service = new NeoService(
      db,
      {} as never,
      { event: () => {} } as never,
      new InternalEventBus<DaemonInternalEventMap>()
    );
    const conversationId = '10000000-0000-4000-8000-000000000001';
    const requestId = '20000000-0000-4000-8000-000000000001';
    try {
      expect(
        service.asks.append({
          conversationId,
          requestId,
          askOrigin: { sessionId: garden.sessionId, messageId: requestId },
          content: 'Fix the pond pump',
        }).accepted
      ).toBe(true);
      const origin = { sessionId: garden.sessionId, messageId: requestId };
      service.askForwards.record(origin, {
        hop: 0,
        fromSessionId: garden.sessionId,
        toSessionId: pond.sessionId,
        toConcernId: 'pond',
        forwardedAt: 1,
      });
      expect(
        service.recentAsksFor(conversationId, pond.sessionId).map((item) => item.requestId)
      ).toEqual([`neo-forward:${requestId}:0`]);
      expect(
        service.recentAsksFor(conversationId, garden.sessionId).map((item) => item.requestId)
      ).toEqual([requestId]);
    } finally {
      service.dispose();
      db.close();
    }
  });
});

describe('NeoAskForwardRepository', () => {
  test('records each hop once and lists them in order', () => {
    const db = new Sqlite(':memory:');
    runMigration344(db);
    runMigration344(db);
    const repo = new NeoAskForwardRepository(db);
    const forward = (hop: number): NeoAskForward => ({
      hop,
      fromSessionId: hop ? pond.sessionId : garden.sessionId,
      toSessionId: hop ? root.sessionId : pond.sessionId,
      toConcernId: hop ? null : 'pond',
      forwardedAt: hop,
    });
    expect(repo.record(ask, forward(1))).toBe(true);
    expect(repo.record(ask, forward(0))).toBe(true);
    expect(repo.record(ask, forward(0))).toBe(false);
    expect(repo.list(ask).map((item) => item.hop)).toEqual([0, 1]);
    expect(repo.list({ ...ask, messageId: 'other' })).toEqual([]);
    repo.remove(ask, 1);
    expect(repo.list(ask).map((item) => item.hop)).toEqual([0]);
  });

  test('the forwarder stops answering an ask only once its forward was delivered', async () => {
    const db = await createTestDb();
    const service = new NeoService(
      db,
      {} as never,
      { event: () => {} } as never,
      new InternalEventBus<DaemonInternalEventMap>()
    );
    try {
      service.askForwards.record(ask, {
        hop: 0,
        fromSessionId: garden.sessionId,
        toSessionId: pond.sessionId,
        toConcernId: 'pond',
        forwardedAt: 1,
      });
      expect(service.forwardedAway(garden.sessionId, 'ask-1')).toBe(false);
      db.getJobQueueRepo().enqueue({
        queue: 'mailbox',
        payload: { to: { sessionId: pond.sessionId }, messageUuid: 'neo-forward:ask-1:0' },
      });
      expect(service.forwardedAway(garden.sessionId, 'ask-1')).toBe(true);
      expect(service.forwardedAway(pond.sessionId, 'ask-1')).toBe(false);
      service.askForwards.record(ask, {
        hop: 1,
        fromSessionId: pond.sessionId,
        toSessionId: root.sessionId,
        toConcernId: null,
        forwardedAt: 2,
      });
      expect(service.forwardedAway(pond.sessionId, 'neo-forward:ask-1:0')).toBe(false);
      db.getJobQueueRepo().enqueue({
        queue: 'mailbox',
        payload: { to: { sessionId: root.sessionId }, messageUuid: 'neo-forward:ask-1:1' },
      });
      expect(service.forwardedAway(pond.sessionId, 'neo-forward:ask-1:0')).toBe(true);
    } finally {
      service.dispose();
      db.close();
    }
  });
});
