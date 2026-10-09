import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { MessageHub, Session } from '@hyperneo/shared';
import type { SDKMessage, SDKUserMessage } from '@hyperneo/shared/sdk';
import type { NeoBinding, NeoConsultation, NeoWork } from '@hyperneo/shared/types/neo-context';
import {
  classifyNeoAskInput,
  createNeoAskOriginResolver,
  neoDoneCheckMessageId,
  neoStallMessageId,
  neoWorkReturnMessageId,
  neoWorkReviewId,
  neoNudgeMessageId,
  readNeoAskEvidence,
  requireNeoAskCoordinator,
  requireNeoAskReference,
  selectNeoAskParent,
  type NeoAskEvidence,
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
import { createMailboxTestDb, type MailboxTestDb } from '../../../helpers/mailbox-test-db.ts';

const root: NeoBinding = {
  sessionId: 'neo:10000000-0000-4000-8000-000000000001',
  concernId: null,
  kind: 'neo',
};
const holder: NeoBinding = { sessionId: 'holder:a', concernId: 'a', kind: 'concern' };
const ask: NeoAskOrigin = { sessionId: root.sessionId, messageId: 'human:1' };
const consultation: NeoConsultation = {
  id: 'check:with:delimiters',
  requestKey: 'key',
  concernId: 'a',
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
  concernId: 'a',
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
const evidence = (patch: Partial<NeoAskEvidence> = {}): NeoAskEvidence => ({
  envelope: 'request',
  consultation,
  work: null,
  root,
  holder,
  workOrigin: root,
  ...patch,
});
function fixtures() {
  const bindings = new Map([root, holder].map((item) => [item.sessionId, item]));
  const prompts = new Map<string, SDKMessage[]>();
  const consultations = new Map([[consultation.id, consultation]]);
  const works = new Map([[work.id, work]]);
  const key = (input: NeoAskOrigin) => JSON.stringify([input.sessionId, input.messageId]);
  const put = (input: NeoAskOrigin, kind = 'human') =>
    prompts.set(key(input), [prompt(input, kind)]);
  const reads: NeoAskOriginReads = {
    getBinding: mock((id: string) => bindings.get(id) ?? null),
    getPrompts: mock(
      (sessionId: string, messageId: string) => prompts.get(key({ sessionId, messageId })) ?? []
    ),
    getConsultation: mock((id: string) => consultations.get(id) ?? null),
    getWork: mock((id: string) => works.get(id) ?? null),
    getRootBinding: mock(() => root),
  };
  return {
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
    { ...root, concernId: 'a' },
    { ...holder, concernId: null },
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
  test('reads exact opaque envelope and review IDs, not their text', () => {
    const f = fixtures();
    const review = { ...consultation, id: `neo-work:${work.id}:review` };
    f.consultations.set(review.id, review);
    expect(readNeoAskEvidence(request(review), f.reads)).toEqual(
      evidence({ consultation: review, work })
    );
    expect(f.reads.getConsultation).toHaveBeenCalledWith(review.id);
    expect(f.reads.getWork).toHaveBeenCalledWith(work.id);
    expect(readNeoAskEvidence(request(), f.reads).work).toBeNull();
  });
  test('reads the work behind a retried review id', () => {
    const f = fixtures();
    const review = { ...consultation, id: neoWorkReviewId(work.id, 2) };
    f.consultations.set(review.id, review);
    expect(readNeoAskEvidence(request(review), f.reads)).toEqual(
      evidence({ consultation: review, work })
    );
  });
  test.each([
    { consultation: null },
    { root: null },
    { root: { ...root, kind: 'worker' as const } },
    { consultation: { ...consultation, id: 'other' } },
    { holder: null },
    { holder: { ...holder, sessionId: 'other' } },
    { holder: { ...holder, concernId: 'b' } },
    { holder: { ...holder, kind: 'worker' as const } },
    { consultation: { ...consultation, originSessionId: 'other' } },
    { consultation: { ...consultation, originMessageId: null } },
  ] satisfies Partial<NeoAskEvidence>[])('rejects invalid consultation evidence: %j', (patch) => {
    expect(selectNeoAskParent(request(), evidence(patch))).toEqual({ kind: 'unknown' });
  });
  test('request history remains readable after settlement; pending reply cannot resolve', () => {
    expect(selectNeoAskParent(request(), evidence())).toEqual({ kind: 'parent', origin: ask });
    expect(selectNeoAskParent(reply(), evidence({ envelope: 'reply' }))).toEqual({
      kind: 'unknown',
    });
    for (const status of ['reported', 'failed'] as const) {
      const settled = { ...consultation, status };
      expect(selectNeoAskParent(request(), evidence({ consultation: settled }))).toEqual({
        kind: 'parent',
        origin: ask,
      });
      expect(
        selectNeoAskParent(reply(), evidence({ consultation: settled, envelope: 'reply' }))
      ).toEqual({ kind: 'parent', origin: ask });
    }
    expect(selectNeoAskParent({ ...request(), sessionId: root.sessionId }, evidence())).toEqual({
      kind: 'unknown',
    });
    expect(
      selectNeoAskParent(
        { ...reply(), sessionId: holder.sessionId },
        evidence({ envelope: 'reply', consultation: { ...consultation, status: 'reported' } })
      )
    ).toEqual({ kind: 'unknown' });
  });
  test.each(['proposed', 'queued', 'cancelled'] as const)('does not resolve %s work', (status) => {
    expect(
      selectNeoAskParent(
        { ...ask, messageId: work.id },
        evidence({ envelope: null, work: { ...work, status } })
      )
    ).toEqual({ kind: 'unknown' });
  });
  test.each([
    { work: null },
    { work: { ...work, id: 'other' } },
    { work: { ...work, originMessageId: null } },
    { workOrigin: null },
    { workOrigin: { ...root, sessionId: 'other' } },
    { workOrigin: { ...root, kind: 'worker' as const } },
    { work: { ...work, originSessionId: holder.sessionId, concernId: 'b' }, workOrigin: holder },
  ] satisfies Partial<NeoAskEvidence>[])(
    'rejects missing or mismatched work provenance: %j',
    (patch) => {
      expect(
        selectNeoAskParent(
          { ...ask, messageId: work.id },
          evidence({ envelope: null, work, ...patch })
        )
      ).toEqual({ kind: 'unknown' });
    }
  );
  test('terminal work links only recorded root/origin targets', () => {
    const direct = { ...work, originSessionId: holder.sessionId };
    const state = evidence({ envelope: null, work: direct, workOrigin: holder });
    for (const sessionId of [root.sessionId, holder.sessionId])
      expect(selectNeoAskParent({ sessionId, messageId: work.id }, state)).toEqual({
        kind: 'parent',
        origin: { ...ask, sessionId: holder.sessionId },
      });
    expect(selectNeoAskParent({ sessionId: 'unrelated', messageId: work.id }, state)).toEqual({
      kind: 'unknown',
    });
  });
  test('internal review requires producer key, null origin, terminal work and same concern', () => {
    const id = `neo-work:${work.id}:review`;
    const review = { ...consultation, id, requestKey: id, originMessageId: null };
    const state = evidence({ consultation: review, work });
    expect(selectNeoAskParent(request(review), Object.freeze(state))).toEqual({
      kind: 'parent',
      origin: ask,
    });
    for (const patch of [
      { work: null },
      { work: { ...work, id: 'other' } },
      { work: { ...work, status: 'queued' as const } },
      { work: { ...work, concernId: 'b' } },
      { work: { ...work, originMessageId: null } },
      { consultation: { ...review, requestKey: 'ordinary' } },
      { consultation: { ...review, originMessageId: ask.messageId } },
    ])
      expect(selectNeoAskParent(request(review), { ...state, ...patch })).toEqual({
        kind: 'unknown',
      });
  });
});

describe('synchronous bounded ask resolver', () => {
  test('gate precedence avoids deeper reads; human prefix resemblance does not create a receipt link', () => {
    const f = fixtures();
    expect(f.resolve({ ...ask, messageId: null })).toBeNull();
    expect(f.reads.getBinding).not.toHaveBeenCalled();
    expect(f.resolve({ ...ask, sessionId: 'ordinary' })).toBeNull();
    expect(f.reads.getPrompts).not.toHaveBeenCalled();
    expect(f.resolve(ask)).toBeNull();
    expect(f.reads.getConsultation).not.toHaveBeenCalled();
    const human = { ...ask, messageId: request().messageId };
    f.put(human);
    expect(f.resolve(human)).toEqual(human);
    expect(f.reads.getRootBinding).not.toHaveBeenCalled();
    expect(f.reads.getWork).not.toHaveBeenCalled();
  });
  test('consultation and holder work resolve the old ask rather than a newer unrelated human input', () => {
    const f = fixtures();
    f.put(ask);
    f.put({ ...ask, messageId: 'newer' });
    f.put(request(), 'system');
    f.put({ ...ask, messageId: work.id }, 'system');
    f.works.set(work.id, {
      ...work,
      originSessionId: holder.sessionId,
      originMessageId: request().messageId,
    });
    expect(f.resolve(request())).toEqual(ask);
    expect(f.resolve({ ...ask, messageId: work.id })).toEqual(ask);
    expect(f.resolve({ ...request(), sessionId: root.sessionId })).toBeNull();
  });
  test('human input in a different concern remains independently attributable', () => {
    const f = fixtures();
    const other = { ...holder, sessionId: 'holder:b', concernId: 'b' };
    f.bindings.set(other.sessionId, other);
    const human = { sessionId: other.sessionId, messageId: ask.messageId };
    f.put(human);
    expect(f.resolve(human)).toEqual(human);
    expect(f.resolve(ask)).toBeNull();
  });
  test('tuple identities cannot collide at colon boundaries', () => {
    const f = fixtures();
    const actualRoot = { ...root, sessionId: 'a:b' };
    const actualHolder = { ...holder, sessionId: 'a' };
    f.bindings.set(actualRoot.sessionId, actualRoot);
    f.bindings.set(actualHolder.sessionId, actualHolder);
    f.reads.getRootBinding = () => actualRoot;
    const human = { sessionId: actualHolder.sessionId, messageId: 'b:c' };
    const returned = { sessionId: actualRoot.sessionId, messageId: 'c' };
    f.put(human);
    f.put(returned, 'system');
    f.works.set('c', {
      ...work,
      id: 'c',
      originSessionId: human.sessionId,
      originMessageId: human.messageId,
    });
    expect(createNeoAskOriginResolver(f.reads)(returned)).toEqual(human);
  });
  test('a publish nudge answers the human message it nudges, never a forged one', () => {
    const f = fixtures();
    const nudge = { sessionId: ask.sessionId, messageId: neoNudgeMessageId(ask.messageId) };
    f.put(ask);
    f.put(nudge, 'system');
    expect(f.resolve(nudge)).toEqual(ask);
    const humanNudge = { sessionId: ask.sessionId, messageId: neoNudgeMessageId('human:2') };
    f.put(humanNudge);
    expect(f.resolve(humanNudge)).toEqual(humanNudge);
    const orphan = { sessionId: ask.sessionId, messageId: neoNudgeMessageId('missing') };
    f.put(orphan, 'system');
    expect(f.resolve(orphan)).toBeNull();
  });
  test('a done-check note answers the ask that started its work, never a forged one', () => {
    const f = fixtures();
    f.put(ask);
    const check = { sessionId: root.sessionId, messageId: neoDoneCheckMessageId(work.id, 2) };
    f.put(check, 'system');
    expect(f.resolve(check)).toEqual(ask);
    const orphan = { sessionId: root.sessionId, messageId: neoDoneCheckMessageId('missing', 0) };
    f.put(orphan, 'system');
    expect(f.resolve(orphan)).toBeNull();
    const elsewhere = { sessionId: 'unrelated', messageId: neoDoneCheckMessageId(work.id, 0) };
    f.put(elsewhere, 'system');
    expect(f.resolve(elsewhere)).toBeNull();
  });
  test('a retried failure note answers the ask that started its work', () => {
    const f = fixtures();
    f.put(ask);
    f.works.set(work.id, { ...work, status: 'failed' });
    const returned = { sessionId: root.sessionId, messageId: neoWorkReturnMessageId(work.id, 1) };
    f.put(returned, 'system');
    expect(f.resolve(returned)).toEqual(ask);
  });
  test('a stall note on running work answers the ask that started it', () => {
    const f = fixtures();
    f.put(ask);
    f.works.set(work.id, { ...work, status: 'queued' });
    const stall = { sessionId: root.sessionId, messageId: neoStallMessageId(work.id, 5) };
    f.put(stall, 'system');
    expect(f.resolve(stall)).toEqual(ask);
    const check = { sessionId: root.sessionId, messageId: neoDoneCheckMessageId(work.id, 0) };
    f.put(check, 'system');
    expect(f.resolve(check)).toBeNull();
  });
  test('cycles stop before rereading and limits do not leak across calls', () => {
    const f = fixtures();
    const a = {
      ...consultation,
      id: 'a',
      status: 'reported' as const,
      originMessageId: 'neo-consult:b:reply',
    };
    const b = { ...a, id: 'b', originMessageId: 'neo-consult:a:reply' };
    f.consultations.set(a.id, a);
    f.consultations.set(b.id, b);
    f.put(reply(a), 'system');
    f.put(reply(b), 'system');
    expect(f.resolve(reply(a))).toBeNull();
    expect(f.reads.getPrompts).toHaveBeenCalledTimes(2);
    f.put(ask);
    f.consultations.set(b.id, { ...b, originMessageId: ask.messageId });
    expect(f.resolve(reply(a))).toEqual(ask);
  });
  test('at most eight synchronous input reads, with no microtask hop or provider work', async () => {
    const f = fixtures();
    for (let index = 0; index < 9; index++) {
      const item = {
        ...consultation,
        id: String(index),
        status: 'reported' as const,
        originMessageId: `neo-consult:${index + 1}:reply`,
      };
      f.consultations.set(item.id, item);
      f.put(reply(item), 'system');
    }
    let microtask = false;
    queueMicrotask(() => {
      microtask = true;
    });
    expect(f.resolve(reply({ ...consultation, id: '0' }))).toBeNull();
    expect(microtask).toBe(false);
    expect(f.reads.getPrompts).toHaveBeenCalledTimes(8);
    const eighth = reply({ ...consultation, id: '7' });
    f.put(eighth);
    expect(f.resolve(reply({ ...consultation, id: '0' }))).toEqual(eighth);
    await Promise.resolve();
    expect(microtask).toBe(true);
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
    runMigration279(mailbox.db);
    runMigration282(mailbox.db);
    runMigration283(mailbox.db);
    runMigration285(mailbox.db);
    runMigration289(mailbox.db);
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
    service.repo.saveConcern({ id: 'a', title: 'A', summary: '', context: '' }, 0);
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
  function storeSystem(input: NeoAskOrigin) {
    expect(
      mailbox.sdkMessageRepo.saveSDKMessage(input.sessionId, prompt(input, 'system'), 'system')
    ).toBe(true);
  }
  function reserve(item: NeoConsultation) {
    expect(service.consultations.reserve(item)?.id).toBe(item.id);
  }
  function unchangedState() {
    return {
      sdk: mailbox.sdkRows(),
      jobs: mailbox.rows(),
      concerns: service.repo.listConcerns(),
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
    if (result.kind !== 'completed') throw new Error('Snapshot did not complete');
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
    storeSystem(request(item));
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
    storeSystem(request(review));
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
    service.repo.saveConcern(
      { id: 'a', title: 'A', summary: 'Summary A', context: 'Private A' },
      1
    );
    service.repo.saveConcern(
      { id: 'b', title: 'B', summary: 'Summary B', context: 'Private B' },
      0
    );
    service.repo.proposeWork({ ...work, originMessageId: a.messageId });
    service.repo.proposeWork({
      ...work,
      id: 'work-b',
      requestKey: 'b',
      concernId: 'b',
      originMessageId: b.messageId,
    });
    reserve({ ...consultation, originMessageId: a.messageId });
    const rootCaller: OperationCaller = { source: 'mcp', role: 'neo', sessionId: root.sessionId };
    const holderCaller: OperationCaller = { ...rootCaller, sessionId: holder.sessionId };
    const overview = await snapshot(rootCaller);
    expect(overview.concerns.map((item) => item.context)).toEqual(['', '']);
    expect(overview.work.every((item) => item.instruction === '' && item.report === null)).toBe(
      true
    );
    expect(overview.consultations![0]).toMatchObject({ question: '', answer: null });
    expect(overview.askOrigins).toContainEqual({ kind: 'work', id: 'work-b', origin: b });
    const scoped = await snapshot(holderCaller);
    expect(scoped.concerns.map((item) => item.id)).toEqual(['a']);
    expect(scoped.concerns[0].context).toBe('Private A');
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
        { concernId: 'b' },
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
    storeSystem(request(item));
    storeSystem(reply(item));
    expect(service.resolveAskOrigin(request(item))).toEqual(human);
    expect(service.resolveAskOrigin(reply(item))).toBeNull();
    service.consultations.finish(item.id, 'failed', 'Human stopped waiting');
    const before = unchangedState();
    expect(service.resolveAskOrigin(request(item))).toEqual(human);
    expect(service.resolveAskOrigin(reply(item))).toEqual(human);
    expect(unchangedState()).toEqual(before);
  });
  test('internal holder review follows terminal holder work through its historical consultation', async () => {
    const human = await intake();
    const item = { ...consultation, originMessageId: human.messageId };
    reserve(item);
    storeSystem(request(item));
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
    storeSystem(request(review));
    expect(service.resolveAskOrigin(request(review))).toEqual(human);
    service.consultations.finish(id, 'reported', 'Review interpretation');
    storeSystem(reply(review));
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
        concernId: sessionId === holder.sessionId ? holder.concernId : null,
        originMessageId: human.messageId,
      });
      service.repo.transitionWork(proposed.id, proposed, {
        status: 'failed',
        report: 'Could not start',
      });
      const returned = { sessionId: root.sessionId, messageId: work.id };
      storeSystem(returned);
      expect(service.resolveAskOrigin(returned)).toEqual(human);
      const legacy = service.repo.proposeWork({
        ...work,
        id: 'legacy',
        requestKey: 'legacy',
        concernId: null,
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
    service.repo.reserveBinding({ sessionId: 'worker', kind: 'worker', concernId: 'a' });
    const workerInput = { ...input, sessionId: 'worker' };
    expect(mailbox.sdkMessageRepo.saveSDKMessage('worker', prompt(workerInput))).toBe(true);
    expect(service.resolveAskOrigin(workerInput)).toBeNull();
  });
});
