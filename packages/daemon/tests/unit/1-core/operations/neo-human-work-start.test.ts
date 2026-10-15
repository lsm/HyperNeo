import { reconcileNeoWorkRefusal } from '../../../../src/lib/neo/work-refusal.ts';
import { NeoWorkRefusalRepository } from '../../../../src/storage/repositories/neo-work-refusal-repository.ts';
import { runMigrations } from '../../../../src/storage/schema/migrations.ts';
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import type { MessageHub } from '@hyperneo/shared';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import { createNeoOperations } from '../../../../src/lib/neo/operations.ts';
import { NeoService } from '../../../../src/lib/neo/service.ts';
import { NeoHolderTurn } from '../../../../src/lib/neo/holder-turn.ts';
import { QueryAttemptRegistry } from '../../../../src/lib/agent/query-attempt-token.ts';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import { createOperationMcpHandler } from '../../../../src/lib/operations/mcp-adapter.ts';
import {
  InternalEventBus,
  type DaemonInternalEventMap,
} from '../../../../src/lib/internal-event-bus.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import {
  hasNeoHumanWorkInput,
  requireNeoHumanWorkOrigin,
} from '../../../../src/lib/neo/work-origin.ts';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';

describe('Neo existing trusted human work input', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let service: NeoService;
  let events: InternalEventBus<DaemonInternalEventMap>;
  let attempts: QueryAttemptRegistry;
  let turns: NeoHolderTurn[];
  let created: ReturnType<typeof mock>;
  let loaded: ReturnType<typeof mock>;
  const root = 'neo:fictional-root';
  const holder = 'neo:fictional-holder';
  const target = 'fictional-native-target';
  const ask = '00000000-0000-4000-8000-000000000001';
  const local: OperationCaller = { source: 'rpc', principal: 'local' };

  beforeEach(async () => {
    db = await createTestDb();
    for (const id of [root, holder, target]) db.createSession(createTestSession(id));
    created = mock(async () => {
      throw new Error('Must not create another runtime');
    });
    loaded = mock(async () => {
      throw new Error('Must not load or change the native runtime');
    });
    events = new InternalEventBus();
    service = new NeoService(
      db,
      { createSession: created, getSessionAsync: loaded } as unknown as SessionManager,
      { event: mock(() => {}) } as unknown as MessageHub,
      events
    );
    service.repo.reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
    service.repo.saveProject(
      {
        id: 'fictional-concern',
        title: 'Fictional',
        summary: 'Bounded',
        context: 'Fictional context',
      },
      0
    );
    service.repo.reserveBinding({
      sessionId: holder,
      kind: 'project',
      projectId: 'fictional-concern',
    });
    attempts = new QueryAttemptRegistry();
    turns = [];
  });
  afterEach(() => {
    turns.forEach((turn) => turn.dispose());
    service.dispose();
    db.close();
  });
  function storeInput(sessionId = root, inputKind = 'human', messageId = ask) {
    expect(
      db.getSDKMessageRepo().saveSDKMessage(sessionId, {
        type: 'user',
        uuid: messageId,
        session_id: sessionId,
        parent_tool_use_id: null,
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Do the bounded fictional work.' }],
        },
        inputKind,
      } as SDKMessage)
    ).toBe(true);
  }
  function caller(sessionId = root, messageId = ask): OperationCaller {
    const turn = new NeoHolderTurn(db, sessionId, attempts.allocate(), () => {});
    turns.push(turn);
    expect(turn.bind(messageId)).toBe(true);
    return { source: 'mcp', sessionId, neoTurn: turn.identity() };
  }
  function invoke(name: string, input: unknown, source = local) {
    return invokeOperation(
      createOperationRegistry(createNeoOperations(service)),
      name,
      input,
      source
    );
  }
  async function propose(source: OperationCaller, key = 'fictional-work'): Promise<NeoWork> {
    const result = await invoke(
      'neo.work.propose',
      {
        requestKey: key,
        projectId: source.sessionId === holder ? 'fictional-concern' : null,
        title: 'Fictional bounded work',
        instruction: 'Use only the existing fictional target.',
        doneWhen: '- target used',
        targetSessionId: target,
      },
      source
    );
    expect(result).toMatchObject({ kind: 'completed', value: { ok: true } });
    return (result as { value: { work: NeoWork } }).value.work;
  }
  function jobs(id: string) {
    return db
      .getJobQueueRepo()
      .listActiveByPayload('mailbox', { 'to.sessionId': target, messageUuid: id });
  }
  function unchangedNative() {
    return JSON.stringify(db.getSession(target));
  }

  test.each(['neo.work.retry', 'neo.work.continue'])(
    '%s of a topic avatar’s card passes for root answering the human, not from a note',
    async (name) => {
      storeInput(holder);
      const work = await propose(caller(holder));
      const input =
        name === 'neo.work.retry' ? { id: work.id } : { id: work.id, message: 'Again.' };
      const verb = name === 'neo.work.retry' ? 'retry' : 'continue';
      const proposerOnly = {
        ok: false,
        reason: `Only the Neo session that proposed this work, Neo answering the human’s own chat message, or the user can ${verb} it.`,
      };
      const note = '00000000-0000-4000-8000-000000000013';
      storeInput(root, 'system', note);
      expect(await invoke(name, input, caller(root, note))).toMatchObject({ value: proposerOnly });
      storeInput();
      expect(await invoke(name, input, caller())).toMatchObject({
        value: {
          ok: false,
          reason:
            verb === 'retry'
              ? 'Only a hand-off that failed before it started can be retried; use neo.work.continue for started work.'
              : 'Only started driver work can be continued.',
        },
      });
    }
  );

  test('records a refusal on an owned started card and exposes talk through the snapshot', async () => {
    const sql = db.getDatabase();
    sql.exec(
      "DROP TABLE neo_work_refusals; DELETE FROM migration_markers WHERE key = 'migration_363'"
    );
    runMigrations(sql, () => {});
    storeInput();
    const owner = caller();
    const work = await propose(owner);
    const input = { workId: work.id, what: "target won't update the device." };
    expect(await invoke('neo.work.refused', input, owner)).toMatchObject({ value: { ok: false } });
    service.repo.transitionWork(work.id, work, {
      status: 'reported',
      sessionId: target,
      report: 'Refused.',
    });
    storeInput(holder);
    expect(await invoke('neo.work.refused', input, caller(holder))).toMatchObject({
      value: { ok: false },
    });
    expect(await invoke('neo.work.refused', input, owner)).toMatchObject({ value: { ok: true } });
    runMigrations(sql, () => {});
    expect(new NeoWorkRefusalRepository(db.getDatabase()).list()).toMatchObject([
      { workId: work.id, what: input.what },
    ]);
    const snapshot = await invoke('neo.snapshot', {});
    expect(snapshot).toMatchObject({
      value: {
        askViews: expect.arrayContaining([
          expect.objectContaining({
            humanActions: expect.arrayContaining([
              { kind: 'talk', workId: work.id, what: input.what },
            ]),
          }),
        ]),
        cards: expect.arrayContaining([
          expect.objectContaining({
            workId: work.id,
            talk: input.what,
            group: 'attention',
            primary: { kind: 'chat', label: 'Open chat', link: null },
          }),
        ]),
      },
    });
    const persisted = async (sessionId: string, inputKind: string, messageId: string) => {
      storeInput(sessionId, inputKind, messageId);
      await events.publish('message.persisted', {
        sessionId,
        messageId,
        messageContent: 'Go ahead',
        userMessageText: 'Go ahead',
        needsWorkspaceInit: false,
        hasDraftToClear: false,
        sendStatus: 'enqueued',
        deliveryMode: 'immediate',
      });
    };
    const refusal = service.workRefusals.list()[0];
    service.workRefusals.record({ ...refusal, at: Date.now() - 1 });
    await persisted(target, 'system', 'system-note');
    await persisted(root, 'human', 'other-session');
    expect(service.workRefusals.list()).toHaveLength(1);
    await persisted(target, 'human', 'direct-human');
    expect(service.workRefusals.list()).toEqual([]);
    expect(service.repo.getWork(work.id)?.report).toBe('Refused.');
  });

  test('clears a driver refusal only for later human input and fences a newer refusal', async () => {
    storeInput();
    const work = await propose(caller());
    const row = {
      workId: work.id,
      ref: { adapter: 'codex-desktop', id: 'thread' },
      what: 'Refused',
      at: 10,
    };
    const inputs = [
      { at: 9, text: 'earlier', human: true },
      { at: 11, text: 'relayed', human: false },
      { at: 12, text: 'unknown' },
    ];
    service.workRefusals.record(row);
    const read = async () => ({
      kind: 'completed' as const,
      value: {
        ok: true,
        value: {
          status: 'running',
          lastActivityAt: 20,
          recentInputs: inputs,
        },
      },
    });
    const clear = () => {
      service.workRefusals.clear(row);
    };
    expect(await reconcileNeoWorkRefusal(row, { read, clear })).toBe(false);
    expect(service.workRefusals.list()).toHaveLength(1);
    inputs.push({ at: 13, text: 'direct', human: true });
    expect(await reconcileNeoWorkRefusal(row, { read, clear })).toBe(true);
    expect(service.workRefusals.list()).toEqual([]);
    service.workRefusals.record({ ...row, at: 14, what: 'New refusal' });
    expect(service.workRefusals.clear(row)).toBe(false);
    expect(service.workRefusals.list()[0].what).toBe('New refusal');
  });

  test.each([root, holder])(
    'starts only the exact current real human input of %s through existing delivery',
    async (sessionId) => {
      storeInput(sessionId);
      const source = caller(sessionId);
      expect(source.neoTurn?.human).toBe(true);
      const work = await propose(source);
      const before = unchangedNative();
      expect(work).toMatchObject({
        status: 'proposed',
        originSessionId: sessionId,
        originMessageId: ask,
        targetSessionId: target,
      });
      expect(jobs(work.id)).toEqual([]);
      expect(await invoke('neo.work.start', { id: work.id }, source)).toMatchObject({
        kind: 'completed',
        value: { ok: true, work: { status: 'queued', sessionId: target } },
      });
      expect(await invoke('neo.work.start', { id: work.id }, source)).toMatchObject({
        value: { ok: true },
      });
      expect(jobs(work.id)).toHaveLength(1);
      expect(jobs(work.id)[0].payload).toMatchObject({
        origin: `session:${encodeURIComponent(sessionId)}`,
        messageUuid: work.id,
        message: { inputKind: 'system' },
      });
      expect(unchangedNative()).toBe(before);
      expect(created).not.toHaveBeenCalled();
      expect(loaded).not.toHaveBeenCalled();
    }
  );

  test('closes another session’s card only while answering the human', async () => {
    storeInput(holder);
    const work = await propose(caller(holder));
    const note = '00000000-0000-4000-8000-000000000012';
    storeInput(root, 'system', note);
    expect(
      await invoke(
        'neo.work.close',
        { id: work.id, outcome: 'cancelled', reason: 'duplicate' },
        caller(root, note)
      )
    ).toMatchObject({
      value: {
        ok: false,
        reason:
          'Neo closes a card it started at any time, and any other card only while answering the human’s own chat message.',
      },
    });
    expect(service.repo.getWork(work.id)?.status).toBe('proposed');

    storeInput();
    expect(
      await invoke(
        'neo.work.close',
        { id: work.id, outcome: 'cancelled', reason: 'the human dropped it' },
        caller()
      )
    ).toMatchObject({ value: { ok: true } });
    expect(service.repo.getWork(work.id)).toMatchObject({
      status: 'cancelled',
      report: 'Cancelled by Neo: the human dropped it',
    });
  });

  test('approving an ask starts its proposed cards; a card that cannot start stays proposed', async () => {
    storeInput();
    const first = await propose(caller());
    const opened = service.askRecords.forWork(first.id)!;
    const gone = 'fictional-gone-target';
    db.createSession(createTestSession(gone));
    const under = async (key: string, targetSessionId: string) => {
      const result = await invoke(
        'neo.work.propose',
        {
          requestKey: key,
          projectId: null,
          askId: opened.id,
          delivers: [],
          title: `Fictional ${key}`,
          instruction: 'Use only the existing fictional target.',
          targetSessionId,
          allowBusyTarget: true,
        },
        caller()
      );
      expect(result).toMatchObject({ value: { ok: true } });
      return (result as { value: { work: NeoWork } }).value.work;
    };
    const second = await under('second', target);
    const stuck = await under('stuck', gone);
    db.updateSession(gone, { status: 'archived' });
    expect([...(service.askRecords.get(opened.id)?.workIds ?? [])].sort()).toEqual(
      [first.id, second.id, stuck.id].sort()
    );

    const later = caller(root, '00000000-0000-4000-8000-000000000009');
    expect(later.neoTurn?.human).toBe(false);
    expect(await invoke('neo.ask.approve', { askId: opened.id }, later)).toMatchObject({
      value: {
        ok: false,
        reason:
          'Neo can do this only while answering the human’s own chat message, not from a system note or consultation.',
      },
    });
    expect(service.repo.getWork(first.id)?.status).toBe('proposed');

    expect(await invoke('neo.ask.approve', { askId: opened.id })).toMatchObject({
      value: { ok: true, ask: { id: opened.id, approvedAt: expect.any(Number) } },
    });
    for (const work of [first, second]) {
      expect(service.repo.getWork(work.id)).toMatchObject({ status: 'queued', sessionId: target });
      expect(jobs(work.id)).toHaveLength(1);
    }
    expect(service.repo.getWork(stuck.id)?.status).toBe('proposed');
    const snapshot = (await invoke('neo.snapshot', {})) as {
      value: { askViews: { askId: string; humanActions: unknown[] }[] };
    };
    expect(
      snapshot.value.askViews.find((view) => view.askId === opened.id)?.humanActions
    ).toContainEqual({ kind: 'start', workId: stuck.id });
  });

  test.each(['system', 'internal_compaction', 'missing'])(
    'refuses %s input even with a claimed human flag',
    async (kind) => {
      if (kind !== 'missing') storeInput(root, kind);
      const source = caller();
      const claimed = { ...source, neoTurn: { ...source.neoTurn!, human: true } };
      const work = await propose(claimed);
      expect(await invoke('neo.work.start', { id: work.id }, claimed)).toMatchObject({
        value: {
          ok: false,
          reason:
            'Neo can do this only while answering the human’s own chat message, not from a system note or consultation.',
        },
      });
      expect(service.repo.getWork(work.id)?.status).toBe('proposed');
      expect(jobs(work.id)).toEqual([]);
    }
  );

  test('cannot reuse another session’s same message UUID as authority', async () => {
    storeInput(holder);
    const claimed: OperationCaller = {
      source: 'mcp',
      sessionId: root,
      neoTurn: { messageId: ask, human: true, isLive: () => true },
    };
    const work = await propose(claimed);
    expect(await invoke('neo.work.start', { id: work.id }, claimed)).toMatchObject({
      value: { ok: false },
    });
    expect(jobs(work.id)).toEqual([]);
  });

  test('the human’s answer note acts for their message: it may start work and drop what their answer named, not what Neo wrote around it', async () => {
    storeInput();
    const opened = service.askRecords.open(
      {
        id: 'ask-answered',
        requestKey: 'ask-answered',
        projectId: null,
        originSessionId: root,
        originMessageId: ask,
        title: 'Publish the go vet result',
        ask: 'Publish the go vet result',
        doneWhen: '- go vet result delivered\n- go vet passes',
        doneSource: 'human',
      },
      [
        { text: 'go vet result delivered', check: null },
        { text: 'go vet passes', check: null },
      ]
    )!;
    const work = await propose(caller());
    const note = `neo-ask-answer:${opened.id}:i1:1`;
    await service.deliverAskAnswer(opened, opened.doneItems![0], 'Drop the go vet result check');
    const [delivered] = db
      .getJobQueueRepo()
      .listActiveByPayload('mailbox', { 'to.sessionId': root })
      .filter((job) =>
        (job.payload as { messageUuid: string }).messageUuid.startsWith('neo-ask-answer:')
      );
    const noteId = (delivered.payload as { messageUuid: string }).messageUuid;
    expect(noteId.startsWith(note.slice(0, -1))).toBe(true);
    db.getSDKMessageRepo().saveSDKMessage(root, {
      type: 'user',
      uuid: noteId,
      session_id: root,
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content:
          'The human answered a decision on ask ask-answered, item i9: "Keep go vet passes?".\nTheir answer: Drop the go vet result check',
      },
      inputKind: 'system',
    } as SDKMessage);
    expect(service.inputTrigger({ sessionId: root, messageId: noteId })).toBe(`human:${ask}`);
    const answering = caller(root, noteId);
    expect(answering.neoTurn).toMatchObject({ human: true, origin: ask });
    expect(await invoke('neo.work.start', { id: work.id }, answering)).toMatchObject({
      value: { ok: true },
    });
    expect(
      await invoke(
        'neo.ask.edit',
        {
          askId: opened.id,
          expectedRevision: service.askRecords.get(opened.id)!.revision,
          remove: ['i2'],
          humanSaid: 'Keep go vet passes',
        },
        answering
      )
    ).toMatchObject({ value: { ok: false, reason: expect.stringContaining('scope_kept') } });
    expect(
      await invoke(
        'neo.ask.edit',
        {
          askId: opened.id,
          expectedRevision: service.askRecords.get(opened.id)!.revision,
          remove: ['i1'],
          humanSaid: 'Drop the go vet result check',
        },
        answering
      )
    ).toMatchObject({ value: { ok: true } });
    expect(service.askRecords.get(opened.id)!.doneItems![0]).toMatchObject({ removed: true });
  });

  test('a continuation of the human’s own turn may start its work; a plain continuation may not', async () => {
    storeInput();
    const work = await propose(caller());
    const continuation = (messageId: string) => {
      storeInput(root, 'system', messageId);
      service.inputOrigins.record(
        { sessionId: root, messageId },
        { sessionId: root, messageId: ask },
        0,
        `human:${ask}`
      );
      return caller(root, messageId);
    };
    expect(
      await invoke('neo.work.start', { id: work.id }, continuation('neo-turn-limit:r1'))
    ).toMatchObject({ value: { ok: false } });
    expect(service.repo.getWork(work.id)?.status).toBe('proposed');
    expect(
      await invoke('neo.work.start', { id: work.id }, continuation('neo-turn-limit:human:r2'))
    ).toMatchObject({ value: { ok: true, work: { status: 'queued' } } });
  });

  test('rejects a new human ask trying to start a previous ask’s proposal', async () => {
    storeInput();
    const original = caller();
    const work = await propose(original);
    const next = '00000000-0000-4000-8000-000000000002';
    storeInput(root, 'human', next);
    const newer = caller(root, next);
    expect(await invoke('neo.work.start', { id: work.id }, newer)).toMatchObject({
      value: { ok: false },
    });
    expect(service.repo.getWork(work.id)?.status).toBe('proposed');
    expect(jobs(work.id)).toEqual([]);
  });

  test('refuses a consultation even if a persisted human prompt shares its UUID', async () => {
    const id = 'fictional-consultation';
    const messageId = `neo-consult:${id}:request`;
    storeInput(holder, 'human', messageId);
    service.consultations.reserve({
      id,
      requestKey: id,
      projectId: 'fictional-concern',
      originSessionId: root,
      sessionId: holder,
      question: 'Fictional context check',
    });
    const source = caller(holder, messageId);
    expect(source.neoTurn).toMatchObject({ human: false, consultationId: id });
    const work = await propose(source);
    expect(await invoke('neo.work.start', { id: work.id }, source)).toMatchObject({
      value: {
        ok: false,
        reason:
          'Neo can do this only while answering the human’s own chat message, not from a system note or consultation.',
      },
    });
    expect(jobs(work.id)).toEqual([]);
  });

  test('rechecks the actual attempt after native target validation before any delivery', async () => {
    storeInput();
    const source = caller();
    const work = await propose(source);
    const resolve = service.resolveWorkTarget.bind(service);
    const validation = spyOn(service, 'resolveWorkTarget').mockImplementation((id) => {
      const result = resolve(id);
      turns[0].dispose();
      return result;
    });
    expect(await invoke('neo.work.start', { id: work.id }, source)).toMatchObject({
      value: { ok: false },
    });
    expect(service.repo.getWork(work.id)?.status).toBe('proposed');
    expect(jobs(work.id)).toEqual([]);
    validation.mockRestore();
  });

  test('preserves the local human approval path for an older proposal', async () => {
    const work = await propose(local);
    expect(await invoke('neo.work.start', { id: work.id }, local)).toMatchObject({
      value: { ok: true, work: { status: 'queued' } },
    });
    expect(jobs(work.id)).toHaveLength(1);
  });

  test.each(['archived', 'superseded'] as const)(
    'refuses an %s human turn without creating a native delivery',
    async (state) => {
      storeInput();
      const source = caller();
      const work = await propose(source);
      if (state === 'archived') db.updateSession(root, { status: 'archived' });
      else attempts.allocate();
      expect(await invoke('neo.work.start', { id: work.id }, source)).toMatchObject({
        value: { ok: false },
      });
      expect(service.repo.getWork(work.id)?.status).toBe('proposed');
      expect(jobs(work.id)).toEqual([]);
    }
  );

  test('a claimed Neo role cannot turn an execution worker into a human coordinator', async () => {
    const work = await propose(local);
    storeInput(target);
    service.repo.reserveBinding({ sessionId: target, kind: 'worker', projectId: null });
    const source = { ...caller(target), role: 'neo' as const };
    expect(await invoke('neo.work.start', { id: work.id }, source)).toMatchObject({
      value: { ok: false },
    });
    expect(jobs(work.id)).toEqual([]);
  });

  test('MCP arguments cannot supply another caller or human authority', async () => {
    const source: OperationCaller = { source: 'mcp', sessionId: root };
    const work = await propose(local);
    const handler = createOperationMcpHandler(
      createOperationRegistry(createNeoOperations(service)),
      () => source
    );
    const result = await handler({
      name: 'neo.work.start',
      input: { id: work.id },
      caller: local,
      human: true,
    });
    expect(JSON.stringify(result)).toContain(
      'Neo can do this only while answering the human’s own chat message, not from a system note or consultation.'
    );
    expect(jobs(work.id)).toEqual([]);
  });

  test.each([
    [true, undefined, 'human', true],
    [false, undefined, 'human', false],
    [true, 'consultation', 'human', false],
    [true, undefined, 'system', false],
  ] as const)(
    'requires runtime human=%s, consultation=%s and stored kind=%s',
    (human, consultationId, inputKind, expected) => {
      const source: OperationCaller = {
        source: 'mcp',
        sessionId: root,
        neoTurn: { messageId: ask, human, consultationId, isLive: () => true },
      };
      expect(hasNeoHumanWorkInput(source, [{ type: 'user', inputKind }])).toBe(expected);
      expect(
        'value' in
          requireNeoHumanWorkOrigin({ originSessionId: root, originMessageId: ask }, source)
      ).toBe(human && !consultationId);
    }
  );
});
