/**
 * SDKMessageRepository → LiveQueryEngine reactivity for spaceSessions.bySpace.
 *
 * Regression test for the visible_message_count counter. Now that the query
 * reads a maintained sessions column instead of a correlated COUNT(*) over
 * sdk_messages, its table-deps no longer include sdk_messages — so a message
 * save must trigger re-evaluation via an explicit notifyChange('sessions')
 * emitted by SDKMessageRepository. Without it the live badge would never
 * refresh when messages arrive (the P1 from review round 2 on #2358).
 *
 * Design mirrors goal-repository-live-query.test.ts: wire the reactive layer,
 * subscribe to the real spaceSessions.bySpace SQL, write through the repo, and
 * await a microtask flush before asserting the LiveQuery delta.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
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

    // Snapshot: the one session is present with count 0.
    expect(diffs).toHaveLength(1);
    expect(diffs[0].type).toBe('snapshot');
    expect(diffs[0].rows?.[0]?.messageCount).toBe(0);

    repo.saveSDKMessage(SESSION_ID, createAssistantMessage('hello'));

    // The engine re-evaluates on the reactive 'sessions' change in a microtask.
    await Promise.resolve();
    await Promise.resolve();

    // A delta fired and the session's count moved 0 → 1. The row already existed
    // in the snapshot, so the change surfaces in `updated` (keyed by session id).
    expect(diffs).toHaveLength(2);
    expect(diffs[1].type).toBe('delta');
    expect(diffs[1].updated?.[0]?.id).toBe(SESSION_ID);
    expect(diffs[1].updated?.[0]?.messageCount).toBe(1);
  });

  test('an invisible (subagent) save does not re-evaluate the badge', async () => {
    const diffs: QueryDiff<SpaceSessionRow>[] = [];
    engine.subscribe(sql, [SPACE_ID], (diff) => diffs.push(diff));
    expect(diffs).toHaveLength(1); // snapshot only

    // Subagent row (parent_tool_use_id set) is invisible → counter unchanged →
    // no notifyChange('sessions') → no re-evaluation.
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

    // Save a deferred user message (invisible) → no re-eval.
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

    // Flip to consumed → becomes visible → counter +1 → re-eval.
    repo.updateMessageStatus([id], 'consumed');
    await Promise.resolve();
    await Promise.resolve();

    expect(diffs).toHaveLength(2);
    expect(diffs[1].updated?.[0]?.messageCount).toBe(1);
  });
});
