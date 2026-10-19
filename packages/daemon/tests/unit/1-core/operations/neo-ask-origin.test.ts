import { runMigration366 } from '../../../../src/storage/schema/m366-neo-work-dependencies.ts';
import { runMigration387 } from '../../../../src/storage/schema/m387-neo-ask-todo-tables.ts';
import { runMigration381 } from '../../../../src/storage/schema/m381-neo-ask-refusal.ts';
import { runMigration386 } from '../../../../src/storage/schema/m386-neo-work-control-failures.ts';
import { runMigration358 } from '../../../../src/storage/schema/m358-neo-ask-revisions.ts';
import { runMigration361 } from '../../../../src/storage/schema/m361-neo-project-avatars.ts';
import { runMigration362 } from '../../../../src/storage/schema/m362-neo-driver-configuration.ts';
import { runMigration363 } from '../../../../src/storage/schema/m363-neo-work-refusals.ts';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { MessageHub, Session } from '@hyperneo/shared';
import type { SDKMessage, SDKUserMessage } from '@hyperneo/shared/sdk';
import type { NeoBinding, NeoWork } from '@hyperneo/shared/types/neo-context';
import {
  classifyNeoAskInput,
  createNeoAskOriginResolver,
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
import { runMigration283 } from '../../../../src/storage/schema/m283-neo-work-origins.ts';
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
import { runMigration377 } from '../../../../src/storage/schema/m377-neo-input-origin-trigger.ts';
import { runMigration340 } from '../../../../src/storage/schema/m340-neo-session-seen.ts';
import { runMigration345 } from '../../../../src/storage/schema/m345-neo-work-continue-progress.ts';
import { runMigration344 } from '../../../../src/storage/schema/m344-neo-ask-forwards.ts';
import { createMailboxTestDb, type MailboxTestDb } from '../../../helpers/mailbox-test-db.ts';

const root: NeoBinding = {
  sessionId: 'neo:10000000-0000-4000-8000-000000000001',
  projectId: null,
  kind: 'neo',
};
const holder: NeoBinding = { sessionId: 'holder:a', projectId: 'a', kind: 'worker' };
const ask: NeoAskOrigin = { sessionId: root.sessionId, messageId: 'human:1' };
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
const request = (): NeoAskOrigin => ({
  sessionId: holder.sessionId,
  messageId: 'neo-consult:check:with:delimiters:request',
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
    const note = { sessionId: root.sessionId, messageId: `neo-note:${work.id}` };
    f.put(note, 'system');
    f.stamps.set(f.key(note), ask);
    expect(f.resolve(note)).toEqual(ask);
    f.works.set(work.id, { ...work, status: 'queued' });
    expect(f.resolve(note)).toEqual(ask);
    expect(f.reads.getPrompts).not.toHaveBeenCalled();
  });

  test('an unstamped system note has no ask, and a human input is its own', () => {
    const f = fixtures();
    const note = { sessionId: root.sessionId, messageId: `neo-note:${work.id}` };
    f.put(note, 'system');
    f.put(ask);
    expect(f.resolve(note)).toBeNull();
    expect(f.resolve(ask)).toEqual(ask);
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
  test('admits only the root binding', () => {
    expect(requireNeoAskCoordinator(ask, root)).toEqual({ value: ask });
    expect(requireNeoAskCoordinator(request(), holder)).toEqual({ reason: { kind: 'unknown' } });
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
    runMigration283(mailbox.db);
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
    runMigration377(mailbox.db);
    runMigration340(mailbox.db);
    runMigration345(mailbox.db);
    runMigration344(mailbox.db);
    runMigration358(mailbox.db);
    runMigration361(mailbox.db);
    runMigration362(mailbox.db);
    runMigration366(mailbox.db);
    runMigration381(mailbox.db);
    runMigration386(mailbox.db);
    runMigration387(mailbox.db);
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
  function unchangedState() {
    return {
      sdk: mailbox.sdkRows(),
      jobs: mailbox.rows(),
      projects: service.repo.listProjects(),
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
