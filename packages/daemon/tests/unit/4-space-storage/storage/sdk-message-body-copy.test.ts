import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import { migrateSdkMessageBodies } from '../../../../src/storage/sdk-message-body-copy';
import { SDKMessageRepository } from '../../../../src/storage/repositories/sdk-message-repository';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import { Database } from '../../../../src/storage/sqlite-compat';

let db: Database;
let repo: SDKMessageRepository;
beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  db.exec('PRAGMA foreign_keys=OFF');
  repo = new SDKMessageRepository(db);
  for (let n = 0; n < 5; n++)
    repo.saveSDKMessage('s', {
      type: 'user',
      uuid: `tool-${n}`,
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: `t-${n}`, content: '完整结果'.repeat(200000) },
        ],
      },
    } as unknown as SDKMessage);
});
afterEach(() => db.close());

function hash() {
  const digest = createHash('sha256');
  for (const row of db
    .prepare(`SELECT COALESCE(b.sdk_message,m.sdk_message) AS body
    FROM sdk_messages m LEFT JOIN sdk_message_bodies b ON b.seq=m.seq ORDER BY m.seq`)
    .all() as { body: string }[])
    digest.update(row.body);
  return digest.digest('hex');
}
function pending() {
  return (
    db.prepare("SELECT COUNT(*) AS n FROM sdk_messages WHERE sdk_message<>''").get() as {
      n: number;
    }
  ).n;
}
function options() {
  return {
    dbBytes: 100,
    freeBytes: 200,
    verifyBackup: async (_mustExist: boolean) => '/verified/backup.db',
    checkpoint: async () => {},
    log: (_progress: string) => {},
    chunkBytes: 1024 * 1024,
  };
}

describe('SDK body live migration', () => {
  test('refuses insufficient or unknown disk without backup or body changes', async () => {
    const before = hash();
    let backups = 0;
    for (const freeBytes of [199, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = await migrateSdkMessageBodies(db, {
        ...options(),
        freeBytes,
        verifyBackup: async () => {
          backups++;
          return '/backup';
        },
      });
      expect(result.status).toBe('refused');
    }
    expect(backups).toBe(0);
    expect(pending()).toBe(5);
    expect(hash()).toBe(before);
  });

  test('backup verification failure leaves every row and body intact', async () => {
    const before = hash();
    await expect(
      migrateSdkMessageBodies(db, {
        ...options(),
        verifyBackup: async () => {
          expect(pending()).toBe(5);
          throw new Error('backup corrupt');
        },
      })
    ).rejects.toThrow('backup corrupt');
    expect(pending()).toBe(5);
    expect(hash()).toBe(before);
  });

  test('copies legacy-only rows, preserves side-first bytes, yields and logs each bounded chunk', async () => {
    db.exec('DELETE FROM sdk_message_bodies WHERE seq%2=0');
    const before = hash();
    const logs: string[] = [];
    let interleaved = false;
    const tick = setTimeout(() => {
      interleaved = true;
    }, 0);
    try {
      const result = await migrateSdkMessageBodies(db, {
        ...options(),
        log: (line) => logs.push(line),
      });
      expect(result.status).toBe('complete');
      expect(interleaved).toBe(true);
      expect(logs.filter((line) => line.includes('"phase":"chunk"'))).toHaveLength(5);
      expect(pending()).toBe(0);
      expect(hash()).toBe(before);
      expect(JSON.stringify(repo.getMessageByUuid('s', 'tool-4'))).toContain(
        '完整结果'.repeat(200000)
      );
      expect(db.prepare("PRAGMA table_xinfo('sdk_messages')").all()).toContainEqual(
        expect.objectContaining({ name: 'sdk_message' })
      );
      expect(db.prepare('SELECT * FROM sdk_message_body_copy_active').all()).toEqual([]);
    } finally {
      clearTimeout(tick);
    }
  });

  test('restart resumes committed progress and requires the original verified backup', async () => {
    const before = hash();
    const abort = new AbortController();
    await migrateSdkMessageBodies(db, {
      ...options(),
      signal: abort.signal,
      log: (line) => {
        if (line.includes('"phase":"chunk"')) abort.abort();
      },
    });
    expect(pending()).toBe(4);
    let resuming = false;
    expect(
      (
        await migrateSdkMessageBodies(db, {
          ...options(),
          verifyBackup: async (mustExist) => {
            resuming = mustExist;
            return '/verified/backup.db';
          },
        })
      ).status
    ).toBe('complete');
    expect(resuming).toBe(true);
    expect(pending()).toBe(0);
    expect(hash()).toBe(before);
    let called = false;
    await migrateSdkMessageBodies(db, {
      ...options(),
      verifyBackup: async () => {
        called = true;
        return '/backup';
      },
    });
    expect(called).toBe(false);
  });

  test('a failed chunk rolls back the blank, side insert and copy suppression together', async () => {
    db.exec(`DELETE FROM sdk_message_bodies;
      CREATE TRIGGER fail_copy BEFORE UPDATE OF sdk_message ON sdk_messages
      WHEN new.sdk_message='' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END`);
    const before = hash();
    await expect(migrateSdkMessageBodies(db, options())).rejects.toThrow('synthetic failure');
    expect(pending()).toBe(5);
    expect(db.prepare('SELECT * FROM sdk_message_bodies').all()).toEqual([]);
    expect(db.prepare('SELECT * FROM sdk_message_body_copy_active').all()).toEqual([]);
    expect(hash()).toBe(before);
  });
});
