import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createNeoRouteCorrectOperation } from '../../../../src/lib/neo/route-correct-operation.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import { createOperationRegistry } from '../../../../src/lib/operations/registry.ts';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository.ts';
import { NeoRoutingLogRepository } from '../../../../src/storage/repositories/neo-routing-log-repository.ts';
import type { Database } from '../../../../src/storage/database.ts';
import { createNeoTables } from '../../../../src/storage/schema/neo.ts';
import { Database as Sqlite } from '../../../../src/storage/sqlite-compat.ts';

describe('neo.route.correct', () => {
  let sqlite: Sqlite;
  let repo: NeoRepository;
  let log: NeoRoutingLogRepository;
  beforeEach(() => {
    sqlite = new Sqlite(':memory:');
    createNeoTables(sqlite);
    repo = new NeoRepository(sqlite);
    log = new NeoRoutingLogRepository(sqlite);
    repo.reserveBinding({ sessionId: 'neo:root', kind: 'neo', concernId: null });
    repo.reserveBinding({ sessionId: 'neo:holder:drivers', kind: 'concern', concernId: 'drivers' });
    log.record({
      messageId: 'ask-1',
      conversationId: 'c',
      askedAt: 1,
      ask: 'restart the daemon',
      destination: 'holder',
      targetSessionId: 'neo:holder:yt',
      concernId: 'youtube',
      signal: 'embedding',
      confidence: 0.6,
    });
  });
  afterEach(() => sqlite.close());

  const correct = (input: unknown) =>
    invokeOperation(
      createOperationRegistry([
        createNeoRouteCorrectOperation({ getDatabase: () => sqlite } as unknown as Database, repo),
      ]),
      'neo.route.correct',
      input,
      { source: 'mcp', sessionId: 'neo:root', role: 'neo' } as never
    ).then((outcome) => (outcome.kind === 'completed' ? outcome.value : outcome));

  test('moves the logged ask to the right topic so the router learns from it', async () => {
    expect(await correct({ messageId: 'ask-1', concernId: 'drivers' })).toEqual({ ok: true });
    expect(log.find('ask-1')).toMatchObject({
      destination: 'holder',
      concernId: 'drivers',
      targetSessionId: 'neo:holder:drivers',
      signal: 'corrected',
      confidence: 1,
    });
    expect(log.recentAsks('drivers', 5)).toEqual(['restart the daemon']);
  });

  test('only main Neo may correct routes', async () => {
    expect(
      await invokeOperation(
        createOperationRegistry([
          createNeoRouteCorrectOperation(
            { getDatabase: () => sqlite } as unknown as Database,
            repo
          ),
        ]),
        'neo.route.correct',
        { messageId: 'ask-1', concernId: 'drivers' },
        { source: 'mcp', sessionId: 'neo:holder:drivers', role: 'neo' } as never
      ).then((outcome) => (outcome.kind === 'completed' ? outcome.value : outcome))
    ).toEqual({ ok: false, reason: 'main_neo_only' });
    expect(log.find('ask-1')?.concernId).toBe('youtube');
  });

  test('rejects an unknown ask or a topic without a holder', async () => {
    expect(await correct({ messageId: 'nope', concernId: 'drivers' })).toEqual({
      ok: false,
      reason: 'unknown_ask',
    });
    expect(await correct({ messageId: 'ask-1', concernId: 'garden' })).toEqual({
      ok: false,
      reason: 'unknown_topic',
    });
  });
});
