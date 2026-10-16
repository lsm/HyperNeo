import { describe, expect, mock, test } from 'bun:test';
import type { MailboxMessageContent } from '../../../../src/lib/mailbox/entry.ts';
import type { NeoBinding } from '@hyperneo/shared/types/neo-context';
import {
  createNeoAskForwardOperation,
  type NeoAskForwardRuntime,
  neoForwardContent,
  neoForwardedText,
  neoForwardHop,
  neoTurnOwnsMessage,
  planNeoAskForward,
  requireForwardingHolder,
  staleNeoForwardHops,
} from '../../../../src/lib/neo/ask-forward-operation.ts';
import { createNeoOperations } from '../../../../src/lib/neo/operations.ts';
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
import { createTestDb, createTestSession } from '../../../helpers/database.ts';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import { NeoHolderTurn } from '../../../../src/lib/neo/holder-turn.ts';

const garden: NeoBinding = { sessionId: 'neo:garden', projectId: 'garden', kind: 'project' };
const pond: NeoBinding = { sessionId: 'neo:pond', projectId: 'pond', kind: 'project' };
const root: NeoBinding = { sessionId: 'neo:root', projectId: null, kind: 'neo' };
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
  test('admits a project holder or main in a live turn', () => {
    expect(requireForwardingHolder(caller(garden.sessionId, 'ask-1'), garden)).toEqual({
      value: { sessionId: garden.sessionId, projectId: 'garden', input: ask },
    });
    expect(requireForwardingHolder(caller(root.sessionId, 'ask-1'), root)).toEqual({
      value: {
        sessionId: root.sessionId,
        projectId: null,
        input: { sessionId: root.sessionId, messageId: 'ask-1' },
      },
    });
    for (const [who, binding] of [
      [caller('worker', 'ask-1'), { sessionId: 'worker', projectId: null, kind: 'worker' }],
      [caller(garden.sessionId, 'ask-1', false), garden],
      [{ source: 'rpc', principal: 'local' }, garden],
    ] as const)
      expect(requireForwardingHolder(who as OperationCaller, binding as NeoBinding)).toEqual({
        reason: { ok: false, reason: 'coordinator_only' },
      });
  });
});

describe('planNeoAskForward', () => {
  const holder = { sessionId: garden.sessionId, projectId: 'garden', input: ask };
  test('only the original request owner can make the first forward', () => {
    expect(planNeoAskForward({ to: 'pond' }, holder, ask, [])).toEqual({
      value: { hop: 0, to: 'pond' },
    });
    expect(planNeoAskForward({ to: 'garden' }, holder, ask, [])).toEqual({
      reason: { ok: false, reason: 'same_project' },
    });
    for (const messageId of ['neo-consult:c1:request', 'neo-nudge:x'])
      expect(
        planNeoAskForward({ to: 'pond' }, { ...holder, input: { ...ask, messageId } }, ask, [])
      ).toEqual({ reason: { ok: false, reason: 'not_your_ask' } });
  });
  test.each([0, 1, 7])(
    'the current owner can forward after hop %s without a main-only rule',
    (hop) => {
      const forwards = [{ hop, toSessionId: pond.sessionId }];
      const current = {
        sessionId: pond.sessionId,
        projectId: 'pond',
        input: { sessionId: pond.sessionId, messageId: `neo-forward:ask-1:${hop}` },
      };
      for (const to of ['garden', 'main'])
        expect(planNeoAskForward({ to }, current, ask, forwards)).toEqual({
          value: { hop: hop + 1, to },
        });
      expect(planNeoAskForward({ to: 'main' }, holder, ask, forwards)).toEqual({
        reason: { ok: false, reason: 'not_your_ask' },
      });
      expect(
        planNeoAskForward(
          { to: 'main' },
          { ...current, input: { ...current.input, messageId: 'neo-nudge:x' } },
          ask,
          forwards
        )
      ).toEqual({ reason: { ok: false, reason: 'not_your_ask' } });
    }
  );
});

describe('neoTurnOwnsMessage', () => {
  const toPond = { hop: 0, toSessionId: pond.sessionId };
  const toMain = { hop: 1, toSessionId: root.sessionId };
  const turn = (messageId: string, human = false, consultationId?: string) => ({
    messageId,
    human,
    consultationId,
  });

  test.each([
    ['the human turn it landed in, before any forward', garden, turn('ask-1', true), [], true],
    ['the human turn after it was forwarded away', garden, turn('ask-1', true), [toPond], false],
    ['a consultation turn', garden, turn('neo-consult:c:request', true, 'c'), [], false],
    ['the holder it was forwarded to', pond, turn('neo-forward:ask-1:0'), [toPond], true],
    [
      'that holder once it forwarded on to main',
      pond,
      turn('neo-forward:ask-1:0'),
      [toPond, toMain],
      false,
    ],
    ['main after the second hop', root, turn('neo-forward:ask-1:1'), [toPond, toMain], true],
    ['a session the forward did not reach', root, turn('neo-forward:ask-1:0'), [toPond], false],
    ['a system note', garden, turn('neo-note:x'), [], false],
  ] as const)('%s', (_label, binding, current, forwards, owns) => {
    expect(neoTurnOwnsMessage(binding.sessionId, current, forwards)).toBe(owns);
  });
});

describe('neoForwardHop', () => {
  test('reads the hop of a forwarded message id', () => {
    expect(neoForwardHop('neo-forward:ask-1:1')).toBe(1);
    expect(neoForwardHop('ask-1')).toBeNull();
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
    ).toBe('Fix the pond pump');
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
    ).toBeNull();
    expect(neoForwardedText({ askOrigin: { ...ask, sessionId: 'x' }, content: 'a' }, ask)).toBe(
      null
    );
    expect(neoForwardedText(null, ask)).toBe(null);
  });
});

describe('neoForwardContent', () => {
  test('preserves original attachment blocks without asking the human to resend', () => {
    const image = {
      type: 'image' as const,
      source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'aGVsbG8=' },
    };
    const content: MailboxMessageContent = [{ type: 'text', text: 'Fix the pond pump' }, image];
    const before = structuredClone(content);
    expect(neoForwardContent('Garden', content)).toEqual([
      { type: 'text', text: expect.stringContaining('Fix the pond pump') },
      image,
    ]);
    expect(content).toEqual(before);
    expect(neoForwardContent('Garden', [image])).toEqual([
      { type: 'text', text: expect.stringContaining('original ask') },
      image,
    ]);
    expect(neoForwardContent('Garden', 'Fix the pond pump')).not.toContain('only to main');
    expect(JSON.stringify(neoForwardContent('Garden', content))).not.toContain('resend');
  });
});

describe('neo.ask.forward', () => {
  function runtime(origin = ask, content: MailboxMessageContent = 'Fix the pond pump') {
    const bindings = new Map([garden, pond, root].map((binding) => [binding.sessionId, binding]));
    const forwards: NeoAskForward[] = [];
    let failDelivery = false;
    const delivered: unknown[] = [];
    const deps: NeoAskForwardRuntime = {
      getBinding: (id) => bindings.get(id) ?? null,
      resolveAskOrigin: () => origin,
      forwards: () => forwards,
      getProject: (id) => (id === 'garden' || id === 'pond' ? { id, title: id } : null),
      listProjects: () => [
        { id: 'garden', title: 'Garden' },
        { id: 'pond', title: 'Pond' },
      ],
      rootSessionId: () => root.sessionId,
      askContent: () => content,
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
      deps,
      forwards,
      delivered,
      failNextDelivery: (fail: boolean) => {
        failDelivery = fail;
      },
    };
  }

  test('hands the ask between owners, stamping every hand-off with the original ask', async () => {
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

  test('main hands the message to a project, which may transfer ownership again', async () => {
    const mainAsk = { sessionId: root.sessionId, messageId: 'ask-2' };
    const { invoke, forwards, delivered } = runtime(mainAsk);
    expect(await invoke(caller(root.sessionId, 'ask-2'), 'pond')).toMatchObject({
      value: { ok: true, hop: 0, to: 'pond' },
    });
    expect(forwards.map((item) => [item.hop, item.fromSessionId, item.toSessionId])).toEqual([
      [0, root.sessionId, pond.sessionId],
    ]);
    const [to, messageId, content] = delivered[0] as [string, string, string];
    expect([to, messageId]).toEqual([pond.sessionId, 'neo-forward:ask-2:0']);
    expect(content).toContain('“main”');
    expect(content).not.toContain('forward it to main');
    expect(await invoke(caller(pond.sessionId, 'neo-forward:ask-2:0'), 'main')).toMatchObject({
      value: { ok: true, hop: 1, to: 'main' },
    });
  });

  test('a successful multi-hop transfer yields each sender and preserves attachments', async () => {
    const image = {
      type: 'image' as const,
      source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'aGVsbG8=' },
    };
    const { invoke, delivered, forwards } = runtime(ask, [{ type: 'text', text: 'Fix it' }, image]);
    for (const [index, from, to] of [
      [0, garden, 'pond'],
      [1, pond, 'garden'],
      [2, garden, 'main'],
      [3, root, 'pond'],
    ] as const) {
      const yieldTurn = mock(() => {});
      const current = caller(
        from.sessionId,
        index === 0 ? 'ask-1' : `neo-forward:ask-1:${index - 1}`
      );
      const yielding = { ...current, neoTurn: { ...current.neoTurn!, yield: yieldTurn } };
      expect(await invoke(yielding, to)).toMatchObject({ value: { ok: true, hop: index, to } });
      expect(yieldTurn).toHaveBeenCalledTimes(1);
      expect((delivered[index] as unknown[])[2]).toEqual([
        { type: 'text', text: expect.stringContaining('Fix it') },
        image,
      ]);
    }
    expect(forwards).toHaveLength(4);
  });

  test('a caller superseded while opening the receiver cannot transfer ownership', async () => {
    const { invoke, deps, delivered, forwards } = runtime();
    let live = true;
    const yieldTurn = mock(() => {});
    deps.open = async () => {
      live = false;
      return pond.sessionId;
    };
    const current = {
      ...caller(garden.sessionId, 'ask-1'),
      neoTurn: {
        messageId: 'ask-1',
        human: true,
        isLive: () => live,
        yield: yieldTurn,
      },
    };
    expect(await invoke(current, 'pond')).toMatchObject({
      value: { ok: false, reason: 'coordinator_only' },
    });
    expect(forwards).toEqual([]);
    expect(delivered).toEqual([]);
    expect(yieldTurn).not.toHaveBeenCalled();
  });

  test('a failed delivery takes the hop back, so the holder can forward again', async () => {
    const { invoke, forwards, delivered, failNextDelivery } = runtime();
    const yieldTurn = mock(() => {});
    const base = caller(garden.sessionId, 'ask-1');
    const current = { ...base, neoTurn: { ...base.neoTurn!, yield: yieldTurn } };
    failNextDelivery(true);
    expect(await invoke(current, 'pond')).toMatchObject({
      kind: 'failed',
    });
    expect(forwards).toEqual([]);
    expect(yieldTurn).not.toHaveBeenCalled();
    failNextDelivery(false);
    expect(await invoke(current, 'pond')).toMatchObject({
      value: { ok: true, hop: 0 },
    });
    expect(delivered).toHaveLength(1);
    expect(yieldTurn).toHaveBeenCalledTimes(1);
  });

  test('an in-flight forward is not reclaimed as a crashed handoff', async () => {
    const { invoke, deps, forwards, delivered } = runtime();
    let finish!: () => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    deps.delivering = () => true;
    const deliver = deps.deliver;
    deps.deliver = async (...args) => {
      started();
      await pending;
      await deliver(...args);
    };
    const first = invoke(caller(garden.sessionId, 'ask-1'), 'pond');
    await ready;
    expect(await invoke(caller(garden.sessionId, 'ask-1'), 'main')).toMatchObject({
      value: { ok: false, reason: 'not_your_ask' },
    });
    expect(forwards).toHaveLength(1);
    finish();
    expect(await first).toMatchObject({ value: { ok: true, to: 'pond' } });
    expect(delivered).toHaveLength(1);
  });

  test('a hop recorded but never delivered, as after a crash, is dropped and the holder can forward again', async () => {
    const { invoke, forwards, delivered } = runtime();
    forwards.push({
      hop: 0,
      fromSessionId: garden.sessionId,
      toSessionId: pond.sessionId,
      toProjectId: 'pond',
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
    expect(content).toContain('The runtime binds the original ask and preserves its attachments.');
    expect(content).not.toContain('forwarded on only to main');
  });

  test('refuses a project that does not exist', async () => {
    const { invoke, delivered } = runtime();
    expect(await invoke(caller(garden.sessionId, 'ask-1'), 'nowhere')).toMatchObject({
      value: {
        ok: false,
        reason: 'unknown_project',
        projects: [
          { id: 'garden', title: 'Garden' },
          { id: 'pond', title: 'Pond' },
        ],
      },
    });
    expect(delivered).toEqual([]);
  });
});

describe('Neo forwarding delivery', () => {
  test('durably transfers original images and ownership before yielding the sender', async () => {
    const db = await createTestDb();
    const service = new NeoService(
      db,
      {} as never,
      { event: () => {} } as never,
      new InternalEventBus<DaemonInternalEventMap>()
    );
    const conversationId = '10000000-0000-4000-8000-000000000001';
    const requestId = '20000000-0000-4000-8000-000000000001';
    const main = { ...root, sessionId: `neo:${conversationId}` };
    const origin = { sessionId: garden.sessionId, messageId: requestId };
    const image = {
      type: 'image' as const,
      source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'aGVsbG8=' },
    };
    const content = [{ type: 'text' as const, text: 'Fix this pump' }, image];
    const abort = new AbortController();
    const sender = new NeoHolderTurn(db, garden.sessionId, {
      isLive: () => true,
      yield: () => abort.abort(),
    });
    const receiver = new NeoHolderTurn(db, pond.sessionId, { isLive: () => true });
    try {
      for (const binding of [garden, pond, main]) {
        if (binding.projectId)
          service.repo.saveProject(
            { id: binding.projectId, title: binding.projectId, summary: '', context: '' },
            0
          );
        db.createSession(createTestSession(binding.sessionId));
        service.repo.reserveBinding(binding);
      }
      service.open = async () => pond.sessionId;
      expect(
        service.asks.append({ conversationId, requestId, askOrigin: origin, content }).accepted
      ).toBe(true);
      db.getSDKMessageRepo().saveSDKMessage(garden.sessionId, {
        type: 'user',
        uuid: requestId,
        session_id: garden.sessionId,
        parent_tool_use_id: null,
        inputKind: 'human',
        message: { role: 'user', content },
      } as unknown as SDKUserMessage);
      sender.bind(requestId);
      const caller = {
        source: 'mcp' as const,
        sessionId: garden.sessionId,
        neoTurn: sender.identity(),
      };
      expect(service.ownsHumanMessage(caller)).toBe(true);
      expect(
        await invokeOperation(
          createOperationRegistry(createNeoOperations(service)),
          'neo.ask.forward',
          { to: 'pond' },
          caller
        )
      ).toMatchObject({ value: { ok: true, hop: 0 } });
      const [delivery] = db
        .getJobQueueRepo()
        .listActiveByPayload('mailbox', { 'to.sessionId': pond.sessionId });
      expect(delivery.payload).toMatchObject({
        messageUuid: `neo-forward:${requestId}:0`,
        message: {
          message: {
            content: [{ type: 'text', text: expect.stringContaining('Fix this pump') }, image],
          },
        },
      });
      expect(abort.signal.aborted).toBe(true);
      expect(service.ownsHumanMessage(caller)).toBe(false);
      expect(receiver.bind(`neo-forward:${requestId}:0`)).toBe(true);
      expect(
        service.ownsHumanMessage({
          source: 'mcp',
          sessionId: pond.sessionId,
          neoTurn: receiver.identity(),
        })
      ).toBe(true);
      expect(service.asks.find(conversationId, requestId)?.content).toEqual(content);
    } finally {
      sender.dispose();
      receiver.dispose();
      service.dispose();
      db.close();
    }
  });
});

describe('neo.snapshot askForwards', () => {
  test('shows the human recent forwards, so a reply can say which project forwarded it', async () => {
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
        toProjectId: 'pond',
        forwardedAt: 1,
      });
      const registry = createOperationRegistry(createNeoOperations(service));
      const human = await invokeOperation(
        registry,
        'neo.snapshot',
        {},
        {
          source: 'rpc',
          principal: 'local',
        }
      );
      expect(human).toMatchObject({
        value: {
          askForwards: [
            {
              askSessionId: garden.sessionId,
              askMessageId: 'ask-1',
              hop: 0,
              fromSessionId: garden.sessionId,
              toSessionId: pond.sessionId,
            },
          ],
        },
      });
    } finally {
      service.dispose();
      db.close();
    }
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
        toProjectId: 'pond',
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
      toProjectId: hop ? null : 'pond',
      forwardedAt: hop,
    });
    expect(repo.record(ask, forward(1))).toBe(true);
    expect(repo.record(ask, forward(0))).toBe(true);
    expect(repo.record(ask, forward(0))).toBe(false);
    expect(repo.list(ask).map((item) => item.hop)).toEqual([0, 1]);
    expect(repo.list({ ...ask, messageId: 'other' })).toEqual([]);
    expect(repo.listRecent(1)).toEqual([expect.objectContaining({ hop: 1, ask })]);
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
        toProjectId: 'pond',
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
        toProjectId: null,
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

  test('the holder a message was forwarded to owns it: its turn is the human’s, and the forwarder’s no longer is', async () => {
    const db = await createTestDb();
    const service = new NeoService(
      db,
      {} as never,
      { event: () => {} } as never,
      new InternalEventBus<DaemonInternalEventMap>()
    );
    try {
      for (const binding of [garden, pond]) {
        service.repo.saveProject(
          { id: binding.projectId!, title: binding.projectId!, summary: '', context: '' },
          0
        );
        db.createSession(createTestSession(binding.sessionId));
        service.repo.reserveBinding(binding);
      }
      db.getSDKMessageRepo().saveSDKMessage(garden.sessionId, {
        type: 'user',
        uuid: 'ask-1',
        session_id: garden.sessionId,
        parent_tool_use_id: null,
        inputKind: 'human',
        message: { role: 'user', content: 'Fix the pond pump' },
      } as unknown as SDKUserMessage);
      const human: OperationCaller = {
        source: 'mcp',
        sessionId: garden.sessionId,
        neoTurn: { messageId: 'ask-1', human: true, isLive: () => true },
      };
      expect(service.ownsHumanMessage(human)).toBe(true);
      service.askForwards.record(ask, {
        hop: 0,
        fromSessionId: garden.sessionId,
        toSessionId: pond.sessionId,
        toProjectId: 'pond',
        forwardedAt: 1,
      });
      expect(service.ownsHumanMessage(human)).toBe(true);
      db.getJobQueueRepo().enqueue({
        queue: 'mailbox',
        payload: { to: { sessionId: pond.sessionId }, messageUuid: 'neo-forward:ask-1:0' },
      });
      service.inputOrigins.record(
        { sessionId: pond.sessionId, messageId: 'neo-forward:ask-1:0' },
        ask,
        1,
        'human:ask-1'
      );
      expect(service.ownsHumanMessage(human)).toBe(false);
      const holder = new NeoHolderTurn(db, pond.sessionId, { isLive: () => true });
      expect(holder.bind('neo-forward:ask-1:0')).toBe(true);
      const forwarded = holder.identity()!;
      expect(forwarded.human).toBe(true);
      expect(
        service.ownsHumanMessage({ source: 'mcp', sessionId: pond.sessionId, neoTurn: forwarded })
      ).toBe(true);
      holder.dispose();
    } finally {
      service.dispose();
      db.close();
    }
  });
});
