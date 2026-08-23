import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { HyperNeoActionMessage } from '@hyperneo/shared';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import {
  planAdmissionBadgeUpdate,
  planBadgeRecompute,
} from '../../../../src/storage/repositories/sdk-message-badge';
import { SDKMessageRepository } from '../../../../src/storage/repositories/sdk-message-repository';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { createReactiveDatabase } from '../../../../src/storage/reactive-database';
import type { ReactiveDatabase, TableChangeScope } from '../../../../src/storage/reactive-database';
import { createSpaceTables } from '../../helpers/space-test-db';

const NOW = '2026-01-01T00:00:00.000Z';
const SID = 'sess-badge-b3';

function userMessage(uuid: string): SDKMessage {
  return {
    type: 'user',
    uuid,
    message: { role: 'user', content: [{ type: 'text', text: `text-${uuid}` }] },
  } as unknown as SDKMessage;
}

function assistantMessage(uuid: string): SDKMessage {
  return {
    type: 'assistant',
    uuid,
    message: { role: 'assistant', content: [{ type: 'text', text: `text-${uuid}` }] },
  } as unknown as SDKMessage;
}

function hiddenSubtypeMessage(subtype: string, uuid: string): SDKMessage {
  return { type: 'system', subtype, uuid } as unknown as SDKMessage;
}

function actionMessage(uuid: string): HyperNeoActionMessage {
  return {
    type: 'hyperneo_action',
    uuid,
    session_id: SID,
    action: 'sdk_resume_choice',
    resolved: false,
    timestamp: Date.parse('2026-02-03T04:05:06.000Z'),
  };
}

describe('badge instruction planning (chain B3)', () => {
  test('an admission record that counts toward the badge plans a delta of +1', () => {
    expect(planAdmissionBadgeUpdate({ countsTowardsBadge: true })).toEqual({
      kind: 'delta',
      delta: 1,
    });
  });

  test('an admission record that does not count plans no update', () => {
    expect(planAdmissionBadgeUpdate({ countsTowardsBadge: false })).toEqual({ kind: 'none' });
  });

  test('recount sites plan the authoritative recompute instruction', () => {
    expect(planBadgeRecompute()).toEqual({ kind: 'recompute' });
  });
});

describe('badge instruction interpretation (chain B3)', () => {
  let db: BunDatabase;
  let repo: SDKMessageRepository;
  let notifySpy: ReturnType<typeof mock<(table: string, scope?: TableChangeScope) => void>>;

  beforeEach(() => {
    db = new BunDatabase(':memory:');
    createSpaceTables(db);
    db.prepare(
      `INSERT INTO sessions
         (id, title, created_at, last_active_at, status, config, metadata, type)
       VALUES (?, ?, ?, ?, 'active', '{}', '{}', 'worker')`
    ).run(SID, SID, NOW, NOW);
    const reactiveDb: ReactiveDatabase = createReactiveDatabase({
      getDatabase: () => db,
    } as never);
    notifySpy = mock((_table: string, _scope?: TableChangeScope) => {});
    reactiveDb.notifyChange = notifySpy;
    repo = new SDKMessageRepository(db, reactiveDb);
  });

  afterEach(() => {
    db.close();
  });

  function badgeOf(sessionId: string = SID): number {
    return (
      db.prepare(`SELECT visible_message_count AS n FROM sessions WHERE id = ?`).get(sessionId) as {
        n: number;
      }
    ).n;
  }

  function sessionsNotified(): Array<string | undefined> {
    const calls = notifySpy.mock.calls as Array<[string, TableChangeScope | undefined]>;
    return calls.filter((call) => call[0] === 'sessions').map((call) => call[1]?.sessionId);
  }

  test('save sites notify sessions exactly when the planned instruction is a delta', () => {
    expect(repo.saveSDKMessage(SID, assistantMessage('a-1'))).toBe(true);
    expect(sessionsNotified()).toEqual([SID]);
    notifySpy.mockClear();

    expect(repo.saveSDKMessage(SID, hiddenSubtypeMessage('thinking_tokens', 'hidden-1'))).toBe(
      true
    );
    expect(sessionsNotified()).toEqual([]);
    notifySpy.mockClear();

    repo.saveUserMessage(SID, userMessage('u-deferred'), 'deferred');
    expect(sessionsNotified()).toEqual([]);
    notifySpy.mockClear();

    repo.saveUserMessage(SID, userMessage('u-consumed'), 'consumed');
    expect(sessionsNotified()).toEqual([SID]);
    notifySpy.mockClear();

    repo.saveHyperNeoActionMessage(SID, actionMessage('act-1'));
    expect(sessionsNotified()).toEqual([SID]);
    expect(badgeOf()).toBe(3);
  });

  test('the status flip notifies a session only when the authoritative count changes', () => {
    const id = repo.saveUserMessageCore(SID, userMessage('u-flip'), 'enqueued').id;
    expect(badgeOf()).toBe(0);

    repo.updateMessageStatus([id], 'consumed');
    expect(badgeOf()).toBe(1);
    expect(sessionsNotified()).toEqual([SID]);
    notifySpy.mockClear();

    repo.updateMessageStatus([id], 'enqueued');
    expect(badgeOf()).toBe(0);
    expect(sessionsNotified()).toEqual([SID]);
    notifySpy.mockClear();

    repo.updateMessageStatus([id], 'deferred');
    expect(badgeOf()).toBe(0);
    expect(sessionsNotified()).toEqual([]);
  });

  test('rewind operators notify only when the recount changes the stored count', () => {
    repo.saveSDKMessage(SID, assistantMessage('r-1'));
    repo.saveSDKMessage(SID, assistantMessage('r-2'));
    expect(badgeOf()).toBe(2);
    notifySpy.mockClear();

    expect(repo.deleteMessagesAfter(SID, Date.now() + 60_000)).toBe(0);
    expect(badgeOf()).toBe(2);
    expect(sessionsNotified()).toEqual([]);
    notifySpy.mockClear();

    const earliest = (
      db.prepare(`SELECT MIN(timestamp) AS t FROM sdk_messages WHERE session_id = ?`).get(SID) as {
        t: string;
      }
    ).t;
    expect(repo.deleteMessagesAtAndAfter(SID, Date.parse(earliest))).toBeGreaterThan(0);
    expect(badgeOf()).toBe(0);
    expect(sessionsNotified()).toEqual([SID]);
  });

  test('deletePendingUserMessage recounts the badge without notifying sessions', () => {
    const id = repo.saveUserMessageCore(SID, userMessage('u-pending'), 'deferred').id;
    db.prepare(`UPDATE sessions SET visible_message_count = 7 WHERE id = ?`).run(SID);
    notifySpy.mockClear();

    const removed = repo.deletePendingUserMessage(SID, id, 'deferred');

    expect(removed?.dbId).toBe(id);
    expect(badgeOf()).toBe(0);
    expect(notifySpy).not.toHaveBeenCalled();
  });

  test('recomputeVisibleMessageCount repairs drift without notifying (script contract)', () => {
    db.prepare(
      `INSERT INTO sdk_messages
         (id, session_id, message_type, message_subtype, sdk_message, timestamp, send_status, parent_tool_use_id)
       VALUES (?, ?, 'assistant', NULL, '{}', ?, 'consumed', NULL)`
    ).run('raw-bypass', SID, NOW);
    expect(badgeOf()).toBe(0);
    notifySpy.mockClear();

    expect(repo.recomputeVisibleMessageCount(SID)).toBe(true);
    expect(badgeOf()).toBe(1);
    expect(repo.recomputeVisibleMessageCount(SID)).toBe(false);
    expect(notifySpy).not.toHaveBeenCalled();
  });
});
