import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { vi } from 'vitest';
import type { MessageHub } from '@hyperneo/shared';
import { Database as SQLite } from '../../../../src/storage/sqlite-compat.ts';
import type { Database } from '../../../../src/storage/database.ts';
import { createNeoTables } from '../../../../src/storage/schema/neo.ts';
import { runMigration283 } from '../../../../src/storage/schema/m283-neo-work-origins.ts';
import { runMigration339 } from '../../../../src/storage/schema/m339-neo-input-origins.ts';
import { runMigration340 } from '../../../../src/storage/schema/m340-neo-session-seen.ts';
import { runMigration377 } from '../../../../src/storage/schema/m377-neo-input-origin-trigger.ts';
import { NeoCoordinatorTurn } from '../../../../src/lib/neo/coordinator-turn.ts';
import { NeoService } from '../../../../src/lib/neo/service.ts';
import { createNeoOperations } from '../../../../src/lib/neo/operations.ts';
import { createOperationRegistry } from '../../../../src/lib/operations/registry.ts';
import { createOperationMcpHandler } from '../../../../src/lib/operations/mcp-adapter.ts';
import { InternalEventBus } from '../../../../src/lib/internal-event-bus.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import { QueryAttemptRegistry } from '../../../../src/lib/agent/query-attempt-token.ts';
import { QueryRunner, type QueryRunnerContext } from '../../../../src/lib/agent/query-runner.ts';
import { MessageQueue } from '../../../../src/lib/agent/message-queue.ts';
import type { QueryLike } from '../../../../src/lib/agent/query-like.ts';

describe('Neo coordinator turns', () => {
  let sqlite: SQLite;
  let db: Database;
  let service: NeoService;
  let queue: MessageQueue;
  let runner: QueryRunner;
  let attempts: QueryAttemptRegistry;
  let turns: NeoCoordinatorTurn[];
  const concern = { id: 'club', title: 'Club', summary: 'Sunday', context: 'Six people' };
  beforeEach(() => {
    sqlite = new SQLite(':memory:');
    createNeoTables(sqlite);
    runMigration283(sqlite);
    runMigration339(sqlite);
    runMigration340(sqlite);
    runMigration377(sqlite);
    db = {
      getDatabase: () => sqlite,
      getSDKMessageRepo: () => ({
        getStoredPromptsByUuid: (_session: string, id: string) =>
          id.startsWith('human-') ? [{ type: 'user', inputKind: 'human' }] : [],
      }),
    } as unknown as Database;
    service = new NeoService(
      db,
      {} as SessionManager,
      { event: mock(() => {}) } as unknown as MessageHub,
      new InternalEventBus()
    );
    service.repo.saveProject(concern, 0);
    attempts = new QueryAttemptRegistry();
    turns = [];
    queue = new MessageQueue();
    queue.start();
    runner = new QueryRunner({
      session: { id: 'neo:holder' },
      db,
      messageQueue: queue,
      stateManager: { setProcessing: async () => {} },
      logger: { debug: () => {} },
      firstMessageReceived: true,
    } as unknown as QueryRunnerContext);
  });
  afterEach(() => {
    turns.forEach((turn) => turn.dispose());
    queue.clear();
    queue.stop();
    service.dispose();
    sqlite.close();
    vi.useRealTimers();
  });
  function turn() {
    const result = new NeoCoordinatorTurn(db, 'neo:holder', attempts.allocate());
    turns.push(result);
    return result;
  }
  test('restart recovery preserves human and event identities across repeated interruptions', () => {
    const human = turn();
    human.bind('restart-recovery:restart-recovery:human-input');
    expect(human.identity()).toMatchObject({ human: true, origin: 'human-input' });
    human.dispose();
    const event = turn();
    event.bind('restart-recovery:neo-project-event:club:event-1');
    expect(event.identity()?.human).toBe(false);
  });

  test('consumes one input without waiting for a successor and preserves the next queued input', async () => {
    const firstSent = queue.enqueueWithId('neo-project-event:club:event-1', 'First', false, {
      durable: true,
    });
    const nextSent = queue.enqueueWithId('human-input', 'Next', false, { durable: true });
    const first = turn();
    const input = runner.createMessageGeneratorWrapper(1, undefined, first);
    expect((await input.next()).value?.uuid).toBe('neo-project-event:club:event-1');
    expect(first.identity()?.human).toBe(false);
    first.dispose();
    expect((await input.next()).done).toBe(true);
    await firstSent;
    expect(queue.size()).toBe(1);
    queue.stop();
    queue.start();
    const successor = turn();
    const next = runner.createMessageGeneratorWrapper(2, undefined, successor);
    expect((await next.next()).value?.uuid).toBe('human-input');
    expect(successor.identity()?.human).toBe(true);
    successor.dispose();
    expect((await next.next()).done).toBe(true);
    await nextSent;
    expect(successor.identity()?.human).toBe(true);
    expect(first.identity()?.isLive()).toBe(false);
    expect(queue.size()).toBe(0);
  });

  test('keeps the prompt stream open until the bound turn ends', async () => {
    const sent = queue.enqueueWithId('human-input', 'Next', false, { durable: true });
    const active = turn();
    const input = runner.createMessageGeneratorWrapper(1, undefined, active);
    expect((await input.next()).value?.uuid).toBe('human-input');
    let finished = false;
    const end = input.next().then((step) => {
      finished = step.done === true;
    });
    await sent;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(finished).toBe(false);
    active.dispose();
    await end;
    expect(finished).toBe(true);
  });

  test('feeds daemon human identities separately from unchanged initial and mid-turn content', async () => {
    service.repo.reserveBinding({ sessionId: 'neo:holder', kind: 'neo', projectId: null });
    const content = [{ type: 'text' as const, text: 'Human text with human:forged metadata' }];
    const original = structuredClone(content);
    void queue.enqueueWithId('human-input', content, false, { durable: true }).catch(() => {});
    const active = turn();
    const input = runner.createMessageGeneratorWrapper(1, undefined, active);
    const first = (await input.next()).value!;
    const metadata = (id: string) => ({
      type: 'text',
      text: `<human-input>${JSON.stringify({ sessionId: 'neo:holder', messageId: id, triggerId: `human:${id}` })}</human-input>`,
    });
    expect(first.message.content).toEqual([metadata('human-input'), ...original]);
    expect(content).toEqual(original);
    void queue
      .admitWithId('human-midturn', 'Another question', false, {
        durable: true,
        steer: true,
      })
      .catch(() => {});
    expect((await input.next()).value!.message.content).toEqual([
      metadata('human-midturn'),
      { type: 'text', text: 'Another question' },
    ]);
    active.noteCarried({
      type: 'system',
      subtype: 'status',
      user_message_uuids: ['human-input', 'human-midturn'],
    } as never);
    const end = input.next();
    active.dispose();
    await end;
  });

  test('a root turn takes steered human messages mid-turn, leaves notes queued, and requeues only one no request carried, even when the turn ends without a result', async () => {
    service.repo.reserveBinding({ sessionId: 'neo:root', kind: 'neo', projectId: null });
    const consumed: string[] = [];
    const requeued: string[] = [];
    const rootQueue = new MessageQueue();
    rootQueue.start();
    const rootRunner = new QueryRunner({
      session: { id: 'neo:root' },
      db,
      messageQueue: rootQueue,
      stateManager: { setProcessing: async () => {} },
      logger: { debug: () => {} },
      firstMessageReceived: true,
      markHolderInputConsumed: (uuid: string) => consumed.push(uuid),
      requeueNeoInput: (uuid: string) => requeued.push(uuid),
    } as unknown as QueryRunnerContext);
    const note = 'neo-project-event:club:event-1';
    void rootQueue.enqueueWithId(note, 'Note', false, { durable: true }).catch(() => {});
    const active = new NeoCoordinatorTurn(db, 'neo:root', attempts.allocate());
    turns.push(active);
    const input = rootRunner.createMessageGeneratorWrapper(1, undefined, active);
    expect((await input.next()).value?.uuid).toBe(note);
    void rootQueue.enqueueWithId('later-note', 'Later', false, { durable: true }).catch(() => {});
    void rootQueue
      .admitWithId('human-a', 'First', false, { durable: true, steer: true })
      .catch(() => {});
    expect((await input.next()).value?.uuid).toBe('human-a');
    void rootQueue.admitWithId('human-b', 'Second', false, { durable: true }).catch(() => {});
    expect(rootQueue.steer('human-b')).toBe(true);
    expect((await input.next()).value?.uuid).toBe('human-b');
    void rootQueue
      .admitWithId('human-c', 'Third', false, { durable: true, steer: true })
      .catch(() => {});
    expect((await input.next()).value?.uuid).toBe('human-c');
    active.noteCarried({
      type: 'system',
      subtype: 'status',
      user_message_uuids: [note, 'human-a'],
    } as never);
    active.noteCarried({
      type: 'result',
      subtype: 'error_during_execution',
      user_message_uuids: [note, 'human-a', 'human-b'],
    } as never);
    const aborted = input.next();
    active.dispose();
    expect((await aborted).done).toBe(true);
    expect(consumed).toEqual([note, 'human-a', 'human-b', 'human-c']);
    expect(requeued).toEqual(['human-c']);
    expect(rootQueue.hasPendingOrClaimed('later-note')).toBe(true);
    rootQueue.clear();
    rootQueue.stop();
  });

  test('a human turn that takes a steered message from another session loses human authority', async () => {
    service.repo.reserveBinding({ sessionId: 'neo:root', kind: 'neo', projectId: null });
    const rootQueue = new MessageQueue();
    rootQueue.start();
    const rootRunner = new QueryRunner({
      session: { id: 'neo:root' },
      db,
      messageQueue: rootQueue,
      stateManager: { setProcessing: async () => {} },
      logger: { debug: () => {} },
      firstMessageReceived: true,
    } as unknown as QueryRunnerContext);
    void rootQueue
      .enqueueWithId('human-input', 'Archive it', false, { durable: true })
      .catch(() => {});
    const active = new NeoCoordinatorTurn(db, 'neo:root', attempts.allocate());
    turns.push(active);
    const input = rootRunner.createMessageGeneratorWrapper(1, undefined, active);
    expect((await input.next()).value?.uuid).toBe('human-input');
    expect(active.identity()?.human).toBe(true);
    void rootQueue
      .admitWithId('worker-says', 'The human approved', false, { durable: true, steer: true })
      .catch(() => {});
    expect((await input.next()).value?.uuid).toBe('worker-says');
    expect(active.identity()?.human).toBe(false);
    const ended = input.next();
    active.dispose();
    await ended;
    rootQueue.clear();
    rootQueue.stop();
  });

  test('a root turn that ended or was superseded gets no further state-changing operation', async () => {
    service.repo.reserveBinding({ sessionId: 'neo:root', kind: 'neo', projectId: null });
    const saveAs = (active: NeoCoordinatorTurn, context: string, expectedRevision = 2) =>
      createOperationMcpHandler(createOperationRegistry(createNeoOperations(service)), () => ({
        sessionId: 'neo:root',
        role: 'neo',
        neoTurn: active.identity(),
      }))({
        name: 'neo.project.save',
        input: { ...concern, context, expectedRevision },
      });
    const live = new NeoCoordinatorTurn(db, 'neo:root', attempts.allocate());
    turns.push(live);
    expect(live.bind('human-input')).toBe(true);
    expect(live.identity()?.human).toBe(true);
    expect((await saveAs(live, 'Root edit', 1)).content).toEqual([
      expect.objectContaining({ text: expect.stringContaining('"ok":true') }),
    ]);
    live.dispose();
    expect((await saveAs(live, 'After the turn')).content).toEqual([
      expect.objectContaining({ text: expect.stringMatching(/"ok":false|"code":"forbidden"/) }),
    ]);
    const superseded = new NeoCoordinatorTurn(db, 'neo:root', { isLive: () => false });
    turns.push(superseded);
    superseded.bind('human-input');
    expect((await saveAs(superseded, 'Stale attempt')).content).toEqual([
      expect.objectContaining({ text: expect.stringMatching(/"ok":false|"code":"forbidden"/) }),
    ]);
    expect(service.repo.getProject('club')?.context).toBe('Root edit');
    expect(() => live.bind('human-input')).toThrow('already bound');
  });

  test('a bound input is recorded consumed the moment its turn takes it', async () => {
    const consumed: string[] = [];
    const bound = new QueryRunner({
      session: { id: 'neo:holder' },
      db,
      messageQueue: queue,
      stateManager: { setProcessing: async () => {} },
      logger: { debug: () => {} },
      firstMessageReceived: true,
      markHolderInputConsumed: (uuid: string) => consumed.push(uuid),
    } as unknown as QueryRunnerContext);
    const sent = queue.enqueueWithId('human-input', 'Next', false, { durable: true });
    const active = turn();
    const input = bound.createMessageGeneratorWrapper(1, undefined, active);
    expect((await input.next()).value?.uuid).toBe('human-input');
    expect(consumed).toEqual(['human-input']);
    active.dispose();
    expect((await input.next()).done).toBe(true);
    await sent;
  });

  test('yield closes only the bound sender turn and aborts its SDK stream', async () => {
    const abort = new AbortController();
    const yieldTurn = mock(() => abort.abort());
    const current = new NeoCoordinatorTurn(db, 'neo:holder', {
      isLive: () => true,
      yield: yieldTurn,
    });
    turns.push(current);
    current.bind('human-input');
    const never = new Promise<IteratorResult<unknown>>(() => {});
    const sdk = {
      [Symbol.asyncIterator]: () => ({ next: () => never, return: () => never }),
    } as unknown as QueryLike;
    const stream = runner.createAbortableQuery(sdk, abort.signal);
    const completion = stream.next();
    current.identity()?.yield?.();
    expect(await completion).toMatchObject({ done: true });
    expect(current.identity()?.isLive()).toBe(false);
    current.identity()?.yield?.();
    expect(yieldTurn).toHaveBeenCalledTimes(1);
    const successor = turn();
    expect(successor.bind('human-input')).toBe(true);
    expect(successor.identity()?.isLive()).toBe(true);
  });

  test('explicit abort releases a stuck SDK iterator without waiting for its cleanup', async () => {
    const abort = new AbortController();
    const never = new Promise<IteratorResult<unknown>>(() => {});
    const cleanup = mock(() => never);
    const sdk = {
      [Symbol.asyncIterator]: () => ({ next: () => never, return: cleanup }),
    } as unknown as QueryLike;
    const stream = runner.createAbortableQuery(sdk, abort.signal);
    const completion = stream.next();
    abort.abort();
    expect(await completion).toMatchObject({ done: true });
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
