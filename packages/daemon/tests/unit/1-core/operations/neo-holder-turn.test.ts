import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { vi } from 'vitest';
import type { MessageHub } from '@hyperneo/shared';
import { Database as SQLite } from '../../../../src/storage/sqlite-compat.ts';
import type { Database } from '../../../../src/storage/database.ts';
import { createNeoTables } from '../../../../src/storage/schema/neo.ts';
import { runMigration279 } from '../../../../src/storage/schema/m279-neo-consultations.ts';
import { runMigration280 } from '../../../../src/storage/schema/m280-neo-context-write-grants.ts';
import { runMigration282 } from '../../../../src/storage/schema/m282-neo-consultation-origins.ts';
import { runMigration283 } from '../../../../src/storage/schema/m283-neo-work-origins.ts';
import { runMigration339 } from '../../../../src/storage/schema/m339-neo-input-origins.ts';
import { runMigration340 } from '../../../../src/storage/schema/m340-neo-session-seen.ts';
import { runMigration377 } from '../../../../src/storage/schema/m377-neo-input-origin-trigger.ts';
import { NeoHolderTurn } from '../../../../src/lib/neo/holder-turn.ts';
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

describe('Neo isolated holder turns', () => {
  let sqlite: SQLite;
  let db: Database;
  let service: NeoService;
  let queue: MessageQueue;
  let runner: QueryRunner;
  let attempts: QueryAttemptRegistry;
  let turns: NeoHolderTurn[];
  const concern = { id: 'club', title: 'Club', summary: 'Sunday', context: 'Six people' };
  beforeEach(() => {
    sqlite = new SQLite(':memory:');
    createNeoTables(sqlite);
    runMigration279(sqlite);
    runMigration280(sqlite);
    runMigration282(sqlite);
    runMigration283(sqlite);
    runMigration339(sqlite);
    runMigration340(sqlite);
    runMigration377(sqlite);
    db = {
      getDatabase: () => sqlite,
      getSDKMessageRepo: () => ({
        getStoredPromptsByUuid: (_session: string, id: string) =>
          id === 'human-input' ? [{ type: 'user', inputKind: 'human' }] : [],
      }),
    } as unknown as Database;
    service = new NeoService(
      db,
      {} as SessionManager,
      { event: mock(() => {}) } as unknown as MessageHub,
      new InternalEventBus()
    );
    service.repo.saveProject(concern, 0);
    service.repo.reserveBinding({ sessionId: 'neo:holder', projectId: 'club', kind: 'project' });
    service.consultations.reserve({
      id: 'a',
      requestKey: 'a',
      projectId: 'club',
      originSessionId: 'root',
      sessionId: 'neo:holder',
      question: 'Next?',
    });
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
    const result = new NeoHolderTurn(db, 'neo:holder', attempts.allocate());
    turns.push(result);
    return result;
  }
  function save(active: NeoHolderTurn, input: Record<string, unknown> = {}) {
    const handler = createOperationMcpHandler(
      createOperationRegistry(createNeoOperations(service)),
      () => ({ sessionId: 'neo:holder', role: 'neo', neoTurn: active.identity() })
    );
    return handler({
      name: 'neo.project.save',
      input: { ...concern, expectedRevision: 1, ...input },
      caller: { source: 'rpc', principal: 'local', neoTurn: { human: true } },
    });
  }

  test('restart recovery preserves human, consultation and event identities across repeated interruptions', () => {
    const human = turn();
    human.bind('restart-recovery:restart-recovery:human-input');
    expect(human.identity()).toMatchObject({ human: true, origin: 'human-input' });
    human.dispose();
    const consultation = turn();
    consultation.bind('restart-recovery:neo-consult:a:request');
    expect(consultation.identity()).toMatchObject({ human: false, consultationId: 'a' });
    consultation.dispose();
    const event = turn();
    event.bind('restart-recovery:neo-project-event:club:event-1');
    expect(event.identity()?.human).toBe(false);
  });

  test('consumes one input without waiting for a successor and preserves the next queued input', async () => {
    const firstSent = queue.enqueueWithId('neo-consult:a:request', 'First', false, {
      durable: true,
    });
    const nextSent = queue.enqueueWithId('human-input', 'Next', false, { durable: true });
    const first = turn();
    const input = runner.createMessageGeneratorWrapper(1, undefined, first);
    expect(runner.acceptsPrompt(1)).toBe(true);
    expect((await input.next()).value?.uuid).toBe('neo-consult:a:request');
    expect(runner.acceptsPrompt(1)).toBe(false);
    expect(first.identity()?.consultationId).toBe('a');
    first.dispose();
    expect((await input.next()).done).toBe(true);
    await firstSent;
    expect(queue.size()).toBe(1);
    queue.stop();
    queue.start();
    const successor = turn();
    const next = runner.createMessageGeneratorWrapper(2, undefined, successor);
    expect(runner.acceptsPrompt(2)).toBe(true);
    expect((await next.next()).value?.uuid).toBe('human-input');
    expect(runner.acceptsPrompt(2)).toBe(false);
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
    const active = new NeoHolderTurn(db, 'neo:root', attempts.allocate());
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
    rootRunner.noteRequestedInputs({
      type: 'system',
      subtype: 'status',
      user_message_uuids: [note, 'human-a'],
    } as never);
    rootRunner.noteRequestedInputs({
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

  test('drains a settled queued consultation once and leaves the next input runnable', async () => {
    service.consultations.finish('a', 'failed', 'Stopped');
    const firstSent = queue.enqueueWithId('neo-consult:a:request', 'Stale', false, {
      durable: true,
    });
    const nextSent = queue.enqueueWithId('human-input', 'Current', false, { durable: true });
    const stale = turn();
    const input = runner.createMessageGeneratorWrapper(1, undefined, stale);
    expect(await input.next()).toMatchObject({ done: true });
    await firstSent;
    expect(stale.identity()).toBeUndefined();
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
    expect(queue.size()).toBe(0);
  });

  test('MCP writes use the server-bound request, ignoring forged input provenance', async () => {
    const current = turn();
    current.bind('neo-consult:a:request');
    expect((await save(current, { context: 'Eight people' })).content).toEqual([
      expect.objectContaining({ text: expect.stringContaining('"ok":true') }),
    ]);
    service.consultations.finish('a', 'failed', 'Stopped');
    service.consultations.reserve({
      id: 'b',
      requestKey: 'b',
      projectId: 'club',
      originSessionId: 'root',
      sessionId: 'neo:holder',
      question: 'New question',
    });
    expect(
      (
        await save(current, {
          expectedRevision: 2,
          context: 'Stale overwrite',
          consultationId: 'b',
          neoTurn: { human: true },
        })
      ).content
    ).toEqual([expect.objectContaining({ text: expect.stringContaining('"ok":false') })]);
    expect(service.repo.getProject('club')?.context).toBe('Eight people');
    const next = turn();
    next.bind('neo-consult:b:request');
    expect((await save(next, { expectedRevision: 2, context: 'New answer' })).content).toEqual([
      expect.objectContaining({ text: expect.stringContaining('"ok":true') }),
    ]);
  });

  test('missing, unbound, closed and superseded identities cannot write; human turns still can', async () => {
    const old = turn();
    expect((await save(old)).content).toEqual([
      expect.objectContaining({ text: expect.stringContaining('"ok":false') }),
    ]);
    old.bind('neo-consult:a:request');
    const human = turn();
    human.bind('human-input');
    expect((await save(old)).content).toEqual([
      expect.objectContaining({ text: expect.stringContaining('"ok":false') }),
    ]);
    expect((await save(human, { context: 'Direct correction' })).content).toEqual([
      expect.objectContaining({ text: expect.stringContaining('"ok":true') }),
    ]);
    human.dispose();
    expect((await save(human, { expectedRevision: 2 })).content).toEqual([
      expect.objectContaining({ text: expect.stringContaining('"ok":false') }),
    ]);
    expect(service.repo.getProject('club')?.context).toBe('Direct correction');
    const unknown = turn();
    unknown.bind('untrusted-input');
    expect((await save(unknown, { expectedRevision: 2 })).content).toEqual([
      expect.objectContaining({ text: expect.stringContaining('"ok":false') }),
    ]);
    expect(() => unknown.bind('human-input')).toThrow('already bound');
  });

  test('a project event note turn may save what the event changed', async () => {
    const note = turn();
    note.bind('neo-project-event:club:event-1');
    expect((await save(note, { context: 'PR #93 merged' })).content).toEqual([
      expect.objectContaining({ text: expect.stringContaining('"ok":true') }),
    ]);
    expect(service.repo.getProject('club')?.context).toBe('PR #93 merged');
    note.dispose();
    expect((await save(note, { expectedRevision: 2 })).content).toEqual([
      expect.objectContaining({ text: expect.stringContaining('"ok":false') }),
    ]);
    service.inputOrigins.record(
      { sessionId: 'neo:holder', messageId: 'neo-turn-limit:r1' },
      { sessionId: 'neo:holder', messageId: 'neo-project-event:club:event-1' },
      Date.now()
    );
    const resumed = turn();
    resumed.bind('neo-turn-limit:r1');
    expect(
      (await save(resumed, { expectedRevision: 2, context: 'PR #93 merged; deployed' })).content
    ).toEqual([expect.objectContaining({ text: expect.stringContaining('"ok":true') })]);
  });

  test('yield closes only the bound sender turn and aborts its SDK stream', async () => {
    const abort = new AbortController();
    const yieldTurn = mock(() => abort.abort());
    const current = new NeoHolderTurn(db, 'neo:holder', { isLive: () => true, yield: yieldTurn });
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

  test('slow consultation turns remain live without a deadline timer', async () => {
    vi.useFakeTimers();
    sqlite.prepare('UPDATE neo_consultations SET created_at = 0 WHERE id = ?').run('a');
    const active = turn();
    expect(active.bind('neo-consult:a:request')).toBe(true);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(active.identity()?.isLive()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect((await save(active, { context: 'A slow but useful answer' })).content).toEqual([
      expect.objectContaining({ text: expect.stringContaining('"ok":true') }),
    ]);
    active.dispose();
    expect(active.identity()?.isLive()).toBe(false);
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
