import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { unlinkSync } from 'node:fs';
import { Database } from '../../../../src/storage/sqlite-compat';
import { SDKMessageRepository } from '../../../../src/storage/repositories/sdk-message-repository';
import type { SDKMessage } from '@hyperneo/shared/sdk';

function user(text: string): SDKMessage {
  return {
    type: 'user',
    uuid: crypto.randomUUID(),
    message: { role: 'user', content: [{ type: 'text', text }] },
  } as unknown as SDKMessage;
}

describe('SDK message writes under a held WAL write lock', () => {
  let dbPath: string;
  let db: Database;
  let repository: SDKMessageRepository;
  let lockHolder: Database;

  beforeEach(() => {
    dbPath = `/tmp/hyperneo-busy-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    db = new Database(dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 50');
    db.exec(`
			CREATE TABLE sdk_messages (
				id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL,
				message_type TEXT NOT NULL,
				message_subtype TEXT,
				sdk_message TEXT NOT NULL,
				timestamp TEXT NOT NULL,
				send_status TEXT,
				origin TEXT DEFAULT NULL,
				is_renderable INTEGER NOT NULL DEFAULT 1,
				is_terminal INTEGER NOT NULL DEFAULT 0,
				conversation_turn_index INTEGER,
				parent_tool_use_id TEXT,
				task_id TEXT,
				sdk_uuid TEXT,
				replacement_metadata_normalized INTEGER NOT NULL DEFAULT 0
			);
			CREATE TABLE sdk_message_replacements (
				source_message_id TEXT NOT NULL,
				session_id TEXT NOT NULL,
				task_id TEXT,
				target_uuid TEXT NOT NULL,
				kind TEXT NOT NULL,
				PRIMARY KEY (source_message_id, target_uuid, kind)
			);
		`);
    repository = new SDKMessageRepository(db as never);
  });

  afterEach(() => {
    try {
      lockHolder?.close();
    } catch {}
    db.close();
    try {
      unlinkSync(dbPath);
      unlinkSync(`${dbPath}-wal`);
      unlinkSync(`${dbPath}-shm`);
    } catch {}
  });

  function holdWriteLock(): Database {
    const holder = new Database(dbPath);
    holder.exec('PRAGMA busy_timeout = 50');
    holder.exec('BEGIN IMMEDIATE');
    lockHolder = holder;
    return holder;
  }

  function savedCount(): number {
    return (db.prepare('SELECT COUNT(*) AS count FROM sdk_messages').get() as { count: number })
      .count;
  }

  it('exhausts retries without throwing when another connection holds the write lock', () => {
    const holder = holdWriteLock();

    const startedAt = Date.now();
    expect(repository.saveSDKMessage('session-busy', user('held'))).toBe(false);
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThan(5000);
    expect(savedCount()).toBe(0);

    holder.exec('ROLLBACK');
    holder.close();
    lockHolder = null as unknown as Database;
  });

  it('saves successfully once the other connection releases the write lock', () => {
    const holder = holdWriteLock();
    expect(repository.saveSDKMessage('session-busy', user('held'))).toBe(false);
    holder.exec('ROLLBACK');
    holder.close();
    lockHolder = null as unknown as Database;

    expect(repository.saveSDKMessage('session-busy', user('recovered'))).toBe(true);
    expect(savedCount()).toBe(1);

    const row = db.prepare('SELECT session_id FROM sdk_messages LIMIT 1').get() as {
      session_id: string;
    };
    expect(row.session_id).toBe('session-busy');
  });

  it('propagates the busy error for user messages after exhausting retries, then recovers', () => {
    const holder = holdWriteLock();

    expect(() => repository.saveUserMessage('session-busy', user('queued'))).toThrow(
      /database is locked/
    );

    holder.exec('ROLLBACK');
    holder.close();
    lockHolder = null as unknown as Database;

    const savedId = repository.saveUserMessage('session-busy', user('queued'));
    expect(typeof savedId).toBe('string');
    expect(savedId.length).toBeGreaterThan(0);
    expect(savedCount()).toBe(1);
  });
});
