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
import { InternalEventBus } from '../../../../src/lib/internal-event-bus.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import {
  hasNeoHumanWorkInput,
  requireNeoHumanWorkOrigin,
} from '../../../../src/lib/neo/work-origin.ts';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';

describe('Neo existing trusted human work input', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let service: NeoService;
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
    service = new NeoService(
      db,
      { createSession: created, getSessionAsync: loaded } as unknown as SessionManager,
      { event: mock(() => {}) } as unknown as MessageHub,
      new InternalEventBus()
    );
    service.repo.reserveBinding({ sessionId: root, kind: 'neo', concernId: null });
    service.repo.saveConcern(
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
      kind: 'concern',
      concernId: 'fictional-concern',
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
        concernId: source.sessionId === holder ? 'fictional-concern' : null,
        title: 'Fictional bounded work',
        instruction: 'Use only the existing fictional target.',
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

  test('lets Neo start the work items of an ask the user approved, on later turns', async () => {
    storeInput();
    const work = await propose(caller());
    const opened = service.askRecords.open({
      id: 'fictional-ask',
      requestKey: 'fictional-ask',
      concernId: null,
      originSessionId: root,
      originMessageId: ask,
      title: 'Fictional',
      ask: 'Do the bounded fictional work.',
      doneWhen: '- done',
      doneSource: 'human',
    })!;
    service.askRecords.link(opened.id, work.id);
    const later = caller(root, '00000000-0000-4000-8000-000000000009');
    expect(later.neoTurn?.human).toBe(false);
    const refused = { value: { ok: false, reason: 'This action needs the user.' } };
    expect(await invoke('neo.work.start', { id: work.id }, later)).toMatchObject(refused);
    expect(await invoke('neo.ask.approve', { askId: opened.id }, later)).toMatchObject(refused);

    expect(await invoke('neo.ask.approve', { askId: opened.id })).toMatchObject({
      value: { ok: true, ask: { id: opened.id, approvedAt: expect.any(Number) } },
    });
    const other = caller(holder, '00000000-0000-4000-8000-000000000010');
    expect(await invoke('neo.work.start', { id: work.id }, other)).toMatchObject({
      value: { ok: false },
    });
    const next = caller(root, '00000000-0000-4000-8000-000000000011');
    expect(await invoke('neo.work.start', { id: work.id }, next)).toMatchObject({
      value: { ok: true, work: { status: 'queued', sessionId: target } },
    });
    expect(jobs(work.id)).toHaveLength(1);
  });

  test.each(['system', 'internal_compaction', 'missing'])(
    'refuses %s input even with a claimed human flag',
    async (kind) => {
      if (kind !== 'missing') storeInput(root, kind);
      const source = caller();
      const claimed = { ...source, neoTurn: { ...source.neoTurn!, human: true } };
      const work = await propose(claimed);
      expect(await invoke('neo.work.start', { id: work.id }, claimed)).toMatchObject({
        value: { ok: false, reason: 'This action needs the user.' },
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
      concernId: 'fictional-concern',
      originSessionId: root,
      sessionId: holder,
      question: 'Fictional context check',
    });
    const source = caller(holder, messageId);
    expect(source.neoTurn).toMatchObject({ human: false, consultationId: id });
    const work = await propose(source);
    expect(await invoke('neo.work.start', { id: work.id }, source)).toMatchObject({
      value: { ok: false, reason: 'This action needs the user.' },
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
    service.repo.reserveBinding({ sessionId: target, kind: 'worker', concernId: null });
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
    expect(JSON.stringify(result)).toContain('This action needs the user.');
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
