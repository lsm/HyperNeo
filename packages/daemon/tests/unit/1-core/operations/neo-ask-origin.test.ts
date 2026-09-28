import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { MessageHub, Session } from '@hyperneo/shared';
import type { SDKMessage, SDKUserMessage } from '@hyperneo/shared/sdk';
import type { NeoBinding, NeoConsultation, NeoWork } from '@hyperneo/shared/types/neo-context';
import {
  classifyNeoAskInput,
  createNeoAskOriginResolver,
  readNeoAskEvidence,
  requireNeoAskCoordinator,
  requireNeoAskReference,
  selectNeoAskParent,
  type NeoAskEvidence,
  type NeoAskOrigin,
  type NeoAskOriginReads,
} from '../../../../src/lib/neo/ask-origin.ts';
import { createNeoIntakeOperation } from '../../../../src/lib/neo/intake.ts';
import { NeoService } from '../../../../src/lib/neo/service.ts';
import { InternalEventBus } from '../../../../src/lib/internal-event-bus.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import { createOperationRegistry } from '../../../../src/lib/operations/registry.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import type { Database } from '../../../../src/storage/database.ts';
import { createNeoTables } from '../../../../src/storage/schema/neo.ts';
import { runMigration279 } from '../../../../src/storage/schema/m279-neo-consultations.ts';
import { runMigration282 } from '../../../../src/storage/schema/m282-neo-consultation-origins.ts';
import { runMigration283 } from '../../../../src/storage/schema/m283-neo-work-origins.ts';
import { createMailboxTestDb, type MailboxTestDb } from '../../../helpers/mailbox-test-db.ts';

const root: NeoBinding = { sessionId: 'root', concernId: null, kind: 'neo' };
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
