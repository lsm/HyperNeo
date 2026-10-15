import { describe, expect, test } from 'bun:test';
import { runMigration339 } from '../../../../src/storage/schema/m339-neo-input-origins';
import { runMigration377 } from '../../../../src/storage/schema/m377-neo-input-origin-trigger';
import { NeoInputOriginRepository } from '../../../../src/storage/repositories/neo-input-origin-repository';
import { Database } from '../../../../src/storage/sqlite-compat';

describe('runMigration339', () => {
  test('creates the input origin stamps once, and the first stamp for an input wins', () => {
    const db = new Database(':memory:');
    const repo = new NeoInputOriginRepository(db);
    expect(repo.get('neo:root', 'note-1')).toBeNull();
    runMigration339(db);
    runMigration339(db);
    runMigration377(db);
    const input = { sessionId: 'neo:root', messageId: 'note-1' };
    repo.record(input, { sessionId: 'neo:root', messageId: 'human-1' }, 1);
    repo.record(input, { sessionId: 'neo:root', messageId: 'human-2' }, 2);
    expect(repo.get('neo:root', 'note-1')).toEqual({ sessionId: 'neo:root', messageId: 'human-1' });
    expect(repo.get('neo:root', 'note-2')).toBeNull();
  });
});

describe('runMigration377', () => {
  test('adds the trigger to each input stamp once, and an input without one reads null', () => {
    const db = new Database(':memory:');
    const repo = new NeoInputOriginRepository(db);
    runMigration377(db);
    runMigration339(db);
    runMigration377(db);
    runMigration377(db);
    const origin = { sessionId: 'neo:root', messageId: 'human-1' };
    repo.record({ sessionId: 'neo:root', messageId: 'note-1' }, origin, 1, 'human:human-1');
    repo.record({ sessionId: 'neo:root', messageId: 'note-2' }, origin, 1);
    expect(repo.trigger('neo:root', 'note-1')).toBe('human:human-1');
    expect(repo.trigger('neo:root', 'note-2')).toBeNull();
    expect(repo.trigger('neo:root', 'note-3')).toBeNull();
  });

  test('backfills the trigger of inputs stamped before the column existed', () => {
    const db = new Database(':memory:');
    runMigration339(db);
    db.exec(
      `CREATE TABLE neo_consultations (id TEXT PRIMARY KEY, origin_session_id TEXT, origin_message_id TEXT)`
    );
    const consult = db.prepare('INSERT INTO neo_consultations VALUES (?, ?, ?)');
    consult.run('c1', 'neo:root', 'human-1');
    consult.run('c2', 'neo:root', 'neo-trigger:outcome:a:x#2');
    consult.run('c3', 'neo:root', 'neo-nudge:human-1');
    consult.run('review', 'neo:root', null);
    const stamp = db.prepare(
      'INSERT INTO neo_input_origins(session_id, message_id, origin_session_id, origin_message_id, stamped_at) VALUES (?, ?, ?, ?, 0)'
    );
    const rows: [string, string, string | null][] = [
      ['neo-trigger:outcome:a:x', 'human-1', 'outcome:a:x'],
      ['neo-trigger:action:a:y#3', 'human-1', 'action:a:y'],
      ['neo-nudge:human-1', 'human-1', 'human:human-1'],
      ['neo-forward:human-1:0', 'human-1', 'human:human-1'],
      ['neo-cross-project:g1:reply', 'human-1', 'human:human-1'],
      ['neo-consult:c1:request', 'human-1', 'human:human-1'],
      ['neo-consult:c1:reply', 'human-1', 'human:human-1'],
      ['neo-consult:c2:reply', 'human-1', 'outcome:a:x'],
      ['neo-consult:c3:request', 'human-1', 'human:human-1'],
      ['neo-consult:review:request', 'human-1', null],
      ['work-1:done-check:0', 'human-1', null],
    ];
    for (const [messageId, origin] of rows) stamp.run('neo:root', messageId, 'neo:root', origin);
    runMigration377(db);
    const repo = new NeoInputOriginRepository(db);
    expect(rows.map(([messageId]) => repo.trigger('neo:root', messageId))).toEqual(
      rows.map(([, , trigger]) => trigger)
    );
  });
});
