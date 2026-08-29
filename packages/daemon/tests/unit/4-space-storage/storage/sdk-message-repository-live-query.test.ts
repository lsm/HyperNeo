import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { createReactiveDatabase } from '../../../../src/storage/reactive-database';
import { LiveQueryEngine } from '../../../../src/storage/live-query';
import { SDKMessageRepository } from '../../../../src/storage/repositories/sdk-message-repository';
import { NAMED_QUERY_REGISTRY } from '../../../../src/lib/rpc-handlers/live-query-handlers';
import { createSpaceTables } from '../../helpers/space-test-db';
import type { ReactiveDatabase } from '../../../../src/storage/reactive-database';
import type { QueryDiff } from '../../../../src/storage/live-query';
import type { SDKMessage } from '@hyperneo/shared/sdk';

interface SpaceSessionRow {
  id: string;
  messageCount: number;
}

const SPACE_ID = 'space-reactivity';
const SESSION_ID = 'sess-reactivity';

function createAssistantMessage(content: string): SDKMessage {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: content }] },
  } as SDKMessage;
}

describe('SDKMessageRepository → LiveQueryEngine reactivity (spaceSessions.bySpace)', () => {
  let bunDb: BunDatabase;
  let reactiveDb: ReactiveDatabase;
  let engine: LiveQueryEngine;
  let repo: SDKMessageRepository;
  let sql: string;

  beforeEach(() => {
    bunDb = new BunDatabase(':memory:');
    createSpaceTables(bunDb);
    reactiveDb = createReactiveDatabase({ getDatabase: () => bunDb } as never);
    engine = new LiveQueryEngine(bunDb, reactiveDb);
    repo = new SDKMessageRepository(bunDb, reactiveDb);

    sql = NAMED_QUERY_REGISTRY.get('spaceSessions.bySpace')!.sql;

    const now = Date.now();
    const iso = new Date(now).toISOString();
    bunDb
      .prepare(
        `INSERT INTO spaces (id, slug, workspace_path, name, session_ids, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        SPACE_ID,
        'reactivity',
        '/ws/reactivity',
        'Reactivity',
        JSON.stringify([SESSION_ID]),
        now,
        now
      );
    bunDb
      .prepare(
        `INSERT INTO sessions (id, title, created_at, last_active_at, status, config, metadata)
         VALUES (?, '', ?, ?, 'active', '{}', '{}')`
      )
      .run(SESSION_ID, iso, iso);
  });

  afterEach(() => {
    engine.dispose();
    bunDb.close();
  });

  test('a visible SDK message save re-evaluates the badge with the new count', async () => {
    const diffs: QueryDiff<SpaceSessionRow>[] = [];
    engine.subscribe(sql, [SPACE_ID], (diff) => diffs.push(diff));

    expect(diffs).toHaveLength(1);
    expect(diffs[0].type).toBe('snapshot');
    expect(diffs[0].rows?.[0]?.messageCount).toBe(0);

    repo.saveSDKMessage(SESSION_ID, createAssistantMessage('hello'));

    await Promise.resolve();
    await Promise.resolve();

    expect(diffs).toHaveLength(2);
    expect(diffs[1].type).toBe('delta');
    expect(diffs[1].updated?.[0]?.id).toBe(SESSION_ID);
    expect(diffs[1].updated?.[0]?.messageCount).toBe(1);
  });

  test('an invisible (subagent) save does not re-evaluate the badge', async () => {
    const diffs: QueryDiff<SpaceSessionRow>[] = [];
    engine.subscribe(sql, [SPACE_ID], (diff) => diffs.push(diff));
    expect(diffs).toHaveLength(1);

    repo.saveSDKMessage(SESSION_ID, {
      type: 'assistant',
      parent_tool_use_id: 'toolu_1',
      message: { role: 'assistant', content: [{ type: 'text', text: 'sub' }] },
    } as SDKMessage);

    await Promise.resolve();
    await Promise.resolve();

    expect(diffs).toHaveLength(1);
  });

  test('a send_status flip into visibility re-evaluates the badge', async () => {
    const diffs: QueryDiff<SpaceSessionRow>[] = [];
    engine.subscribe(sql, [SPACE_ID], (diff) => diffs.push(diff));
    expect(diffs[0].rows?.[0]?.messageCount).toBe(0);

    const id = repo.saveUserMessage(
      SESSION_ID,
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'queued' }] },
      } as SDKMessage,
      'deferred'
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(diffs).toHaveLength(1);

    repo.updateMessageStatus([id], 'consumed');
    await Promise.resolve();
    await Promise.resolve();

    expect(diffs).toHaveLength(2);
    expect(diffs[1].updated?.[0]?.messageCount).toBe(1);
  });
});

describe('SDKMessageRepository internal-compaction turn stamping (#3389)', () => {
  let bunDb: BunDatabase;
  let repo: SDKMessageRepository;

  beforeEach(() => {
    bunDb = new BunDatabase(':memory:');
    createSpaceTables(bunDb);
    repo = new SDKMessageRepository(bunDb);
    const iso = new Date().toISOString();
    bunDb
      .prepare(
        `INSERT INTO sessions (id, title, created_at, last_active_at, status, config, metadata)
         VALUES ('sess-3389', '', ?, ?, 'active', '{}', '{}')`
      )
      .run(iso, iso);
  });

  afterEach(() => {
    bunDb.close();
  });

  function insertConsumedKickoff(uuid: string): void {
    const seq = (
      bunDb
        .prepare(
          `UPDATE delivery_consumed_seq SET next_seq = next_seq + 1 WHERE singleton = 1
           RETURNING next_seq`
        )
        .get() as { next_seq: number }
    ).next_seq;
    bunDb
      .prepare(
        `INSERT INTO sdk_messages
           (id, session_id, message_type, sdk_message, timestamp, send_status, is_terminal, sdk_uuid, consumed_seq)
         VALUES (?, 'sess-3389', 'user', '{}', ?, 'consumed', 0, ?, ?)`
      )
      .run(crypto.randomUUID(), new Date().toISOString(), uuid, seq);
  }

  const zeroTurnSuccess = (): SDKMessage =>
    ({
      type: 'result',
      subtype: 'success',
      uuid: 'compact-save-uuid',
      num_turns: 0,
    }) as unknown as SDKMessage;

  test('the stamp rides the save transaction so the compact turn result cannot satisfy the work delivery', () => {
    insertConsumedKickoff('kickoff-3389');
    expect(
      repo.saveSDKMessage('sess-3389', zeroTurnSuccess(), undefined, {
        stampInternalCompactionTurn: true,
      })
    ).toBe(true);
    expect(repo.hasTerminalResultAfter('sess-3389', 'kickoff-3389')).toBe(false);
  });

  test('without the option the same zero-turn success still satisfies the delivery', () => {
    insertConsumedKickoff('kickoff-3389-unstamped');
    expect(repo.saveSDKMessage('sess-3389', zeroTurnSuccess())).toBe(true);
    expect(repo.hasTerminalResultAfter('sess-3389', 'kickoff-3389-unstamped')).toBe(true);
  });
});
