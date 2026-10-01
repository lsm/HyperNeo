import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { vi } from 'vitest';
import type { MessageHub } from '@hyperneo/shared';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import { NeoService } from '../../../../src/lib/neo/service.ts';
import { NeoHolderTurn } from '../../../../src/lib/neo/holder-turn.ts';
import { reusePublicationReceipt } from '../../../../src/lib/neo/publication-operation.ts';
import { CONSULTATION_TIMEOUT_MS } from '../../../../src/lib/neo/consultation-policy.ts';
import { createNeoOperations } from '../../../../src/lib/neo/operations.ts';
import { InternalEventBus } from '../../../../src/lib/internal-event-bus.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';

const conversationId = '10000000-0000-4000-8000-000000000001';
const root = `neo:${conversationId}`;
const holder = 'neo:holder:fictional';
const request = 'neo-consult:check:request';
const ask = { sessionId: root, messageId: 'original-ask' };
const draft = {
  publicationId: '20000000-0000-4000-8000-000000000001',
  shortText: 'The fictional comparison is ready.',
  fullText: '**Source B** differs. This is evidence, not completed execution.',
  links: [{ kind: 'consultation' as const, id: 'check', label: 'View comparison' }],
};

describe('runtime consultation publication commit', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let service: NeoService;
  let turns: NeoHolderTurn[];
  const event = vi.fn(() => {});
  const createSession = vi.fn();
  const getSessionAsync = vi.fn();
  const restart = () => {
    service?.dispose();
    service = new NeoService(
      db,
      { createSession, getSessionAsync } as unknown as SessionManager,
      { event } as unknown as MessageHub,
      new InternalEventBus()
    );
  };
  const prompt = (sessionId: string, messageId: string, inputKind: 'human' | 'system') => {
    expect(
      db.getSDKMessageRepo().saveSDKMessage(sessionId, {
        type: 'user',
        uuid: messageId,
        session_id: sessionId,
        parent_tool_use_id: null,
        inputKind,
        message: { role: 'user', content: 'Compare these fictional sources.' },
      } as SDKUserMessage)
    ).toBe(true);
  };
  const caller = (sessionId = holder, messageId = request): OperationCaller => {
    const turn = new NeoHolderTurn(db, sessionId, { isLive: () => true }, () => {});
    turns.push(turn);
    expect(turn.bind(messageId)).toBe(true);
    return { source: 'mcp', sessionId, role: 'neo', neoTurn: turn.identity() };
  };
  const invoke = (input: unknown, who: OperationCaller) =>
    invokeOperation(
      createOperationRegistry(createNeoOperations(service)),
      'neo.publication.publish',
      input,
      who
    );
  const rows = () => ({
    consultation: service.consultations.get('check'),
    association: service.consultations.getPublication('check'),
    publications: service.publications.list(conversationId),
  });
  const unchanged = () => {
    expect(rows()).toMatchObject({
      consultation: { status: 'pending', answer: null },
      association: null,
      publications: [],
    });
    expect(event).not.toHaveBeenCalled();
  };
  beforeEach(async () => {
    db = await createTestDb();
    turns = [];
    event.mockReset();
    createSession.mockReset();
    getSessionAsync.mockReset();
    for (const id of [root, holder]) db.createSession(createTestSession(id));
    restart();
    service.repo.saveConcern({ id: 'fictional', title: 'Sources', summary: '', context: '' }, 0);
    service.repo.reserveBinding({ sessionId: root, concernId: null, kind: 'neo' });
    service.repo.reserveBinding({ sessionId: holder, concernId: 'fictional', kind: 'concern' });
    service.consultations.reserve({
      id: 'check',
      requestKey: 'check',
      concernId: 'fictional',
      originSessionId: root,
      originMessageId: ask.messageId,
      sessionId: holder,
      question: 'Compare the sources.',
    });
    prompt(root, ask.messageId, 'human');
    prompt(holder, request, 'system');
    event.mockClear();
  });
  afterEach(() => {
    for (const turn of turns) turn.dispose();
    service.dispose();
    db.close();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  test('the real registered operation commits the authored tuple jointly without execution or resummary', async () => {
    const who = caller();
    const atNotify: unknown[] = [];
    event.mockImplementation(() => {
      atNotify.push(rows());
    });
    prompt(root, 'newer-unrelated-ask', 'human');
    const sdkBefore = db.getDatabase().prepare('SELECT * FROM sdk_messages').all();
    expect(await invoke(draft, who)).toMatchObject({
      kind: 'completed',
      value: {
        accepted: true,
        created: true,
        publication: {
          ...draft,
          conversationId,
          askOrigin: ask,
          producerInput: { sessionId: holder, messageId: request },
          sequence: 1,
        },
      },
    });
    expect(rows()).toMatchObject({
      consultation: { status: 'reported', answer: draft.fullText },
      association: {
        consultationId: 'check',
        publicationId: draft.publicationId,
        answer: draft.fullText,
      },
      publications: [{ ...draft, askOrigin: ask }],
    });
    expect(atNotify).toHaveLength(1);
    expect(atNotify[0]).toEqual(rows());
    expect(db.getDatabase().prepare('SELECT * FROM sdk_messages').all()).toEqual(sdkBefore);
    expect(db.getJobQueueRepo().listActiveByPayload('mailbox', {})).toEqual([]);
    expect(createSession).not.toHaveBeenCalled();
    expect(getSessionAsync).not.toHaveBeenCalled();
  });

  test('service reload preserves the original joint receipt and rejects changed authored content', () => {
    const who = caller();
    const first = service.publish(draft, who);
    const committed = rows();
    restart();
    const retry = service.publish(draft, who);
    if (!first.accepted || !retry.accepted) throw new Error('Expected immutable receipts');
    expect(retry).toEqual({ ...first, created: false });
    expect(rows()).toEqual(committed);
    for (const changed of [
      { shortText: 'Changed' },
      { fullText: 'Changed' },
      { publicationId: '20000000-0000-4000-8000-000000000002' },
      { links: [{ ...draft.links[0], label: 'Changed label' }] },
    ]) {
      expect(service.publish({ ...draft, ...changed }, who)).toEqual({
        accepted: false,
        reason: 'publication_conflict',
      });
      expect(rows()).toEqual(committed);
    }
    expect(event).toHaveBeenCalledTimes(2);
  });

  test.each(['dead', 'expired', 'binding', 'rpc'])(
    'refuses %s runtime evidence without partially settling or publishing',
    async (kind) => {
      let who = caller();
      if (kind === 'dead') who = { ...who, neoTurn: { ...who.neoTurn!, isLive: () => false } };
      if (kind === 'expired')
        db.getDatabase().prepare('UPDATE neo_consultations SET created_at = 0').run();
      if (kind === 'binding')
        db.getDatabase()
          .prepare('DELETE FROM neo_session_bindings WHERE session_id = ?')
          .run(holder);
      if (kind === 'rpc') who = { ...who, source: 'rpc' };
      expect(await invoke(draft, who)).toMatchObject({ value: { accepted: false } });
      unchanged();
    }
  );

  test.each(['neo_publications', 'neo_consultation_publications', 'neo_consultations'])(
    'rolls back all rows if the actual %s write faults',
    (table) => {
      const who = caller();
      const action = table === 'neo_consultations' ? 'UPDATE' : 'INSERT';
      db.getDatabase().exec(`CREATE TRIGGER fail_wire BEFORE ${action} ON ${table}
        BEGIN SELECT RAISE(ABORT, 'fictional commit fault'); END`);
      expect(() => service.publish(draft, who)).toThrow('fictional commit fault');
      unchanged();
    }
  );

  test('lost settlement CAS rolls back the publication rather than leaking an orphan', () => {
    const who = caller();
    db.getDatabase().exec(`CREATE TRIGGER lost_wire BEFORE UPDATE ON neo_consultations
      BEGIN SELECT RAISE(IGNORE); END`);
    expect(service.publish(draft, who)).toEqual({
      accepted: false,
      reason: 'consultation_settled',
    });
    unchanged();
  });

  test('notification failure does not turn a durable joint commit into a claimed failure', () => {
    const who = caller();
    event.mockImplementation(() => {
      throw new Error('Fictional listener fault');
    });
    expect(service.publish(draft, who)).toMatchObject({ accepted: true, created: true });
    expect(rows().consultation?.status).toBe('reported');
    expect(rows().association?.publicationId).toBe(draft.publicationId);
    expect(rows().publications).toHaveLength(1);
  });

  test('direct holder asks keep their own session origin without settling an unrelated consultation', () => {
    prompt(holder, 'holder-human', 'human');
    const who = caller(holder, 'holder-human');
    expect(service.publish({ ...draft, links: [] }, who)).toMatchObject({
      accepted: true,
      publication: {
        askOrigin: { sessionId: holder, messageId: 'holder-human' },
        producerInput: { sessionId: holder, messageId: 'holder-human' },
      },
    });
    expect(service.consultations.get('check')?.status).toBe('pending');
    expect(service.consultations.getPublication('check')).toBeNull();
    expect(event).toHaveBeenCalledTimes(1);
    expect(service.publications.get(conversationId, draft.publicationId)).toEqual(
      rows().publications?.[0] ?? null
    );
    expect(service.publications.get(crypto.randomUUID(), draft.publicationId)).toBeNull();
  });

  test('a genuinely timed-out holder turn can replay only its original committed authored tuple', () => {
    vi.useFakeTimers();
    const who = caller();
    const first = service.publish(draft, who);
    if (!first.accepted) throw new Error('Expected committed receipt');
    const committed = rows();
    vi.advanceTimersByTime(CONSULTATION_TIMEOUT_MS + 1);
    expect(who.neoTurn?.isLive()).toBe(false);
    restart();
    const sdk = db.getDatabase();
    sdk.prepare('DELETE FROM sdk_messages').run();
    const retry = service.publish(draft, who);
    if (!retry.accepted) throw new Error('Expected durable replay');
    expect(retry).toEqual({ ...first, created: false });
    expect(rows()).toEqual(committed);
    for (const changed of [
      { publicationId: crypto.randomUUID() },
      { shortText: 'Different' },
      { fullText: 'Different' },
      { links: [] },
    ]) {
      expect(service.publish({ ...draft, ...changed }, who)).toEqual({
        accepted: false,
        reason: 'publication_conflict',
      });
      expect(rows()).toEqual(committed);
    }
    expect(event).toHaveBeenCalledTimes(2);
  });

  test.each(['rpc', 'binding', 'message', 'consultation', 'root'])(
    'a committed receipt does not bypass %s ownership',
    (kind) => {
      const who = caller();
      expect(service.publish(draft, who).accepted).toBe(true);
      const before = rows();
      let impostor: OperationCaller = { ...who, neoTurn: { ...who.neoTurn!, isLive: () => false } };
      if (kind === 'rpc') impostor = { ...impostor, source: 'rpc' };
      if (kind === 'message')
        impostor = { ...impostor, neoTurn: { ...impostor.neoTurn!, messageId: 'other' } };
      if (kind === 'consultation')
        impostor = { ...impostor, neoTurn: { ...impostor.neoTurn!, consultationId: 'other' } };
      if (kind === 'binding')
        db.getDatabase()
          .prepare('DELETE FROM neo_session_bindings WHERE session_id = ?')
          .run(holder);
      if (kind === 'root')
        db.getDatabase().prepare('DELETE FROM neo_session_bindings WHERE session_id = ?').run(root);
      expect(service.publish(draft, impostor).accepted).toBe(false);
      expect(rows()).toEqual(before);
      expect(event).toHaveBeenCalledTimes(1);
    }
  );

  test('the pure replay gate stops for either receipt arm and continues only without a receipt', () => {
    expect(reusePublicationReceipt(draft, null)).toEqual({ value: draft });
    const refused = { accepted: false as const, reason: 'publication_conflict' };
    expect(reusePublicationReceipt(draft, refused)).toEqual({ reason: refused });
    const who = caller();
    const first = service.publish(draft, who);
    expect(reusePublicationReceipt(draft, first)).toEqual({ reason: first });
  });
});
