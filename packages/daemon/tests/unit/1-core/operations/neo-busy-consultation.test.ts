import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import type { MessageHub } from '@hyperneo/shared';
import type { NeoConsultation, NeoConsultationWaiter } from '@hyperneo/shared/types/neo-context';
import type { NeoSnapshot } from '@hyperneo/shared/types/neo-snapshot';
import { NeoService } from '../../../../src/lib/neo/service.ts';
import { createNeoOperations } from '../../../../src/lib/neo/operations.ts';
import {
  InternalEventBus,
  type DaemonInternalEventMap,
} from '../../../../src/lib/internal-event-bus.ts';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';
import { CONSULTATION_TIMEOUT_MS } from '../../../../src/lib/neo/consultation-policy.ts';

const human: OperationCaller = { source: 'rpc', principal: 'local' };
const ids = [
  '80d497a1-3a01-484d-a730-cc047a8c417a',
  'a1e6cbaa-67ed-4162-9b4e-4a3ec1c732ec',
  'dc42c3ee-9d52-422f-8ac0-c445d5b8964d',
  '37dc2e80-26c2-4d55-9c78-a809841c727f',
];
type Receipt = { ok: true; consultation?: NeoConsultation; waiter?: NeoConsultationWaiter };

describe('Neo durable busy consultation intake', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let service: NeoService;
  let events: InternalEventBus<DaemonInternalEventMap>;
  const createSession = mock(async () => {
    throw new Error('Must reuse the holder');
  });
  const getSessionAsync = mock(async () => {
    throw new Error('Must not interrupt the holder');
  });
  function restart() {
    service?.dispose();
    service = new NeoService(
      db,
      { createSession, getSessionAsync } as unknown as SessionManager,
      { event: mock(() => {}) } as unknown as MessageHub,
      events
    );
  }
  beforeEach(async () => {
    db = await createTestDb();
    events = new InternalEventBus<DaemonInternalEventMap>();
    createSession.mockClear();
    getSessionAsync.mockClear();
    for (const id of ['root', 'research-holder', 'family-holder'])
      db.createSession({ ...createTestSession(id), workspacePath: null });
    restart();
    service.repo.reserveBinding({ sessionId: 'root', concernId: null, kind: 'neo' });
    for (const id of ['research', 'family']) {
      service.repo.saveConcern(
        { id, title: id, summary: 'Current', context: 'Private original' },
        0
      );
      service.repo.reserveBinding({ sessionId: `${id}-holder`, concernId: id, kind: 'concern' });
    }
  });
  afterEach(() => {
    service.dispose();
    db.close();
  });
  function invoke(name: string, input: unknown, caller = human) {
    return invokeOperation(
      createOperationRegistry(createNeoOperations(service)),
      name,
      input,
      caller
    );
  }
  function caller(messageId: string): OperationCaller {
    return {
      source: 'mcp',
      role: 'neo',
      sessionId: 'root',
      neoTurn: { messageId, human: true, isLive: () => true },
    };
  }
  async function ask(index: number) {
    const messageId = ids[index];
    expect(
      await invoke('neo.message.send', {
        sessionId: 'root',
        requestId: messageId,
        content: `Ask ${index}`,
      })
    ).toMatchObject({
      value: { ok: true, messageId },
    });
    return caller(messageId);
  }
  async function consult(index: number, concernId = 'research') {
    const source = await ask(index);
    const input = { concernId, requestKey: `ask-${index}`, question: `Question ${index}` };
    const result = await invoke('neo.concern.consult', input, source);
    expect(result).toMatchObject({ kind: 'completed', value: { ok: true } });
    return { input, source, receipt: (result as { value: Receipt }).value };
  }
  function jobs(sessionId: string, messageUuid: string) {
    return db
      .getJobQueueRepo()
      .listActiveByPayload('mailbox', { 'to.sessionId': sessionId, messageUuid });
  }
  async function answer(item: NeoConsultation) {
    const result = await invoke(
      'neo.concern.respond',
      { id: item.id, answer: `Answer ${item.originMessageId}` },
      {
        source: 'mcp',
        role: 'neo',
        sessionId: item.sessionId,
        neoTurn: {
          messageId: `neo-consult:${item.id}:request`,
          consultationId: item.id,
          human: false,
          isLive: () => true,
        },
      }
    );
    expect(result).toMatchObject({ value: { ok: true, consultation: { status: 'reported' } } });
  }
  test('durably queues the exact correction while unrelated asks and holders remain available', async () => {
    const a = (await consult(0)).receipt.consultation!;
    const b = await consult(1);
    const waiter = b.receipt.waiter!;
    expect(waiter).toMatchObject({
      status: 'queued',
      originMessageId: ids[1],
      sessionId: a.sessionId,
    });
    expect(service.consultations.get(waiter.id)).toBeNull();
    expect(
      db
        .getDatabase()
        .prepare('SELECT * FROM neo_context_write_grants WHERE consultation_id = ?')
        .all(waiter.id)
    ).toEqual([]);
    expect(jobs(a.sessionId, `neo-consult:${waiter.id}:request`)).toEqual([]);
    expect((await consult(2, 'family')).receipt.consultation?.status).toBe('pending');
    await ask(3);
    expect(service.repo.listConcerns()).toHaveLength(2);
    expect(service.repo.listWork()).toEqual([]);
    const snapshot = await invoke('neo.snapshot', {}, b.source);
    expect(snapshot).toMatchObject({
      value: {
        consultationWaiters: [{ id: waiter.id, question: '' }],
        askOrigins: expect.arrayContaining([
          { kind: 'consultation', id: waiter.id, origin: { sessionId: 'root', messageId: ids[1] } },
        ]),
      },
    });
    expect(await invoke('neo.snapshot', {}, human)).toMatchObject({
      value: { consultationWaiters: [{ question: b.input.question }] },
    });
    expect(
      await invoke('neo.snapshot', {}, { source: 'mcp', role: 'neo', sessionId: 'family-holder' })
    ).toMatchObject({ value: { consultationWaiters: [] } });
    expect(createSession).not.toHaveBeenCalled();
    expect(getSessionAsync).not.toHaveBeenCalled();
  });
  test('FIFO admission captures the current context grant and returns the correction to B, never A’s callback', async () => {
    const a = (await consult(0)).receipt.consultation!;
    const b = (await consult(1)).receipt.waiter!;
    const c = (await consult(2)).receipt.waiter!;
    service.repo.saveConcern(
      { id: 'research', title: 'research', summary: 'Changed', context: 'Latest human context' },
      1
    );
    await answer(a);
    const admitted = service.consultations.get(b.id)!;
    expect(admitted).toMatchObject({
      id: b.id,
      status: 'pending',
      originMessageId: ids[1],
      requestKey: b.requestKey,
    });
    expect(service.consultations.get(c.id)).toBeNull();
    expect(service.consultationWaiters.get(b.id)?.status).toBe('admitted');
    expect(jobs(b.sessionId, `neo-consult:${b.id}:request`)).toHaveLength(1);
    expect(JSON.stringify(jobs(b.sessionId, `neo-consult:${b.id}:request`)[0].payload)).toContain(
      ids[1]
    );
    expect(
      service.repo.saveConsultationContext(
        { id: 'research', title: 'research', summary: 'Correction B', context: 'BIRCH-42 paused' },
        2,
        b.id,
        b.sessionId
      )
    ).toMatchObject({ revision: 3 });
    await answer(admitted);
    expect(service.consultations.get(c.id)?.status).toBe('pending');
    const returned = jobs('root', `neo-consult:${b.id}:reply`);
    expect(returned).toHaveLength(1);
    expect(JSON.stringify(returned[0].payload)).toContain(ids[1]);
    const payload = returned[0].payload as { message: { message: { content: string } } };
    db.getSDKMessageRepo().saveSDKMessage(
      'root',
      {
        type: 'user',
        uuid: `neo-consult:${b.id}:reply`,
        session_id: 'root',
        parent_tool_use_id: null,
        inputKind: 'system',
        message: { role: 'user', content: payload.message.message.content },
      },
      'system'
    );
    expect(
      service.resolveAskOrigin({ sessionId: 'root', messageId: `neo-consult:${b.id}:reply` })
    ).toEqual({ sessionId: 'root', messageId: ids[1] });
    expect(service.repo.getConcern('family')?.revision).toBe(1);
    expect(service.consultations.list().filter((item) => item.status === 'pending')).toHaveLength(
      1
    );
    expect(service.repo.listWork()).toEqual([]);
  });
  test('queued retries remain stable and conflicting or foreign inputs cannot adopt a receipt', async () => {
    await consult(0);
    const b = await consult(1);
    for (const result of await Promise.all([
      invoke('neo.concern.consult', b.input, b.source),
      invoke('neo.concern.consult', b.input, b.source),
    ]))
      expect(result).toMatchObject({
        value: { waiter: { id: b.receipt.waiter!.id, status: 'queued' } },
      });
    for (const [input, source] of [
      [{ ...b.input, question: 'Changed' }, b.source],
      [{ ...b.input, concernId: 'family' }, b.source],
      [b.input, caller(ids[0])],
    ] as const)
      expect(await invoke('neo.concern.consult', input, source)).toMatchObject({
        value: { ok: false },
      });
    expect(service.consultationWaiters.queued()).toHaveLength(1);
    expect(service.consultations.list()).toHaveLength(1);
  });
  test('human cancellation tombstones only the queued ask and does not interrupt the shared holder', async () => {
    const a = (await consult(0)).receipt.consultation!;
    const b = await consult(1);
    const c = (await consult(2)).receipt.waiter!;
    const id = b.receipt.waiter!.id;
    for (const denied of [b.source, { source: 'rpc', principal: 'remote' } as OperationCaller])
      expect(await invoke('neo.concern.cancel', { id }, denied)).toMatchObject({
        value: { ok: false },
      });
    expect(service.consultationWaiters.get(id)?.status).toBe('queued');
    for (let i = 0; i < 2; i++)
      expect(await invoke('neo.concern.cancel', { id })).toMatchObject({
        value: { ok: true, waiter: { id, status: 'cancelled' } },
      });
    expect(await invoke('neo.concern.consult', b.input, b.source)).toMatchObject({
      value: { ok: false },
    });
    await answer(a);
    expect(service.consultations.get(id)).toBeNull();
    expect(service.consultations.get(c.id)?.status).toBe('pending');
    expect(jobs(a.sessionId, `neo-consult:${id}:request`)).toEqual([]);
    expect(getSessionAsync).not.toHaveBeenCalled();
  });
  test.each(['stop', 'expire', 'terminal'] as const)(
    'advances the queue after active %s without spending queued deadline',
    async (mode) => {
      const a = (await consult(0)).receipt.consultation!;
      const b = (await consult(1)).receipt.waiter!;
      db.getDatabase()
        .prepare('UPDATE neo_consultation_waiters SET created_at = ? WHERE id = ?')
        .run(Date.now() - CONSULTATION_TIMEOUT_MS * 2, b.id);
      if (mode === 'stop') await invoke('neo.concern.cancel', { id: a.id });
      if (mode === 'expire') {
        db.getDatabase()
          .prepare('UPDATE neo_consultations SET created_at = 0 WHERE id = ?')
          .run(a.id);
        await service.recoverConsultations();
      }
      if (mode === 'terminal') {
        const terminal = spyOn(db.getSDKMessageRepo(), 'hasTerminalResultAfter').mockImplementation(
          (_session, id) => id === `neo-consult:${a.id}:request`
        );
        await events.publish('session.updated', {
          sessionId: a.sessionId,
          processingState: { status: 'idle' },
        });
        terminal.mockRestore();
      }
      expect(service.consultations.get(a.id)?.status).toBe('failed');
      expect(service.consultations.get(b.id)).toMatchObject({
        status: 'pending',
        originMessageId: ids[1],
        createdAt: expect.any(Number),
      });
      expect(service.consultations.get(b.id)!.createdAt).toBeGreaterThan(Date.now() - 10_000);
      expect(jobs(b.sessionId, `neo-consult:${b.id}:request`)).toHaveLength(1);
      expect(getSessionAsync).not.toHaveBeenCalled();
    }
  );
  test('restart recovery delivers an admitted receipt after handoff failure without creating another identity', async () => {
    const a = (await consult(0)).receipt.consultation!;
    const b = (await consult(1)).receipt.waiter!;
    service.consultations.finish(a.id, 'reported', 'A completed');
    const queue = db.getJobQueueRepo();
    const handoff = spyOn(queue, 'enqueueUniquePending').mockImplementationOnce(() => {
      throw new Error('Mailbox unavailable');
    });
    await expect(service.dispatchConsultationWaiter('research')).rejects.toThrow(
      'Mailbox unavailable'
    );
    handoff.mockRestore();
    expect(service.consultationWaiters.get(b.id)?.status).toBe('admitted');
    expect(service.consultations.get(b.id)?.originMessageId).toBe(ids[1]);
    expect(jobs(b.sessionId, `neo-consult:${b.id}:request`)).toEqual([]);
    restart();
    await service.recoverConsultations();
    await service.recoverConsultations();
    expect(jobs(b.sessionId, `neo-consult:${b.id}:request`)).toHaveLength(1);
    expect(jobs('root', `neo-consult:${a.id}:reply`)).toHaveLength(1);
    expect(service.consultations.list()).toHaveLength(2);
    expect(service.consultationWaiters.queued()).toEqual([]);
    await answer(service.consultations.get(b.id)!);
    expect(jobs('root', `neo-consult:${b.id}:reply`)).toHaveLength(1);
  });
  test('an idle holder drains a persisted orphan queue without awaiting another holder', async () => {
    const source = await ask(1);
    const waiter = service.consultationWaiters.enqueue({
      id: 'persisted-B',
      requestKey: 'B',
      concernId: 'research',
      originSessionId: 'root',
      originMessageId: source.neoTurn!.messageId,
      sessionId: 'research-holder',
      question: 'Persisted correction',
    })!;
    await events.publish('session.updated', {
      sessionId: 'research-holder',
      processingState: { status: 'idle' },
    });
    expect(service.consultations.get(waiter.id)).toMatchObject({
      status: 'pending',
      originMessageId: ids[1],
    });
    expect(jobs(waiter.sessionId, `neo-consult:${waiter.id}:request`)).toHaveLength(1);
  });
  test('snapshot exposes queued receipts as distinct from active deadline-bearing consultations', async () => {
    await consult(0);
    const b = (await consult(1)).receipt.waiter!;
    const result = await invoke('neo.snapshot', {}, human);
    const value = (result as { value: NeoSnapshot }).value;
    expect(value.consultations).toHaveLength(1);
    expect(value.consultationWaiters).toEqual([b]);
    const schema = createNeoOperations(service).find(
      (item) => item.name === 'neo.snapshot'
    )!.resultSchema;
    expect(schema.safeParse(value).success).toBe(true);
    const { consultationWaiters: _ignored, ...legacy } = value;
    expect(schema.safeParse(legacy).success).toBe(true);
  });
});
