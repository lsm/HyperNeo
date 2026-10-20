import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { HyperNeoActionMessage } from '@hyperneo/shared';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import { SDKMessageRepository } from '../../../../src/storage/repositories/sdk-message-repository';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import { runMigration418 } from '../../../../src/storage/schema/m418-sdk-message-bodies';
import { Database } from '../../../../src/storage/sqlite-compat';

let db: Database;
let repo: SDKMessageRepository;
beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  db.exec('PRAGMA foreign_keys=OFF');
  repo = new SDKMessageRepository(db);
});
afterEach(() => db.close());

function user(uuid = crypto.randomUUID()): SDKMessage {
  return {
    type: 'user',
    uuid,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tool', content: '完整结果'.repeat(180000) }],
    },
  } as SDKMessage;
}

function mirrored(id: string): string {
  const row = db
    .prepare(`SELECT m.sdk_message AS original, b.sdk_message AS body
    FROM sdk_messages m LEFT JOIN sdk_message_bodies b ON b.seq=m.seq WHERE m.id=?`)
    .get(id) as { original: string; body: string | null };
  expect(row.body).toBe(row.original);
  return row.original;
}

function saveSdk(message: SDKMessage): string {
  expect(repo.saveSDKMessage('s', message)).toBe(true);
  return (
    db.prepare('SELECT id FROM sdk_messages ORDER BY seq DESC LIMIT 1').get() as { id: string }
  ).id;
}

describe('SDK message body persistence', () => {
  test('schema upgrades are idempotent and never copy, blank or trim existing bodies', () => {
    const message = user();
    const id = repo.saveUserMessage('s', message);
    db.exec('DROP TRIGGER sdk_message_bodies_ad; DROP TABLE sdk_message_bodies');
    runMigration418(db);
    runMigration418(db);
    expect(db.prepare('SELECT COUNT(*) AS n FROM sdk_message_bodies').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT sdk_message FROM sdk_messages WHERE id=?').get(id)).toEqual({
      sdk_message: JSON.stringify(message),
    });
    expect(repo.getSDKMessages('s').messages).toHaveLength(1);
  });

  test('all insertion doors retain the complete body and existing transcript', () => {
    const message = user();
    const ids = [
      saveSdk(message),
      repo.saveUserMessage('s', user()),
      repo.saveUserMessageCore('s', user()).id,
    ];
    for (const id of ids)
      expect(mirrored(id)).toBe(
        JSON.stringify({ ...message, uuid: JSON.parse(mirrored(id)).uuid })
      );
    expect(repo.getSDKMessages('s').messages).toHaveLength(3);
  });

  test('normalization and result recovery updates mirror every matching duplicate', () => {
    const legacy = {
      type: 'user',
      uuid: 'legacy',
      isSynthetic: true,
      message: { role: 'user', content: 'task' },
    } as SDKMessage;
    const legacyId = repo.saveUserMessage('s', legacy, 'enqueued', 'system');
    repo.normalizeDeliveryMessageForMailbox('s', 'legacy');
    expect(JSON.parse(mirrored(legacyId)).inputKind).toBe('task');
    const result = {
      type: 'result',
      uuid: 'result',
      subtype: 'success',
      result: 'ok',
    } as SDKMessage;
    const ids = [saveSdk(result), saveSdk(result)];
    repo.markResultRecoveryIntercepted('s', 'result', true);
    repo.markResultInternalCompactionTurn('s', 'result');
    for (const id of ids)
      expect(JSON.parse(mirrored(id))).toMatchObject({
        recovery_intercepted: 1,
        recovery_billing_terminal: 1,
        internal_compaction_turn: 1,
      });
  });

  test('action updates by id and uuid mirror payloads without changing other sessions', () => {
    const action: HyperNeoActionMessage = {
      type: 'hyperneo_action',
      uuid: 'action',
      session_id: 's',
      action: 'sdk_resume_choice',
      resolved: false,
      timestamp: 1,
    };
    const id = repo.saveHyperNeoActionMessage('s', action);
    const other = repo.saveHyperNeoActionMessage('other', action);
    expect(mirrored(id)).toBe(JSON.stringify(action));
    repo.updateHyperNeoActionMessage(id, { ...action, chosenOption: 'start_fresh' });
    expect(JSON.parse(mirrored(id)).chosenOption).toBe('start_fresh');
    repo.updateHyperNeoActionMessageByUuid('s', 'action', { ...action, resolved: true });
    expect(JSON.parse(mirrored(id)).resolved).toBe(true);
    expect(JSON.parse(mirrored(other)).resolved).toBe(false);
  });

  test('a failed body write rolls back the message and its derived columns', () => {
    const message = user();
    db.exec(
      `CREATE TRIGGER reject_body BEFORE INSERT ON sdk_message_bodies BEGIN SELECT RAISE(ABORT,'body rejected'); END`
    );
    expect(() => repo.saveUserMessageCore('s', message)).toThrow('body rejected');
    expect(db.prepare('SELECT COUNT(*) AS n FROM sdk_messages').get()).toEqual({ n: 0 });
    db.exec('DROP TRIGGER reject_body');
    const result = { type: 'result', uuid: 'r', subtype: 'success' } as SDKMessage;
    const id = saveSdk(result);
    const before = mirrored(id);
    db.exec(
      `CREATE TRIGGER reject_body BEFORE UPDATE ON sdk_message_bodies BEGIN SELECT RAISE(ABORT,'body rejected'); END`
    );
    expect(() => repo.markResultRecoveryIntercepted('s', 'r')).toThrow('body rejected');
    expect(mirrored(id)).toBe(before);
    expect(db.prepare('SELECT recovery_intercepted FROM sdk_messages WHERE id=?').get(id)).toEqual({
      recovery_intercepted: null,
    });
  });

  test('outer rollbacks remove both copies and deletion cannot leave an orphan body', () => {
    expect(() =>
      db.transaction(() => {
        repo.saveUserMessage('s', user());
        throw new Error('outer rollback');
      })()
    ).toThrow('outer rollback');
    expect(db.prepare('SELECT COUNT(*) AS n FROM sdk_message_bodies').get()).toEqual({ n: 0 });
    const id = repo.saveUserMessage('s', user());
    const retained = user();
    const retainedId = repo.saveUserMessage('s', retained);
    mirrored(id);
    db.prepare('DELETE FROM sdk_messages WHERE id=?').run(id);
    expect(db.prepare('SELECT COUNT(*) AS n FROM sdk_message_bodies').get()).toEqual({ n: 1 });
    expect(mirrored(retainedId)).toBe(JSON.stringify(retained));
  });

  test('delivery status updates preserve both full bodies without rewriting the side table', () => {
    const message = user();
    const id = repo.saveUserMessage('s', message, 'enqueued');
    db.exec(
      `CREATE TRIGGER reject_body BEFORE UPDATE ON sdk_message_bodies BEGIN SELECT RAISE(ABORT,'unexpected body write'); END`
    );
    repo.updateMessageStatus([id], 'consumed');
    expect(mirrored(id)).toBe(JSON.stringify(message));
    expect(db.prepare('SELECT send_status FROM sdk_messages WHERE id=?').get(id)).toEqual({
      send_status: 'consumed',
    });
  });
});
