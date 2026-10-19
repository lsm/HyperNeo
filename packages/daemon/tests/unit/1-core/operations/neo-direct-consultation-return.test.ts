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
    const turn = new NeoHolderTurn(db, holder, { isLive: () => true });
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

  test('root may publish while consultation facts are pending', async () => {
    expect(
      await invokeOperation(
        ops(),
        'neo.publication.publish',
        withMintedPublicationId(service, interim),
        rootCaller()
      )
    ).toMatchObject({ value: { accepted: true, created: true } });
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
    ).toMatchObject({ value: { accepted: true, created: true } });
    expect(service.publications.list(conversationId)).toHaveLength(2);
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

  test('root reads its full consultation answer on a later live turn', async () => {
    await respond();
    expect(
      await invokeOperation(ops(), 'neo.receipt.read', { consultationId: 'check' }, rootCaller())
    ).toMatchObject({ value: { ok: true, consultation: { id: 'check', answer: draft.fullText } } });
    expect(
      await invokeOperation(
        ops(),
        'neo.receipt.read',
        { consultationId: 'check' },
        {
          source: 'mcp',
          sessionId: holder,
          neoTurn: rootCaller().neoTurn,
        }
      )
    ).toMatchObject({ value: { ok: false } });
    const dead = { ...rootCaller(), neoTurn: { ...rootCaller().neoTurn!, isLive: () => false } };
    expect(
      await invokeOperation(ops(), 'neo.receipt.read', { consultationId: 'check' }, dead)
    ).toMatchObject({ value: { ok: false } });
    service.consultations.reserve({
      id: 'foreign',
      requestKey: 'foreign',
      projectId: 'fictional',
      originSessionId: 'other-root',
      originMessageId: 'other-ask',
      sessionId: holder,
      question: 'Other?',
    });
    expect(
      await invokeOperation(ops(), 'neo.receipt.read', { consultationId: 'foreign' }, rootCaller())
    ).toMatchObject({ value: { ok: false } });
  });

  test('after the holder’s answer a later turn may post a new fact and edit, and read its existing receipt on repeat consultation', async () => {
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
        {
          publicationId: service.publications.list(conversationId)![0].publicationId,
          requestId: 'edit-1',
          shortText: 'Reworded.',
        },
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
    ).toMatchObject({ value: { ok: true, consultation: { id: 'check', answer: draft.fullText } } });
    expect(service.publications.list(conversationId)?.map((item) => item.shortText)).toEqual([
      'Reworded.',
      'A later fact.',
    ]);
  });

  test('a repeat consultation returns its stored receipt instead of starting another', async () => {
    service.consultations.finish('check', 'reported', 'Legacy answer');
    expect(
      await invokeOperation(
        ops(),
        'neo.project.consult',
        { projectId: 'fictional', question: 'Again?' },
        rootCaller()
      )
    ).toMatchObject({
      value: { ok: true, consultation: { id: 'check', answer: 'Legacy answer' } },
    });
  });

  test('replays an older consultation beyond the snapshot window without dispatching again', async () => {
    service.consultations.finish('check', 'reported', 'The original answer');
    db.getDatabase()
      .prepare('UPDATE neo_consultations SET created_at = 0 WHERE id = ?')
      .run('check');
    for (let index = 0; index < 21; index++) {
      const id = `other-${index}`;
      reserve(id, id);
      service.consultations.finish(id, 'reported', 'Unrelated answer');
    }
    const deliver = vi.spyOn(service, 'deliver');
    expect(
      await invokeOperation(
        ops(),
        'neo.project.consult',
        {
          projectId: 'fictional',
          question: 'Again?',
        },
        rootCaller()
      )
    ).toMatchObject({
      value: { ok: true, consultation: { id: 'check', answer: 'The original answer' } },
    });
    expect(deliver).not.toHaveBeenCalled();
  });

  test('a human message waiting while root works is steered into the running turn, never preempting it', async () => {
    const steerNeoInput = vi.fn(() => true);
    const handleInterrupt = vi.fn(async () => {});
    Object.assign(service.sessions, {
      getSessionForControl: vi.fn(async () => ({ steerNeoInput, handleInterrupt })),
    });
    prompt(root, 'waiting-human', 'human');
    db.getSDKMessageRepo().updateMessageStatus(
      [db.getSDKMessageRepo().findMessageIdByUuid(root, 'waiting-human')!],
      'enqueued'
    );
    await events.publish('session.updated', {
      sessionId: root,
      processingState: { status: 'idle' },
    });
    await service.steerHumanMessages(root);
    expect(steerNeoInput).not.toHaveBeenCalled();
    await events.publish('session.updated', {
      sessionId: root,
      processingState: { status: 'processing', messageId: 'note', phase: 'initializing' },
    });
    await vi.waitFor(() => expect(steerNeoInput).toHaveBeenCalledWith('waiting-human'));
    await service.steerHumanMessages(holder);
    expect(steerNeoInput).toHaveBeenCalledTimes(1);
    expect(handleInterrupt).not.toHaveBeenCalled();
  });

  test('an ask read lists what the human was actually told for it, and nothing else', async () => {
    const opened = service.askRecords.open(
      {
        id: 'ask-told',
        requestKey: 'ask-told',
        projectId: null,
        originSessionId: root,
        originMessageId: ask.messageId,
        title: 'Compare sources',
        ask: 'Compare sources',
        doneWhen: '- compared',
        doneSource: 'human',
      },
      [{ text: 'compared', check: null }]
    )!;
    const post = (publicationId: string, shortText: string, extra: object) =>
      service.publications.append({
        ...draft,
        publicationId,
        shortText,
        fullText: shortText,
        links: [],
        conversationId,
        askOrigin: ask,
        producerInput: ask,
        ...extra,
      });
    post('40000000-0000-4000-8000-000000000011', 'Reply to the ask.', {
      triggerId: `human:${ask.messageId}`,
    });
    post('40000000-0000-4000-8000-000000000012', 'The outcome.', {
      triggerId: `outcome:${opened.id}:x`,
    });
    post('40000000-0000-4000-8000-000000000013', 'Another ask.', {
      askOrigin: { sessionId: root, messageId: 'other' },
      producerInput: { sessionId: root, messageId: 'other' },
      triggerId: 'outcome:another:y',
    });
    expect(
      await invokeOperation(ops(), 'neo.snapshot', { askId: opened.id }, rootCaller())
    ).toMatchObject({
      value: {
        told: [
          { shortText: 'Reply to the ask.', triggerId: `human:${ask.messageId}` },
          { shortText: 'The outcome.', triggerId: `outcome:${opened.id}:x` },
        ],
      },
    });
  });

  test('an ask read keeps only the newest told messages, each short', async () => {
    const opened = service.askRecords.open(
      {
        id: 'ask-many',
        requestKey: 'ask-many',
        projectId: null,
        originSessionId: root,
        originMessageId: ask.messageId,
        title: 'Many',
        ask: 'Many',
        doneWhen: '- many',
        doneSource: 'human',
      },
      [{ text: 'many', check: null }]
    )!;
    for (let n = 0; n < 25; n++)
      service.publications.append({
        ...draft,
        publicationId: `40000000-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`,
        shortText: `${n} ${'x'.repeat(400)}`,
        fullText: `${n}`,
        links: [],
        conversationId,
        askOrigin: ask,
        producerInput: ask,
        triggerId: `outcome:${opened.id}:${n}`,
      });
    const read = (await invokeOperation(
      ops(),
      'neo.snapshot',
      { askId: opened.id },
      rootCaller()
    )) as { value: { told: { shortText: string }[] } };
    expect(read.value.told).toHaveLength(20);
    expect(read.value.told[0].shortText.startsWith('5 ')).toBe(true);
    expect(read.value.told.every((item) => item.shortText.length <= 300)).toBe(true);
  });

  test('a work review is acted on quietly: its publication is refused, and the work returns to its origin directly', async () => {
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
    const turn = new NeoHolderTurn(db, holder, { isLive: () => true });
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
    expect(
      (mailbox() as { payload: string }[]).map((job) => JSON.parse(job.payload).messageUuid)
    ).toEqual(['work']);
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

  test('a returned answer admits queued holder requests and returns terminal work to root', async () => {
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
    expect(service.consultations.get('neo-work:other-work:review')).toBeNull();
    expect(
      db.getJobQueueRepo().listActiveByPayload('mailbox', {
        'to.sessionId': root,
        messageUuid: 'other-work',
      })
    ).toHaveLength(1);
  });
});
