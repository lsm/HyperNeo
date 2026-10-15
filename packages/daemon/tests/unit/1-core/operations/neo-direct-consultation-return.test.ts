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
  const respond = async (id = 'check', answer = draft.fullText) => {
    const messageId = `neo-consult:${id}:request`;
    prompt(holder, messageId, 'system');
    stampRequest(id);
    const turn = new NeoHolderTurn(db, holder, { isLive: () => true }, () => {});
    turns.push(turn);
    expect(turn.bind(messageId)).toBe(true);
    expect(
      await invokeOperation(
        createOperationRegistry(createNeoOperations(service)),
        'neo.project.respond',
        { id, answer },
        { source: 'mcp', sessionId: holder, role: 'neo', neoTurn: turn.identity() }
      )
    ).toMatchObject({ value: { ok: true } });
  };
  const mailbox = () =>
    db.getDatabase().prepare("SELECT * FROM job_queue WHERE queue = 'mailbox'").all();
  const returned = (id = 'check') =>
    db.getDatabase().prepare('SELECT returned FROM neo_consultations WHERE id = ?').get(id);
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

  test('a holder’s answer returns to root as input and never reaches the human by itself', async () => {
    await respond();
    expect(service.consultations.get('check')).toMatchObject({
      status: 'reported',
      answer: draft.fullText,
    });
    expect(returned()).toEqual({ returned: 1 });
    expect(
      db.getJobQueueRepo().listActiveByPayload('mailbox', {
        'to.sessionId': root,
        messageUuid: 'neo-consult:check:reply',
      })
    ).toHaveLength(1);
    expect(service.publications.list(conversationId)).toEqual([]);
  });
  const ops = () => createOperationRegistry(createNeoOperations(service));
  const rootCaller = (messageId = ask.messageId, human = true) => ({
    source: 'mcp' as const,
    sessionId: root,
    role: 'neo' as const,
    neoTurn: { messageId, human, isLive: () => true },
  });
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
    prompt(root, 'note-without-trigger', 'system');
    service.inputOrigins.record(
      { sessionId: root, messageId: 'note-without-trigger' },
      ask,
      0,
      null
    );
    expect(
      await invokeOperation(
        ops(),
        'neo.publication.publish',
        withMintedPublicationId(service, { ...interim, shortText: 'A note fact.' }),
        rootCaller('note-without-trigger', false)
      )
    ).toMatchObject({ value: { accepted: false, reason: 'consultation_pending' } });
    expect(service.publications.list(conversationId)).toEqual([]);
    await respond();
    expect(
      await invokeOperation(
        ops(),
        'neo.publication.publish',
        withMintedPublicationId(service, draft),
        rootCaller()
      )
    ).toMatchObject({ value: { accepted: true, created: true } });
  });

  test('any turn may still start work after a consulted holder answered', async () => {
    await respond();
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
    await respond();
    await invokeOperation(
      ops(),
      'neo.publication.publish',
      withMintedPublicationId(service, draft),
      rootCaller()
    );
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
    await respond();
    await invokeOperation(
      ops(),
      'neo.publication.publish',
      withMintedPublicationId(service, draft),
      rootCaller()
    );
    await service.preemptForHumanMessage(root);
    expect(handleInterrupt).toHaveBeenCalledExactlyOnceWith({ preserveDeliveryJobs: true });
    db.updateSession(root, { processingState: JSON.stringify({ status: 'idle' }) });
    await service.preemptForHumanMessage(root);
    expect(handleInterrupt).toHaveBeenCalledTimes(1);
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
    ).toMatchObject({ value: { accepted: false, reason: 'consultation_answer' } });
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
  test.each(['reported', 'failed'] as const)(
    'returns a %s answer to root as input',
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
      expect(service.publications.list(conversationId)).toEqual([]);
    }
  );
  test('a legacy answer already published to the human is marked returned on recovery, never sent to root again', async () => {
    service.consultations.finish('check', 'reported', draft.fullText);
    const published = service.publications.append({
      ...draft,
      conversationId,
      askOrigin: ask,
      producerInput: { sessionId: holder, messageId: 'neo-consult:check:request' },
      triggerId: `human:${ask.messageId}`,
    });
    if (!published.accepted) throw new Error('Expected a publication');
    db.getDatabase()
      .prepare(
        `INSERT INTO neo_consultation_publications
        (consultation_id, conversation_id, publication_id, answer, payload_json, created_at)
        VALUES ('check', ?, ?, ?, '{}', ?)`
      )
      .run(
        conversationId,
        published.publication.publicationId,
        draft.fullText,
        published.publication.createdAt
      );
    await service.recoverConsultations();
    expect(returned()).toEqual({ returned: 1 });
    expect(mailbox()).toEqual([]);
  });

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

  test('a returned answer admits queued holder requests and reconciles terminal work', async () => {
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
    await respond();
    expect(service.consultationWaiters.get('next')?.status).toBe('admitted');
    expect(service.consultations.get('next')?.status).toBe('pending');
    expect(
      db.getJobQueueRepo().listActiveByPayload('mailbox', {
        'to.sessionId': holder,
        messageUuid: 'neo-consult:next:request',
      })
    ).toHaveLength(1);
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
  });
});
