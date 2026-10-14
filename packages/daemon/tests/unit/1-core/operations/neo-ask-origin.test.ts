import { runMigration358 } from '../../../../src/storage/schema/m358-neo-ask-revisions.ts';
import { runMigration362 } from '../../../../src/storage/schema/m362-neo-driver-configuration.ts';
import { runMigration363 } from '../../../../src/storage/schema/m363-neo-work-refusals.ts';
import { runMigration362 } from '../../../../src/storage/schema/m362-neo-driver-configuration.ts';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { MessageHub, Session } from '@hyperneo/shared';
import type { SDKMessage, SDKUserMessage } from '@hyperneo/shared/sdk';
import type { NeoBinding, NeoConsultation, NeoWork } from '@hyperneo/shared/types/neo-context';
import {
  classifyNeoAskInput,
  createNeoAskOriginResolver,
  neoDoneCheckMessageId,
  neoWorkReturnMessageId,
  neoWorkReviewId,
  neoConsultationParent,
  neoReviewWorkId,
  requireNeoAskCoordinator,
  requireNeoAskReference,
  type NeoAskOrigin,
  type NeoAskOriginReads,
} from '../../../../src/lib/neo/ask-origin.ts';
import { createNeoIntakeOperation } from '../../../../src/lib/neo/intake.ts';
import { createNeoOperations } from '../../../../src/lib/neo/operations.ts';
import type { NeoSnapshot } from '@hyperneo/shared/types/neo-snapshot';
import { NeoService } from '../../../../src/lib/neo/service.ts';
import { InternalEventBus } from '../../../../src/lib/internal-event-bus.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import { createOperationRegistry } from '../../../../src/lib/operations/registry.ts';
import type { OperationCaller } from '../../../../src/lib/operations/registry.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import type { Database } from '../../../../src/storage/database.ts';
import { createNeoTables } from '../../../../src/storage/schema/neo.ts';
import { runMigration279 } from '../../../../src/storage/schema/m279-neo-consultations.ts';
import { runMigration282 } from '../../../../src/storage/schema/m282-neo-consultation-origins.ts';
import { runMigration283 } from '../../../../src/storage/schema/m283-neo-work-origins.ts';
import { runMigration285 } from '../../../../src/storage/schema/m285-neo-consultation-waiters.ts';
import { runMigration289 } from '../../../../src/storage/schema/m289-neo-conversation-asks.ts';
import { runMigration307 } from '../../../../src/storage/schema/m307-neo-work-goals.ts';
import { runMigration308 } from '../../../../src/storage/schema/m308-neo-work-continues.ts';
import { runMigration313 } from '../../../../src/storage/schema/m313-neo-asks.ts';
import { runMigration314 } from '../../../../src/storage/schema/m314-neo-work-prs.ts';
import { runMigration316 } from '../../../../src/storage/schema/m316-neo-ask-evidence.ts';
import { runMigration317 } from '../../../../src/storage/schema/m317-neo-work-pr-reminders.ts';
import { runMigration318 } from '../../../../src/storage/schema/m318-neo-ask-items.ts';
import { runMigration320 } from '../../../../src/storage/schema/m320-neo-work-checks.ts';
import { runMigration322 } from '../../../../src/storage/schema/m322-neo-ask-reminders.ts';
import { runMigration323 } from '../../../../src/storage/schema/m323-neo-work-check-evidence.ts';
import { runMigration324 } from '../../../../src/storage/schema/m324-neo-ask-pack.ts';
import { runMigration325 } from '../../../../src/storage/schema/m325-neo-ask-checks.ts';
import { runMigration326 } from '../../../../src/storage/schema/m326-neo-ask-approved.ts';
import { runMigration327 } from '../../../../src/storage/schema/m327-neo-ask-approved-continues.ts';
import { runMigration328 } from '../../../../src/storage/schema/m328-neo-ask-item-check-kinds.ts';
import { runMigration330 } from '../../../../src/storage/schema/m330-neo-ask-waiting-item.ts';
import { runMigration332 } from '../../../../src/storage/schema/m332-neo-work-supersessions.ts';
import { runMigration333 } from '../../../../src/storage/schema/m333-neo-work-pr-claims.ts';
import { runMigration335 } from '../../../../src/storage/schema/m335-neo-work-prs-drop-delivered.ts';
import { runMigration336 } from '../../../../src/storage/schema/m336-neo-work-pr-claim-scores.ts';
import { runMigration337 } from '../../../../src/storage/schema/m337-neo-ask-item-check-kind-life-admin.ts';
import { runMigration293 } from '../../../../src/storage/schema/m293-neo-work-driver-targets.ts';
import { runMigration294 } from '../../../../src/storage/schema/m294-neo-work-driver-started-at.ts';
import { runMigration295 } from '../../../../src/storage/schema/m295-neo-work-driver-notified.ts';
import { runMigration296 } from '../../../../src/storage/schema/m296-neo-work-driver-live.ts';
import { runMigration309 } from '../../../../src/storage/schema/m309-neo-work-driver-remote-link.ts';
import { runMigration310 } from '../../../../src/storage/schema/m310-neo-work-driver-sent.ts';
import { runMigration311 } from '../../../../src/storage/schema/m311-neo-work-driver-retries.ts';
import { runMigration321 } from '../../../../src/storage/schema/m321-neo-work-driver-follow-anchor.ts';
import { runMigration334 } from '../../../../src/storage/schema/m334-neo-driver-start-interrupted.ts';
import { runMigration338 } from '../../../../src/storage/schema/m338-neo-driver-checked-at.ts';
import { runMigration339 } from '../../../../src/storage/schema/m339-neo-input-origins.ts';
import { runMigration340 } from '../../../../src/storage/schema/m340-neo-session-seen.ts';
import { runMigration345 } from '../../../../src/storage/schema/m345-neo-work-continue-progress.ts';
import { runMigration344 } from '../../../../src/storage/schema/m344-neo-ask-forwards.ts';
import { createMailboxTestDb, type MailboxTestDb } from '../../../helpers/mailbox-test-db.ts';

const root: NeoBinding = {
  sessionId: 'neo:10000000-0000-4000-8000-000000000001',
  projectId: null,
  kind: 'neo',
};
const holder: NeoBinding = { sessionId: 'holder:a', projectId: 'a', kind: 'project' };
const ask: NeoAskOrigin = { sessionId: root.sessionId, messageId: 'human:1' };
const consultation: NeoConsultation = {
  id: 'check:with:delimiters',
  requestKey: 'key',
  projectId: 'a',
  originSessionId: root.sessionId,
  originMessageId: ask.messageId,
  sessionId: holder.sessionId,
  question: 'Untrusted text cannot select ancestry.',
  status: 'pending',
  answer: null,
  createdAt: 1,
};
const work: NeoWork = {
  id: 'work:opaque:id',
  requestKey: 'work-key',
  projectId: 'a',
  originSessionId: root.sessionId,
  originMessageId: ask.messageId,
  title: 'Title',
  instruction: 'Untrusted instruction',
  sessionId: 'worker',
  status: 'reported',
  report: 'Unverified result',
  createdAt: 1,
  updatedAt: 2,
};
const request = (item = consultation): NeoAskOrigin => ({
  sessionId: item.sessionId,
  messageId: `neo-consult:${item.id}:request`,
});
const reply = (item = consultation): NeoAskOrigin => ({
  sessionId: item.originSessionId,
  messageId: `neo-consult:${item.id}:reply`,
});
const prompt = (input: NeoAskOrigin, inputKind: string | undefined = 'human'): SDKUserMessage =>
  ({
    type: 'user',
    uuid: input.messageId,
    session_id: input.sessionId,
    parent_tool_use_id: null,
    inputKind,
    message: { role: 'user', content: [{ type: 'text', text: 'Context only' }] },
  }) as SDKUserMessage;
function fixtures() {
  const bindings = new Map([root, holder].map((item) => [item.sessionId, item]));
  const prompts = new Map<string, SDKMessage[]>();
  const consultations = new Map([[consultation.id, consultation]]);
  const works = new Map([[work.id, work]]);
  const asks = new Map<
    string,
    { id: string; originSessionId: string; originMessageId: string | null }
  >();
  const stamps = new Map<string, NeoAskOrigin>();
  const key = (input: NeoAskOrigin) => JSON.stringify([input.sessionId, input.messageId]);
  const put = (input: NeoAskOrigin, kind = 'human') =>
    prompts.set(key(input), [prompt(input, kind)]);
  const reads: NeoAskOriginReads = {
    getBinding: mock((id: string) => bindings.get(id) ?? null),
    getPrompts: mock(
      (sessionId: string, messageId: string) => prompts.get(key({ sessionId, messageId })) ?? []
    ),
    getStamp: mock(
      (sessionId: string, messageId: string) => stamps.get(key({ sessionId, messageId })) ?? null
    ),
  };
  return {
    asks,
    stamps,
    bindings,
    prompts,
    consultations,
    works,
    key,
    put,
    reads,
    resolve: createNeoAskOriginResolver(reads),
  };
}

describe('stamped ask origins', () => {
  test('a note resolves to its delivery stamp in one read, whatever its card does next', () => {
    const f = fixtures();
    const note = { sessionId: root.sessionId, messageId: neoDoneCheckMessageId(work.id, 0) };
    f.put(note, 'system');
    f.stamps.set(f.key(note), ask);
    expect(f.resolve(note)).toEqual(ask);
    f.works.set(work.id, { ...work, status: 'queued' });
    expect(f.resolve(note)).toEqual(ask);
    expect(f.reads.getPrompts).not.toHaveBeenCalled();
  });

  test('an unstamped system note has no ask, and a human input is its own', () => {
    const f = fixtures();
    const note = { sessionId: root.sessionId, messageId: neoDoneCheckMessageId(work.id, 0) };
    f.put(note, 'system');
    f.put(ask);
    expect(f.resolve(note)).toBeNull();
    expect(f.resolve(ask)).toEqual(ask);
  });
});

describe('neoConsultationParent', () => {
  const reviewed = { id: 'w1', originSessionId: holder.sessionId, originMessageId: 'holder-ask' };
  test('a consultation with an origin message is stamped with it', () => {
    expect(neoConsultationParent(consultation)).toEqual({
      sessionId: consultation.originSessionId,
      messageId: consultation.originMessageId,
    });
  });
  test('an internal review has no origin message, so it takes the reviewed card origin', () => {
    const review = { ...consultation, id: neoWorkReviewId('w1', 2, 1), originMessageId: null };
    expect(neoReviewWorkId(review.id)).toBe('w1');
    expect(neoConsultationParent(review, reviewed)).toEqual({
      sessionId: holder.sessionId,
      messageId: 'holder-ask',
    });
    expect(neoConsultationParent(review, { ...reviewed, id: 'w2' })).toBeNull();
    expect(neoConsultationParent({ ...review, id: 'plain' }, reviewed)).toBeNull();
  });
});

describe('neoWorkReturnMessageId', () => {
  test('a continued card returns under a new id so its next report is not swallowed', () => {
    expect(neoWorkReturnMessageId('w1', 0)).toBe('w1');
    expect(neoWorkReturnMessageId('w1', 2)).toBe('w1:retry:2');
    expect(neoWorkReturnMessageId('w1', 0, 1)).toBe('w1:continued:1');
    expect(neoWorkReturnMessageId('w1', 2, 3)).toBe('w1:retry:2:continued:3');
  });
});

describe('recorded ask lineage gates', () => {
  test.each([
    { sessionId: '', messageId: 'x' },
    { sessionId: 'root', messageId: '' },
    { sessionId: 'root', messageId: null },
  ])('unknown reference: %j', (input) => {
    expect(requireNeoAskReference(input)).toEqual({ reason: { kind: 'unknown' } });
  });
  test('preserves opaque identities without mutating frozen inputs', () => {
    const input = Object.freeze({ sessionId: ' root:a ', messageId: ' :reply: ' });
    expect(requireNeoAskReference(input)).toEqual({ value: input });
    expect(classifyNeoAskInput(input, Object.freeze([Object.freeze(prompt(input))]))).toEqual({
      reason: { kind: 'human', origin: input },
    });
  });
  test.each([
    null,
    { ...root, sessionId: 'other' },
    { ...root, kind: 'worker' as const },
    { ...root, projectId: 'a' },
    { ...holder, projectId: null },
  ])('rejects invalid coordinator: %j', (binding) => {
    expect(requireNeoAskCoordinator(ask, binding)).toEqual({ reason: { kind: 'unknown' } });
  });
  test('admits root and matching holder bindings', () => {
    expect(requireNeoAskCoordinator(ask, root)).toEqual({ value: ask });
    expect(requireNeoAskCoordinator(request(), holder)).toEqual({ value: request() });
  });
  test.each(
    [
      [],
      [prompt(ask, 'task')],
      [prompt(ask, 'unknown')],
      [{ ...prompt(ask), inputKind: undefined } as SDKMessage],
      [prompt(ask), prompt(ask, 'system')],
      [prompt({ ...ask, sessionId: 'other' })],
      [prompt({ ...ask, messageId: 'other' })],
      [{ ...prompt(ask), type: 'assistant' } as SDKMessage],
    ].map((prompts) => ({ prompts }))
  )('unknown or conflicting provenance: %j', ({ prompts }) => {
    expect(classifyNeoAskInput(ask, prompts)).toEqual({ reason: { kind: 'unknown' } });
  });
  test('duplicate human echoes terminate, system prompts continue', () => {
    expect(classifyNeoAskInput(ask, [prompt(ask), prompt(ask)])).toEqual({
      reason: { kind: 'human', origin: ask },
    });
    expect(classifyNeoAskInput(request(), [prompt(request(), 'system')])).toEqual({
      value: request(),
    });
  });
});

describe('synchronous ask resolver', () => {
  test('gate precedence avoids deeper reads; human prefix resemblance does not create a receipt link', () => {
    const f = fixtures();
    expect(f.resolve({ ...ask, messageId: null })).toBeNull();
    expect(f.reads.getStamp).not.toHaveBeenCalled();
    expect(f.reads.getBinding).not.toHaveBeenCalled();
    expect(f.resolve({ ...ask, sessionId: 'ordinary' })).toBeNull();
    expect(f.reads.getPrompts).not.toHaveBeenCalled();
    expect(f.resolve(ask)).toBeNull();
    const human = { ...ask, messageId: request().messageId };
    f.put(human);
    expect(f.resolve(human)).toEqual(human);
  });
  test('infrastructure errors are not converted into a guessed or unknown human ask', () => {
    const f = fixtures();
    f.reads.getPrompts = () => {
      throw new Error('storage unavailable');
    };
    expect(() => createNeoAskOriginResolver(f.reads)(ask)).toThrow('storage unavailable');
  });
});

describe('real SQLite ask lineage facade', () => {
  let mailbox: MailboxTestDb;
  let db: Database;
  let service: NeoService;
  const createSession = mock(async () => undefined);
  const getSessionAsync = mock(async () => undefined);
  const notify = mock(async () => undefined);
  const humanId = 'c706b610-7d48-46d7-a0dd-397d09c070fe';
  beforeEach(() => {
    mailbox = createMailboxTestDb();
    createNeoTables(mailbox.db);
    runMigration363(mailbox.db);
    runMigration279(mailbox.db);
    runMigration282(mailbox.db);
    runMigration283(mailbox.db);
    runMigration285(mailbox.db);
    runMigration289(mailbox.db);
    runMigration307(mailbox.db);
    runMigration308(mailbox.db);
    runMigration313(mailbox.db);
    runMigration314(mailbox.db);
    runMigration316(mailbox.db);
    runMigration317(mailbox.db);
    runMigration318(mailbox.db);
    runMigration320(mailbox.db);
    runMigration322(mailbox.db);
    runMigration323(mailbox.db);
    runMigration324(mailbox.db);
    runMigration325(mailbox.db);
    runMigration326(mailbox.db);
    runMigration327(mailbox.db);
    runMigration328(mailbox.db);
    runMigration330(mailbox.db);
    runMigration332(mailbox.db);
    runMigration333(mailbox.db);
    runMigration335(mailbox.db);
    runMigration336(mailbox.db);
    runMigration337(mailbox.db);
    runMigration293(mailbox.db);
    runMigration294(mailbox.db);
    runMigration295(mailbox.db);
    runMigration296(mailbox.db);
    runMigration309(mailbox.db);
    runMigration310(mailbox.db);
    runMigration311(mailbox.db);
    runMigration321(mailbox.db);
    runMigration334(mailbox.db);
    runMigration338(mailbox.db);
    runMigration339(mailbox.db);
    runMigration340(mailbox.db);
    runMigration345(mailbox.db);
    runMigration344(mailbox.db);
    runMigration358(mailbox.db);
    runMigration362(mailbox.db);
    db = {
      getDatabase: () => mailbox.db,
      getSDKMessageRepo: () => mailbox.sdkMessageRepo,
      getJobQueueRepo: () => mailbox.jobQueue,
      getSession: (id: string) => ({ id, status: 'active', config: {} }) as Session,
    } as unknown as Database;
    service = new NeoService(
      db,
      { createSession, getSessionAsync } as unknown as SessionManager,
      { event: notify } as unknown as MessageHub,
      new InternalEventBus()
    );
    service.repo.saveProject({ id: 'a', title: 'A', summary: '', context: '' }, 0);
    for (const item of [root, holder]) {
      mailbox.db.prepare('INSERT INTO sessions (id) VALUES (?)').run(item.sessionId);
      service.repo.reserveBinding(item);
    }
    createSession.mockClear();
    getSessionAsync.mockClear();
    notify.mockClear();
  });
  afterEach(() => {
    service.dispose();
    mailbox.close();
  });
  async function intake(sessionId = root.sessionId, requestId = humanId) {
    const receipt = await invokeOperation(
      createOperationRegistry([createNeoIntakeOperation(db, service.repo)]),
      'neo.message.send',
      { sessionId, requestId, content: 'Actual accepted ask' },
      { source: 'rpc', principal: 'local' }
    );
    expect(receipt).toMatchObject({ kind: 'completed', value: { ok: true, messageId: requestId } });
    return { sessionId, messageId: requestId };
  }
  function storeSystem(input: NeoAskOrigin, parent: NeoAskOrigin | null = null) {
    expect(
      mailbox.sdkMessageRepo.saveSDKMessage(input.sessionId, prompt(input, 'system'), 'system')
    ).toBe(true);
    const origin = parent ? service.resolveAskOrigin(parent) : null;
    if (origin) service.inputOrigins.record(input, origin, 0);
  }
  function reserve(item: NeoConsultation) {
    expect(service.consultations.reserve(item)?.id).toBe(item.id);
  }
  function unchangedState() {
    return {
      sdk: mailbox.sdkRows(),
      jobs: mailbox.rows(),
      projects: service.repo.listProjects(),
      work: service.repo.listWork(),
      consultations: service.consultations.list(),
    };
  }
  async function snapshot(caller: OperationCaller = { source: 'rpc', principal: 'local' }) {
    const result = await invokeOperation(
      createOperationRegistry(createNeoOperations(service)),
      'neo.snapshot',
      {},
      caller
    );
    if (result.kind !== 'completed')
      throw new Error(`Snapshot did not complete: ${JSON.stringify(result)}`);
    return result.value as NeoSnapshot;
  }
  test('snapshot operation exposes accepted pending sources without provider work or writes', async () => {
    const a = await intake();
    const b = await intake(root.sessionId, 'e4da4c3c-d629-46dc-a550-047144cf9499');
    const first = service.repo.proposeWork({ ...work, originMessageId: a.messageId });
    service.repo.proposeWork({
      ...work,
      id: 'other-work',
      requestKey: 'other',
      originMessageId: b.messageId,
    });
    reserve({ ...consultation, originMessageId: a.messageId });
    const before = unchangedState();
    notify.mockClear();
    const value = await snapshot();
    expect(value.askOrigins).toEqual(
      expect.arrayContaining([
        { kind: 'work', id: first.id, origin: a },
        { kind: 'work', id: 'other-work', origin: b },
        { kind: 'consultation', id: consultation.id, origin: a },
      ])
    );
    expect(value.askOrigins).toHaveLength(value.work.length + value.consultations!.length);
    expect(value.work.find((item) => item.id === first.id)?.status).toBe('proposed');
    expect(value.consultations![0].status).toBe('pending');
    const definition = createNeoOperations(service).find((item) => item.name === 'neo.snapshot')!;
    expect(definition.resultSchema.safeParse(value).success).toBe(true);
    const { askOrigins: _removed, ...older } = value;
    expect(definition.resultSchema.safeParse(older).success).toBe(true);
    expect(unchangedState()).toEqual(before);
    expect(createSession).not.toHaveBeenCalled();
    expect(getSessionAsync).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
  test('snapshot follows holder work and only actually delivered owned review provenance', async () => {
    const a = await intake();
    await intake(root.sessionId, 'e4da4c3c-d629-46dc-a550-047144cf9499');
    const item = { ...consultation, originMessageId: a.messageId };
    reserve(item);
    storeSystem(request(item), a);
    service.consultations.finish(item.id, 'reported', 'Context checked');
    const proposed = service.repo.proposeWork({
      ...work,
      originSessionId: holder.sessionId,
      originMessageId: request(item).messageId,
    });
    service.repo.transitionWork(proposed.id, proposed, {
      status: 'reported',
      report: 'Claim only',
    });
    const id = `neo-work:${proposed.id}:review`;
    const review = { ...item, id, requestKey: id, originMessageId: null };
    reserve(review);
    expect((await snapshot()).askOrigins).toContainEqual({
      kind: 'consultation',
      id,
      origin: null,
    });
    storeSystem(request(review), request(item));
    const before = unchangedState();
    expect((await snapshot()).askOrigins).toEqual(
      expect.arrayContaining([
        { kind: 'work', id: proposed.id, origin: a },
        { kind: 'consultation', id, origin: a },
      ])
    );
    expect(unchangedState()).toEqual(before);
    const forged = { ...review, id: `neo-work:${proposed.id}:bad:review`, requestKey: 'ordinary' };
    service.consultations.finish(review.id, 'reported', 'Fixture review settled');
    reserve(forged);
    storeSystem(request(forged));
    expect((await snapshot()).askOrigins).toContainEqual({
      kind: 'consultation',
      id: forged.id,
      origin: null,
    });
  });
  test('snapshot preserves explicit unknown legacy sources instead of using a newer accepted ask', async () => {
    await intake();
    const unknown = service.repo.proposeWork({ ...work, originMessageId: 'missing-prompt' });
    const legacy = service.repo.proposeWork({
      ...work,
      id: 'legacy',
      requestKey: 'legacy',
      originMessageId: null,
    });
    reserve({ ...consultation, originMessageId: null });
    expect((await snapshot()).askOrigins).toEqual(
      expect.arrayContaining([
        { kind: 'work', id: unknown.id, origin: null },
        { kind: 'work', id: legacy.id, origin: null },
        { kind: 'consultation', id: consultation.id, origin: null },
      ])
    );
  });
  test('snapshot origin metadata preserves holder scope and root detail redaction', async () => {
    const a = await intake();
    const b = await intake(root.sessionId, 'e4da4c3c-d629-46dc-a550-047144cf9499');
    service.repo.saveProject(
      { id: 'a', title: 'A', summary: 'Summary A', context: 'Private A' },
      1
    );
    service.repo.saveProject(
      { id: 'b', title: 'B', summary: 'Summary B', context: 'Private B' },
      0
    );
    service.repo.proposeWork({ ...work, originMessageId: a.messageId });
    service.repo.proposeWork({
      ...work,
      id: 'work-b',
      requestKey: 'b',
      projectId: 'b',
      originMessageId: b.messageId,
    });
    reserve({ ...consultation, originMessageId: a.messageId });
    const rootCaller: OperationCaller = { source: 'mcp', role: 'neo', sessionId: root.sessionId };
    const holderCaller: OperationCaller = { ...rootCaller, sessionId: holder.sessionId };
    const overview = await snapshot(rootCaller);
    expect(overview.projects.map((item) => item.context)).toEqual(['', '']);
    expect(overview.work.every((item) => item.instruction === '' && item.report === null)).toBe(
      true
    );
    expect(overview.consultations![0]).toMatchObject({ question: '', answer: null });
    expect(overview.askOrigins).toContainEqual({ kind: 'work', id: 'work-b', origin: b });
    const scoped = await snapshot(holderCaller);
    expect(scoped.projects.map((item) => item.id)).toEqual(['a']);
    expect(scoped.projects[0].context).toBe('Private A');
    expect(scoped.work.map((item) => item.id)).toEqual([work.id]);
    expect(scoped.askOrigins).toEqual(
      expect.arrayContaining([
        { kind: 'work', id: work.id, origin: a },
        { kind: 'consultation', id: consultation.id, origin: a },
      ])
    );
    expect(scoped.askOrigins).toHaveLength(2);
    expect(
      await invokeOperation(
        createOperationRegistry(createNeoOperations(service)),
        'neo.snapshot',
        { projectId: 'b' },
        holderCaller
      )
    ).toMatchObject({ kind: 'completed', value: { ok: false } });
  });
  test('snapshot projects only already-visible bounded receipts for humans and root agents', async () => {
    const a = await intake();
    for (let index = 0; index < 125; index++)
      service.repo.proposeWork({
        ...work,
        id: `bounded-${index}`,
        requestKey: `bounded-${index}`,
        originMessageId: a.messageId,
      });
    const before = unchangedState();
    for (const [caller, count] of [
      [{ source: 'rpc', principal: 'local' }, 100],
      [{ source: 'mcp', role: 'neo', sessionId: root.sessionId }, 10],
    ] as [OperationCaller, number][]) {
      const value = await snapshot(caller);
      expect(value.work).toHaveLength(count);
      expect(value.askOrigins).toHaveLength(count);
      expect(value.askOrigins!.map((row) => row.id)).toEqual(value.work.map((row) => row.id));
      expect(
        value.askOrigins!.every(
          (row) => row.kind === 'work' && row.origin?.messageId === a.messageId
        )
      ).toBe(true);
    }
    expect(unchangedState()).toEqual(before);
    expect(createSession).not.toHaveBeenCalled();
    expect(getSessionAsync).not.toHaveBeenCalled();
  });
  test('public facade reads actual durable human intake without query, subscription effects or writes', async () => {
    const human = await intake();
    const before = unchangedState();
    expect(service.resolveAskOrigin(human)).toEqual(human);
    expect(service.resolveAskOrigin({ ...human, messageId: null })).toBeNull();
    expect(unchangedState()).toEqual(before);
    expect(createSession).not.toHaveBeenCalled();
    expect(getSessionAsync).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
  test('recorded requests and failed replies preserve original root ask, not latest transcript', async () => {
    const human = await intake();
    await intake(root.sessionId, 'e4da4c3c-d629-46dc-a550-047144cf9499');
    const item = { ...consultation, originMessageId: human.messageId };
    reserve(item);
    storeSystem(request(item), human);
    expect(service.resolveAskOrigin(request(item))).toEqual(human);
    service.consultations.finish(item.id, 'failed', 'Human stopped waiting');
    storeSystem(reply(item), human);
    const before = unchangedState();
    expect(service.resolveAskOrigin(request(item))).toEqual(human);
    expect(service.resolveAskOrigin(reply(item))).toEqual(human);
    expect(unchangedState()).toEqual(before);
  });
  test('internal holder review follows terminal holder work through its historical consultation', async () => {
    const human = await intake();
    const item = { ...consultation, originMessageId: human.messageId };
    reserve(item);
    storeSystem(request(item), human);
    service.consultations.finish(item.id, 'reported', 'Context checked');
    const proposed = service.repo.proposeWork({
      ...work,
      originSessionId: holder.sessionId,
      originMessageId: request(item).messageId,
    });
    service.repo.transitionWork(proposed.id, proposed, {
      status: 'reported',
      sessionId: 'worker',
      report: 'Reported only',
    });
    const id = `neo-work:${proposed.id}:review`;
    const review = { ...item, id, requestKey: id, originMessageId: null };
    reserve(review);
    storeSystem(request(review), request(item));
    expect(service.resolveAskOrigin(request(review))).toEqual(human);
    service.consultations.finish(id, 'reported', 'Review interpretation');
    storeSystem(reply(review), request(item));
    const before = unchangedState();
    expect(service.resolveAskOrigin(reply(review))).toEqual(human);
    expect(unchangedState()).toEqual(before);
    expect(createSession).not.toHaveBeenCalled();
    expect(getSessionAsync).not.toHaveBeenCalled();
  });
  test.each([holder.sessionId, root.sessionId])(
    'returns to %s remain distinct from legacy nullable origins',
    async (sessionId) => {
      const human = await intake(sessionId);
      const proposed = service.repo.proposeWork({
        ...work,
        originSessionId: sessionId,
        projectId: sessionId === holder.sessionId ? holder.projectId : null,
        originMessageId: human.messageId,
      });
      service.repo.transitionWork(proposed.id, proposed, {
        status: 'failed',
        report: 'Could not start',
      });
      const returned = { sessionId: root.sessionId, messageId: work.id };
      storeSystem(returned, human);
      expect(service.resolveAskOrigin(returned)).toEqual(human);
      const legacy = service.repo.proposeWork({
        ...work,
        id: 'legacy',
        requestKey: 'legacy',
        projectId: null,
        originMessageId: null,
      });
      service.repo.transitionWork(legacy.id, legacy, { status: 'reported' });
      storeSystem({ ...returned, messageId: legacy.id });
      expect(service.resolveAskOrigin({ ...returned, messageId: legacy.id })).toBeNull();
    }
  );
  test('unmarked stored prompts and worker bindings never borrow a human-looking UUID', () => {
    const input = { sessionId: root.sessionId, messageId: 'legacy-input' };
    const unmarked = prompt(input);
    Reflect.deleteProperty(unmarked, 'inputKind');
    expect(mailbox.sdkMessageRepo.saveSDKMessage(input.sessionId, unmarked)).toBe(true);
    expect(service.resolveAskOrigin(input)).toBeNull();
    mailbox.db.prepare('INSERT INTO sessions (id) VALUES (?)').run('worker');
    service.repo.reserveBinding({ sessionId: 'worker', kind: 'worker', projectId: 'a' });
    const workerInput = { ...input, sessionId: 'worker' };
    expect(mailbox.sdkMessageRepo.saveSDKMessage('worker', prompt(workerInput))).toBe(true);
    expect(service.resolveAskOrigin(workerInput)).toBeNull();
  });
});
