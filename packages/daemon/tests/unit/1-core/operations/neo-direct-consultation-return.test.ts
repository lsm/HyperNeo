import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { vi } from 'vitest';
import type { MessageHub } from '@hyperneo/shared';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import type { NeoPublication } from '@hyperneo/shared/types/neo-publication';
import { NeoService } from '../../../../src/lib/neo/service.ts';
import { NeoHolderTurn } from '../../../../src/lib/neo/holder-turn.ts';
import { requireConsultationPayload } from '../../../../src/lib/neo/consultation-return-route.ts';
import { createNeoOperations } from '../../../../src/lib/neo/operations.ts';
import {
  InternalEventBus,
  type DaemonInternalEventMap,
} from '../../../../src/lib/internal-event-bus.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import { createOperationRegistry } from '../../../../src/lib/operations/registry.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';

const conversationId = '10000000-0000-4000-8000-000000000001';
const root = `neo:${conversationId}`;
const holder = 'neo:holder:fictional';
const ask = { sessionId: root, messageId: 'original-ask' };
const draft = {
  publicationId: '20000000-0000-4000-8000-000000000001',
  shortText: 'The fictional comparison is ready.',
  fullText: '**Source B** differs. Execution completion is not verified.',
  links: [{ kind: 'consultation' as const, id: 'check', label: 'View comparison' }],
};
const authored: NeoPublication = {
  ...draft,
  conversationId,
  askOrigin: ask,
  producerInput: { sessionId: holder, messageId: 'neo-consult:check:request' },
  sequence: 1,
  createdAt: '2026-10-01T00:00:00.000Z',
};
const captured = {
  conversationId,
  ...draft,
  askOrigin: ask,
  producerInput: authored.producerInput,
};

describe('requireConsultationPayload', () => {
  test.each([
    ['matching capture', captured, true],
    ['legacy caller', undefined, true],
    ['missing capture', null, false],
    ['short text', { ...captured, shortText: 'Different' }, false],
    ['full text', { ...captured, fullText: 'Different' }, false],
    ['links', { ...captured, links: [] }, false],
    ['label', { ...captured, links: [{ ...draft.links[0], label: 'Different' }] }, false],
    ['ask session', { ...captured, askOrigin: { ...ask, sessionId: holder } }, false],
    ['ask message', { ...captured, askOrigin: { ...ask, messageId: 'newer' } }, false],
    ['producer', { ...captured, producerInput: ask }, false],
    ['conversation', { ...captured, conversationId: crypto.randomUUID() }, false],
    ['publication', { ...captured, publicationId: crypto.randomUUID() }, false],
  ] as const)('checks %s', (_name, input, accepted) => {
    const result = requireConsultationPayload(authored, input);
    expect(result).toEqual(accepted ? { value: authored } : { reason: 'inconsistent' });
    if ('value' in result) expect(result.value).toBe(authored);
    expect(result).not.toBeInstanceOf(Promise);
  });
});

describe('NeoService direct consultation return', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let service: NeoService;
  let events: InternalEventBus<DaemonInternalEventMap>;
  const turns: NeoHolderTurn[] = [];
  const createSession = vi.fn();
  const getSessionAsync = vi.fn();
  const restart = () => {
    service?.dispose();
    events = new InternalEventBus();
    service = new NeoService(
      db,
      { createSession, getSessionAsync } as unknown as SessionManager,
      { event: vi.fn() } as unknown as MessageHub,
      events
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
        message: { role: 'user', content: 'Compare fictional sources.' },
      } as SDKUserMessage)
    ).toBe(true);
  };
  const reserve = (id = 'check', originMessageId: string | null = ask.messageId) =>
    service.consultations.reserve({
      id,
      requestKey: id,
      concernId: 'fictional',
      originSessionId: root,
      originMessageId,
      sessionId: holder,
      question: 'Compare the sources.',
    })!;
  const publish = async (id = 'check') => {
    const messageId = `neo-consult:${id}:request`;
    prompt(holder, messageId, 'system');
    const turn = new NeoHolderTurn(db, holder, { isLive: () => true }, () => {});
    turns.push(turn);
    expect(turn.bind(messageId)).toBe(true);
    const outcome = await invokeOperation(
      createOperationRegistry(createNeoOperations(service)),
      'neo.publication.publish',
      { ...draft, links: [{ ...draft.links[0], id }] },
      { source: 'mcp', sessionId: holder, role: 'neo', neoTurn: turn.identity() }
    );
    expect(outcome).toMatchObject({ kind: 'completed', value: { accepted: true, created: true } });
    return service.publications.get(conversationId, draft.publicationId)!;
  };
  const mailbox = () =>
    db.getDatabase().prepare("SELECT * FROM job_queue WHERE queue = 'mailbox'").all();
  const returned = (id = 'check') =>
    db.getDatabase().prepare('SELECT returned FROM neo_consultations WHERE id = ?').get(id);
  const receiptRows = () => [
    db.getDatabase().prepare('SELECT * FROM neo_consultation_publications').all(),
    db.getDatabase().prepare('SELECT * FROM neo_publications').all(),
  ];
  beforeEach(async () => {
    db = await createTestDb();
    createSession.mockReset();
    getSessionAsync.mockReset();
    for (const id of [root, holder]) db.createSession(createTestSession(id));
    restart();
    service.repo.saveConcern({ id: 'fictional', title: 'Sources', summary: '', context: '' }, 0);
    service.repo.reserveBinding({ sessionId: root, concernId: null, kind: 'neo' });
    service.repo.reserveBinding({ sessionId: holder, concernId: 'fictional', kind: 'concern' });
    prompt(root, ask.messageId, 'human');
    reserve();
  });
  afterEach(() => {
    for (const turn of turns.splice(0)) turn.dispose();
    service.dispose();
    db.close();
    vi.restoreAllMocks();
  });

  test('uses the registered joint commit and returns the original authored tuple without a root job', async () => {
    prompt(root, 'newer-unrelated-ask', 'human');
    const publication = await publish();
    const before = receiptRows();
    const sdk = db.getDatabase().prepare('SELECT * FROM sdk_messages').all();
    expect(publication).toMatchObject({
      ...draft,
      askOrigin: ask,
      producerInput: authored.producerInput,
    });
    expect(service.consultations.get('check')).toMatchObject({
      status: 'reported',
      answer: draft.fullText,
    });
    await service.syncConsultation('check');
    expect(returned()).toEqual({ returned: 1 });
    expect(mailbox()).toEqual([]);
    expect(receiptRows()).toEqual(before);
    expect(db.getDatabase().prepare('SELECT * FROM sdk_messages').all()).toEqual(sdk);
    expect(createSession).not.toHaveBeenCalled();
    expect(getSessionAsync).not.toHaveBeenCalled();
    await service.syncConsultation('check');
    expect(mailbox()).toEqual([]);
    expect(receiptRows()).toEqual(before);
  });
  test('reload and recovery need only the immutable receipt, not removed SDK history or a recaptured ask', async () => {
    await publish();
    const before = receiptRows();
    db.getDatabase().prepare('DELETE FROM sdk_messages').run();
    restart();
    vi.spyOn(service, 'resolveAskOrigin').mockImplementation(() => {
      throw new Error('Original ask must not be recaptured');
    });
    await service.recoverConsultations();
    expect(returned()).toEqual({ returned: 1 });
    expect(mailbox()).toEqual([]);
    expect(receiptRows()).toEqual(before);
    expect(service.resolveAskOrigin).not.toHaveBeenCalled();
    await service.recoverConsultations();
    expect(receiptRows()).toEqual(before);
  });
  test('a null-origin work review retains the actual holder human session/message pair', async () => {
    db.getDatabase().prepare('DELETE FROM neo_consultations').run();
    prompt(holder, 'holder-human', 'human');
    const work = service.repo.proposeWork({
      id: 'work',
      requestKey: 'work',
      concernId: 'fictional',
      originSessionId: holder,
      originMessageId: 'holder-human',
      title: 'Fictional work',
      instruction: 'Bounded work',
    });
    service.repo.transitionWork(work.id, work, { status: 'reported', report: 'Claimed only' });
    const id = 'neo-work:work:review';
    reserve(id, null);
    const publication = await publish(id);
    expect(publication.askOrigin).toEqual({ sessionId: holder, messageId: 'holder-human' });
    expect(publication.producerInput).toEqual({
      sessionId: holder,
      messageId: `neo-consult:${id}:request`,
    });
    db.getDatabase().prepare('DELETE FROM sdk_messages').run();
    restart();
    await service.syncConsultation(id);
    expect(returned(id)).toEqual({ returned: 1 });
    expect(mailbox()).toEqual([]);
    expect(service.consultations.get(id)?.originMessageId).toBeNull();
  });
  test.each([
    'missing-publication',
    'orphan-publication',
    'short',
    'links',
    'ask-session',
    'ask-message',
    'invalid-capture',
    'invalid-json',
  ])('refuses %s without marking returned or falling back to a root summary', async (fault) => {
    const publication = await publish();
    const sql = db.getDatabase();
    if (fault === 'missing-publication') {
      expect(() => sql.prepare('DELETE FROM neo_publications').run()).toThrow('FOREIGN KEY');
      vi.spyOn(service.publications, 'get').mockReturnValue(null);
    } else if (fault === 'orphan-publication')
      sql.prepare('DELETE FROM neo_consultation_publications').run();
    else {
      const input = service.consultations.getPublicationInput('check')!;
      const changed =
        fault === 'short'
          ? { ...input, shortText: 'Changed' }
          : fault === 'links'
            ? { ...input, links: [] }
            : fault === 'ask-session'
              ? { ...input, askOrigin: { ...ask, sessionId: holder } }
              : fault === 'ask-message'
                ? { ...input, askOrigin: { ...ask, messageId: 'newer' } }
                : {};
      sql
        .prepare('UPDATE neo_consultation_publications SET payload_json = ?')
        .run(fault === 'invalid-json' ? '{' : JSON.stringify(changed));
    }
    const before = receiptRows();
    await expect(service.syncConsultation('check')).rejects.toThrow();
    expect(returned()).toEqual({ returned: 0 });
    expect(mailbox()).toEqual([]);
    expect(receiptRows()).toEqual(before);
    expect(service.consultations.get('check')?.answer).toBe(publication.fullText);
  });
  test('duplicate orphan producer receipts are ambiguous, not legacy replies', async () => {
    await publish();
    expect(
      service.publications.append({ ...captured, publicationId: crypto.randomUUID() }).accepted
    ).toBe(true);
    db.getDatabase().prepare('DELETE FROM neo_consultation_publications').run();
    await expect(service.syncConsultation('check')).rejects.toThrow('Ambiguous');
    expect(returned()).toEqual({ returned: 0 });
    expect(mailbox()).toEqual([]);
  });
  test('the actual idle event completes the published return without adding a mailbox job', async () => {
    await publish();
    await events.publish('session.updated', {
      sessionId: holder,
      processingState: { status: 'idle' },
    });
    expect(returned()).toEqual({ returned: 1 });
    expect(mailbox()).toEqual([]);
  });
  test.each(['reported', 'failed'] as const)(
    'preserves the %s legacy reply path',
    async (status) => {
      service.consultations.finish('check', status, 'Recorded legacy answer');
      await service.syncConsultation('check');
      expect(returned()).toEqual({ returned: 1 });
      expect(mailbox()).toHaveLength(1);
      expect(
        db.getJobQueueRepo().listActiveByPayload('mailbox', {
          'to.sessionId': root,
          messageUuid: 'neo-consult:check:reply',
        })
      ).toHaveLength(1);
      expect(receiptRows()).toEqual([[], []]);
    }
  );
  test('published returns admit queued holder requests and reconcile terminal work without a root summary', async () => {
    service.consultationWaiters.enqueue({
      id: 'next',
      requestKey: 'next',
      concernId: 'fictional',
      originSessionId: root,
      originMessageId: ask.messageId,
      sessionId: holder,
      question: 'Next bounded question',
    });
    const work = service.repo.proposeWork({
      id: 'other-work',
      requestKey: 'other-work',
      concernId: 'fictional',
      originSessionId: root,
      originMessageId: ask.messageId,
      title: 'Other work',
      instruction: 'Bounded work',
    });
    service.repo.transitionWork(work.id, work, { status: 'reported', report: 'Reported only' });
    await publish();
    await service.syncConsultation('check');
    expect(service.consultationWaiters.get('next')?.status).toBe('admitted');
    expect(service.consultations.get('next')?.status).toBe('pending');
    expect(
      db.getJobQueueRepo().listActiveByPayload('mailbox', {
        'to.sessionId': holder,
        messageUuid: 'neo-consult:next:request',
      })
    ).toHaveLength(1);
    expect(db.getJobQueueRepo().listActiveByPayload('mailbox', { 'to.sessionId': root })).toEqual(
      []
    );
    const blocked = service.consultations.get('next')!;
    service.consultations.finish(blocked.id, 'failed', 'Not available');
    await service.syncConsultation('check');
    expect(service.consultations.get('neo-work:other-work:review')?.status).toBe('pending');
    expect(
      db.getJobQueueRepo().listActiveByPayload('mailbox', {
        'to.sessionId': holder,
        messageUuid: 'neo-consult:neo-work:other-work:review:request',
      })
    ).toHaveLength(1);
    expect(db.getJobQueueRepo().listActiveByPayload('mailbox', { 'to.sessionId': root })).toEqual(
      []
    );
  });
  test('a returned-marker fault stays recoverable without delivering a duplicate reply', async () => {
    await publish();
    db.getDatabase().exec(
      "CREATE TRIGGER fail_return BEFORE UPDATE OF returned ON neo_consultations BEGIN SELECT RAISE(ABORT, 'return marker fault'); END"
    );
    await expect(service.syncConsultation('check')).rejects.toThrow('return marker fault');
    expect(returned()).toEqual({ returned: 0 });
    expect(mailbox()).toEqual([]);
    db.getDatabase().exec('DROP TRIGGER fail_return');
    await service.recoverConsultations();
    expect(returned()).toEqual({ returned: 1 });
    expect(mailbox()).toEqual([]);
  });
});
