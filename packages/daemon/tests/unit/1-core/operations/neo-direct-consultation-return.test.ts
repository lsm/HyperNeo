import { withMintedPublicationId } from '../../../helpers/neo-minted-publication.ts';
import {
  neoConsultationDelivery,
  neoDeliveryTrigger,
} from '../../../../src/lib/neo/notification-triggers.ts';
import { neoConsultationParent, neoReviewWorkId } from '../../../../src/lib/neo/ask-origin.ts';
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
import { createNeoTables } from '../../../../src/storage/schema/neo.ts';

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
      projectId: 'fictional',
      originSessionId: root,
      originMessageId,
      sessionId: holder,
      question: 'Compare the sources.',
    })!;
  const stampRequest = (id: string) => {
    const item = service.consultations.get(id)!;
    const reviewed = neoReviewWorkId(id);
    const parent = neoConsultationParent(item, reviewed ? service.repo.getWork(reviewed) : null);
    const origin = parent ? service.resolveAskOrigin(parent) : null;
    if (origin)
      service.inputOrigins.record(
        { sessionId: holder, messageId: `neo-consult:${id}:request` },
        origin,
        0,
        neoDeliveryTrigger(neoConsultationDelivery(item), () =>
          parent ? service.inputTrigger(parent) : null
        )
      );
  };
  const publish = async (id = 'check') => {
    const messageId = `neo-consult:${id}:request`;
    prompt(holder, messageId, 'system');
    stampRequest(id);
    const turn = new NeoHolderTurn(db, holder, { isLive: () => true }, () => {});
    turns.push(turn);
    expect(turn.bind(messageId)).toBe(true);
    const outcome = await invokeOperation(
      createOperationRegistry(createNeoOperations(service)),
      'neo.publication.publish',
      withMintedPublicationId(service, { ...draft, links: [{ ...draft.links[0], id }] }),
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
    service.repo.saveProject({ id: 'fictional', title: 'Sources', summary: '', context: '' }, 0);
    service.repo.reserveBinding({ sessionId: root, projectId: null, kind: 'neo' });
    service.repo.reserveBinding({ sessionId: holder, projectId: 'fictional', kind: 'project' });
    prompt(root, ask.messageId, 'human');
    reserve();
  });
  afterEach(() => {
    for (const turn of turns.splice(0)) turn.dispose();
    service.dispose();
    db.close();
    vi.restoreAllMocks();
  });

  test('the current schema entry point creates publication tables idempotently for legacy initialization', async () => {
    db.getDatabase().exec('DROP TABLE neo_consultation_publications; DROP TABLE neo_publications');
    createNeoTables(db.getDatabase());
    createNeoTables(db.getDatabase());
    await publish();
    await service.syncConsultation('check');
    expect(returned()).toEqual({ returned: 1 });
    expect(mailbox()).toEqual([]);
    expect(service.publications.get(conversationId, draft.publicationId)?.shortText).toBe(
      draft.shortText
    );
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
  const ops = () => createOperationRegistry(createNeoOperations(service));
  const rootCaller = (messageId = ask.messageId, human = true) => ({
    source: 'mcp' as const,
    sessionId: root,
    role: 'neo' as const,
    neoTurn: { messageId, human, isLive: () => true },
  });
  const holderPublish = async (id: string, publicationId = draft.publicationId) => {
    const messageId = `neo-consult:${id}:request`;
    prompt(holder, messageId, 'system');
    stampRequest(id);
    const turn = new NeoHolderTurn(db, holder, { isLive: () => true }, () => {});
    turns.push(turn);
    expect(turn.bind(messageId)).toBe(true);
    return invokeOperation(
      ops(),
      'neo.publication.publish',
      withMintedPublicationId(service, {
        ...draft,
        publicationId,
        links: [{ ...draft.links[0], id }],
      }),
      { source: 'mcp', sessionId: holder, role: 'neo', neoTurn: turn.identity() }
    );
  };
  const interim = {
    publicationId: '40000000-0000-4000-8000-000000000001',
    shortText: 'Checking with the holder; the answer follows.',
    fullText: 'Checking with the holder; the answer follows.',
    links: [],
  };

  test('A: root cannot post a placeholder while the holder it consulted has not returned', async () => {
    expect(
      await invokeOperation(
        ops(),
        'neo.publication.publish',
        withMintedPublicationId(service, interim),
        rootCaller()
      )
    ).toMatchObject({ value: { accepted: false, reason: 'consultation_pending' } });
    expect(service.publications.list(conversationId)).toEqual([]);
    expect(await holderPublish('check')).toMatchObject({
      value: { accepted: true, created: true, publication: { shortText: draft.shortText } },
    });
  });

  test('any turn may still start work after a consulted holder answered', async () => {
    await holderPublish('check');
    expect(service.triggerWorkProblem(rootCaller())).toBeNull();
    const continued = 'neo-turn-limit:human:result-1';
    prompt(root, continued, 'system');
    service.inputOrigins.record(
      { sessionId: root, messageId: continued },
      ask,
      0,
      `human:${ask.messageId}`
    );
    expect(service.triggerWorkProblem(rootCaller(continued, false))).toBeNull();
    const nudgeContinued = 'neo-turn-limit:result-2';
    prompt(root, nudgeContinued, 'system');
    service.inputOrigins.record(
      { sessionId: root, messageId: nudgeContinued },
      ask,
      0,
      `human:${ask.messageId}`
    );
    expect(service.triggerWorkProblem(rootCaller(nudgeContinued, false))).toBeNull();
    prompt(root, 'neo-nudge:later', 'system');
    service.inputOrigins.record(
      { sessionId: root, messageId: 'neo-nudge:later' },
      ask,
      0,
      `human:${ask.messageId}`
    );
    expect(service.triggerWorkProblem(rootCaller('neo-nudge:later', false))).toBeNull();
  });

  test('after the holder’s answer a later turn may post a new fact and edit, but not re-consult that holder', async () => {
    await holderPublish('check');
    await service.syncConsultation('check');
    prompt(root, 'neo-nudge:later', 'system');
    service.inputOrigins.record(
      { sessionId: root, messageId: 'neo-nudge:later' },
      ask,
      0,
      `human:${ask.messageId}`
    );
    const later = rootCaller('neo-nudge:later', false);
    expect(
      await invokeOperation(
        ops(),
        'neo.publication.publish',
        withMintedPublicationId(service, { ...interim, shortText: 'A later fact.' }),
        later
      )
    ).toMatchObject({ value: { accepted: true, created: true } });
    expect(
      await invokeOperation(
        ops(),
        'neo.publication.edit',
        { publicationId: draft.publicationId, shortText: 'Reworded.' },
        later
      )
    ).toMatchObject({ value: { accepted: true } });
    expect(
      await invokeOperation(
        ops(),
        'neo.project.consult',
        { projectId: 'fictional', question: 'Again?' },
        later
      )
    ).toMatchObject({ value: { ok: false, reason: expect.stringContaining('already_consulted') } });
    expect(service.publications.list(conversationId)?.map((item) => item.shortText)).toEqual([
      'Reworded.',
      'A later fact.',
    ]);
  });

  test('C: a holder that already returned for this message is not consulted again', async () => {
    service.consultations.finish('check', 'reported', 'Legacy answer');
    expect(
      await invokeOperation(
        ops(),
        'neo.project.consult',
        { projectId: 'fictional', question: 'Again?' },
        rootCaller()
      )
    ).toMatchObject({ value: { ok: false, reason: expect.stringContaining('already_consulted') } });
  });

  test('a waiting human message ends a root turn answering a daemon note', async () => {
    const handleInterrupt = vi.fn(async () => {});
    Object.assign(service.sessions, {
      getSessionForControl: vi.fn(async () => ({ handleInterrupt })),
    });
    const note = 'neo-trigger:idle:a1:abc';
    prompt(root, note, 'system');
    service.inputOrigins.record({ sessionId: root, messageId: note }, ask, 0, 'idle:a1:abc');
    db.updateSession(root, {
      processingState: JSON.stringify({
        status: 'processing',
        messageId: note,
        phase: 'streaming',
      }),
    });
    await service.preemptForHumanMessage(root);
    expect(handleInterrupt).toHaveBeenCalledExactlyOnceWith({ preserveDeliveryJobs: true });
  });

  test('a waiting human message ends a root turn whose trigger is already answered', async () => {
    const handleInterrupt = vi.fn(async () => {});
    Object.assign(service.sessions, {
      getSessionForControl: vi.fn(async () => ({ handleInterrupt })),
    });
    db.updateSession(root, {
      processingState: JSON.stringify({
        status: 'processing',
        messageId: ask.messageId,
        phase: 'streaming',
      }),
    });
    await service.preemptForHumanMessage(root);
    expect(handleInterrupt).not.toHaveBeenCalled();
    await publish();
    await service.preemptForHumanMessage(root);
    expect(handleInterrupt).toHaveBeenCalledExactlyOnceWith({ preserveDeliveryJobs: true });
    db.updateSession(root, { processingState: JSON.stringify({ status: 'idle' }) });
    await service.preemptForHumanMessage(root);
    expect(handleInterrupt).toHaveBeenCalledTimes(1);
  });

  test('E: a return that repeats what the human already has settles quietly and publishes nothing', async () => {
    const answered = service.publications.append({
      ...draft,
      publicationId: interim.publicationId,
      conversationId,
      askOrigin: ask,
      producerInput: ask,
      triggerId: `human:${ask.messageId}`,
    });
    expect(answered).toMatchObject({ accepted: true, created: true });
    expect(await holderPublish('check')).toMatchObject({
      value: {
        accepted: true,
        created: false,
        publication: { publicationId: interim.publicationId, shortText: draft.shortText },
      },
    });
    expect(service.consultations.get('check')).toMatchObject({ status: 'reported' });
    expect(returned('check')).toEqual({ returned: 1 });
    expect(service.publications.list(conversationId)).toHaveLength(1);
  });

  test('E: a return with a new fact on an answered message is published', async () => {
    service.publications.append({
      ...interim,
      shortText: 'Root answered first.',
      fullText: 'Root answered first.',
      conversationId,
      askOrigin: ask,
      producerInput: ask,
      triggerId: `human:${ask.messageId}`,
    });
    expect(await holderPublish('check')).toMatchObject({
      value: { accepted: true, created: true, publication: { shortText: draft.shortText } },
    });
    expect(service.publications.list(conversationId)).toHaveLength(2);
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
  test('a work review is acted on quietly: its publication is refused and its end settles it without a root reply', async () => {
    db.getDatabase().prepare('DELETE FROM neo_consultations').run();
    prompt(holder, 'holder-human', 'human');
    const work = service.repo.proposeWork({
      id: 'work',
      requestKey: 'work',
      projectId: 'fictional',
      originSessionId: holder,
      originMessageId: 'holder-human',
      title: 'Fictional work',
      instruction: 'Bounded work',
    });
    service.repo.transitionWork(work.id, work, { status: 'reported', report: 'Claimed only' });
    const id = 'neo-work:work:review';
    reserve(id, null);
    const messageId = `neo-consult:${id}:request`;
    prompt(holder, messageId, 'system');
    stampRequest(id);
    const turn = new NeoHolderTurn(db, holder, { isLive: () => true }, () => {});
    turns.push(turn);
    expect(turn.bind(messageId)).toBe(true);
    expect(
      await invokeOperation(
        createOperationRegistry(createNeoOperations(service)),
        'neo.publication.publish',
        withMintedPublicationId(service, { ...draft, links: [] }),
        { source: 'mcp', sessionId: holder, role: 'neo', neoTurn: turn.identity() }
      )
    ).toMatchObject({ value: { accepted: false, reason: 'no_trigger' } });
    vi.spyOn(db.getSDKMessageRepo(), 'hasTerminalResultAfter').mockReturnValue(true);
    await service.syncConsultation(id);
    expect(service.consultations.get(id)).toMatchObject({
      status: 'reported',
      answer: 'The context holder reviewed the returned work.',
    });
    expect(returned(id)).toEqual({ returned: 1 });
    expect(mailbox()).toEqual([]);
    expect(service.publications.list(conversationId)).toEqual([]);
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
  test('an orphan producer receipt is inconsistent, not a legacy reply, and is not returned', async () => {
    await publish();
    expect(
      service.publications.append({
        ...captured,
        publicationId: crypto.randomUUID(),
        shortText: 'A later fact.',
      }).accepted
    ).toBe(true);
    db.getDatabase().prepare('DELETE FROM neo_consultation_publications').run();
    await expect(service.syncConsultation('check')).rejects.toThrow('inconsistent');
    expect(returned()).toEqual({ returned: 0 });
    expect(mailbox()).toEqual([]);
  });
  test('once the holder reply has returned, root can fix it like any other Neo reply', async () => {
    await publish();
    prompt(root, 'fix-it', 'human');
    const turn = new NeoHolderTurn(db, root, { isLive: () => true }, () => {});
    turns.push(turn);
    expect(turn.bind('fix-it')).toBe(true);
    const edit = () =>
      invokeOperation(
        createOperationRegistry(createNeoOperations(service)),
        'neo.publication.edit',
        { publicationId: draft.publicationId, shortText: 'Shorter.' },
        { source: 'mcp', sessionId: root, role: 'neo', neoTurn: turn.identity() }
      );
    expect(await edit()).toMatchObject({
      value: { accepted: false, reason: 'consultation_return' },
    });
    await service.syncConsultation('check');
    expect(returned()).toEqual({ returned: 1 });
    expect(await edit()).toMatchObject({
      value: { accepted: true, publication: { shortText: 'Shorter.', editedBy: root } },
    });
    await service.syncConsultation('check');
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
  test('a failed work review’s reply still answers the human message behind the reviewed card', async () => {
    db.getDatabase().prepare('DELETE FROM neo_consultations').run();
    const work = service.repo.proposeWork({
      id: 'work',
      requestKey: 'work',
      projectId: 'fictional',
      originSessionId: root,
      originMessageId: ask.messageId,
      title: 'Fictional work',
      instruction: 'Bounded work',
    });
    service.repo.transitionWork(work.id, work, { status: 'reported', report: 'Claimed only' });
    const id = 'neo-work:work:review';
    reserve(id, null);
    service.consultations.finish(id, 'failed', 'The holder stopped');
    await service.syncConsultation(id);
    const reply = { sessionId: root, messageId: `neo-consult:${id}:reply` };
    expect(service.inputTrigger(reply)).toBe(`human:${ask.messageId}`);
  });

  test('published returns admit queued holder requests and reconcile terminal work without a root summary', async () => {
    service.consultationWaiters.enqueue({
      id: 'next',
      requestKey: 'next',
      projectId: 'fictional',
      originSessionId: root,
      originMessageId: ask.messageId,
      sessionId: holder,
      question: 'Next bounded question',
    });
    const work = service.repo.proposeWork({
      id: 'other-work',
      requestKey: 'other-work',
      projectId: 'fictional',
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
