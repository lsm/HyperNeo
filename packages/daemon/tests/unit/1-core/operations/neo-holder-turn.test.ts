import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { vi } from 'vitest';
import type { MessageHub } from '@hyperneo/shared';
import { Database as SQLite } from '../../../../src/storage/sqlite-compat.ts';
import type { Database } from '../../../../src/storage/database.ts';
import { createNeoTables } from '../../../../src/storage/schema/neo.ts';
import { runMigration279 } from '../../../../src/storage/schema/m279-neo-consultations.ts';
import { runMigration280 } from '../../../../src/storage/schema/m280-neo-context-write-grants.ts';
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
import { CONSULTATION_TIMEOUT_MS } from '../../../../src/lib/neo/consultation-policy.ts';

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
    service.repo.saveConcern(concern, 0);
    service.repo.reserveBinding({ sessionId: 'neo:holder', concernId: 'club', kind: 'concern' });
    service.consultations.reserve({
      id: 'a',
      requestKey: 'a',
      concernId: 'club',
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
  function turn(expire = () => {}) {
    const result = new NeoHolderTurn(db, 'neo:holder', attempts.allocate(), expire);
    turns.push(result);
    return result;
  }
  function save(active: NeoHolderTurn, input: Record<string, unknown> = {}) {
    const handler = createOperationMcpHandler(
      createOperationRegistry(createNeoOperations(service)),
      () => ({ sessionId: 'neo:holder', role: 'neo', neoTurn: active.identity() })
    );
    return handler({
      name: 'neo.concern.save',
      input: { ...concern, expectedRevision: 1, ...input },
      caller: { source: 'rpc', principal: 'local', neoTurn: { human: true } },
    });
  }

  test('consumes one input without waiting for a successor and preserves the next queued input', async () => {
    const firstSent = queue.enqueueWithId('neo-consult:a:request', 'First', false, {
      durable: true,
    });
    const nextSent = queue.enqueueWithId('human-input', 'Next', false, { durable: true });
    const first = turn();
    const input = runner.createMessageGeneratorWrapper(1, undefined, first);
    expect((await input.next()).value?.uuid).toBe('neo-consult:a:request');
    expect(first.identity()?.consultationId).toBe('a');
    expect((await input.next()).done).toBe(true);
    await firstSent;
    expect(queue.size()).toBe(1);
    first.dispose();
    queue.stop();
    queue.start();
    const successor = turn();
    const next = runner.createMessageGeneratorWrapper(2, undefined, successor);
    expect((await next.next()).value?.uuid).toBe('human-input');
    expect((await next.next()).done).toBe(true);
    await nextSent;
    expect(successor.identity()?.human).toBe(true);
    expect(first.identity()?.isLive()).toBe(false);
    expect(queue.size()).toBe(0);
  });

  test.each(['settled', 'expired'] as const)(
    'drains a %s queued consultation once and leaves the next input runnable',
    async (state) => {
      if (state === 'settled') service.consultations.finish('a', 'failed', 'Stopped');
      else
        sqlite
          .prepare('UPDATE neo_consultations SET created_at = ? WHERE id = ?')
          .run(Date.now() - CONSULTATION_TIMEOUT_MS, 'a');
      const firstSent = queue.enqueueWithId('neo-consult:a:request', 'Stale', false, {
        durable: true,
      });
      const nextSent = queue.enqueueWithId('human-input', 'Current', false, { durable: true });
      const expired = mock(() => {});
      const stale = turn(expired);
      const input = runner.createMessageGeneratorWrapper(1, undefined, stale);
      expect(await input.next()).toMatchObject({ done: true });
      await firstSent;
      expect(stale.identity()).toBeUndefined();
      expect(expired).not.toHaveBeenCalled();
      expect(queue.size()).toBe(1);
      queue.stop();
      queue.start();
      const successor = turn();
      const next = runner.createMessageGeneratorWrapper(2, undefined, successor);
      expect((await next.next()).value?.uuid).toBe('human-input');
      expect((await next.next()).done).toBe(true);
      await nextSent;
      expect(successor.identity()?.human).toBe(true);
      expect(queue.size()).toBe(0);
    }
  );

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
      concernId: 'club',
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
    expect(service.repo.getConcern('club')?.context).toBe('Eight people');
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
    expect(service.repo.getConcern('club')?.context).toBe('Direct correction');
    const unknown = turn();
    unknown.bind('untrusted-input');
    expect((await save(unknown, { expectedRevision: 2 })).content).toEqual([
      expect.objectContaining({ text: expect.stringContaining('"ok":false') }),
    ]);
    expect(() => unknown.bind('human-input')).toThrow('already bound');
  });

  test('deadline abort releases a stuck SDK iterator without waiting for its cleanup', async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    sqlite
      .prepare('UPDATE neo_consultations SET created_at = ? WHERE id = ?')
      .run(Date.now() - CONSULTATION_TIMEOUT_MS + 100, 'a');
    const expired = mock(() => abort.abort());
    const active = turn(expired);
    active.bind('neo-consult:a:request');
    const never = new Promise<IteratorResult<unknown>>(() => {});
    const cleanup = mock(() => never);
    const sdk = {
      [Symbol.asyncIterator]: () => ({ next: () => never, return: cleanup }),
    } as unknown as QueryLike;
    const stream = runner.createAbortableQuery(sdk, abort.signal);
    const completion = stream.next();
    await vi.advanceTimersByTimeAsync(100);
    expect(await completion).toMatchObject({ done: true });
    expect(expired).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(active.identity()?.isLive()).toBe(false);
  });

  test('old deadlines cannot interrupt a successor and disposal releases timers', async () => {
    vi.useFakeTimers();
    const expired = mock(() => {});
    const old = turn(expired);
    old.bind('neo-consult:a:request');
    const next = turn();
    next.bind('human-input');
    await vi.advanceTimersByTimeAsync(CONSULTATION_TIMEOUT_MS);
    expect(expired).not.toHaveBeenCalled();
    expect(next.identity()?.isLive()).toBe(true);
    expect(old.identity()?.isLive()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
