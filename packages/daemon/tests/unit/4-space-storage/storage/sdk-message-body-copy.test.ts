import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import { migrateSdkMessageBodies } from '../../../../src/storage/sdk-message-body-copy';
import { SDKMessageRepository } from '../../../../src/storage/repositories/sdk-message-repository';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import { Database } from '../../../../src/storage/sqlite-compat';
import { writeSdkMessageBody } from '../../../../src/storage/repositories/sdk-message-body-write';

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
  test('a slow committed chunk pauses in place and completes without re-verifying its backup', async () => {
    const before = hash(),
      logs: string[] = [];
    const verifyBackup = vi.fn(options().verifyBackup);
    vi.useFakeTimers();
    let now = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => (now += 300));
    try {
      const result = migrateSdkMessageBodies(db, {
        ...options(),
        verifyBackup,
        log: (line) => logs.push(line),
      }).then(
        (value) => ({ value }),
        (error) => ({ error })
      );
      await vi.runAllTimersAsync();
      expect(await result).toMatchObject({ value: { status: 'complete' } });
      expect(verifyBackup).toHaveBeenCalledTimes(1);
      expect(logs.some((line) => line.includes('"phase":"slow_chunk_pause"'))).toBe(true);
      expect(hash()).toBe(before);
      expect(pending()).toBe(0);
    } finally {
      clock.mockRestore();
      vi.useRealTimers();
    }
  });

  test('shutdown cancels an in-place slow-chunk pause and keeps committed bodies readable', async () => {
    const before = hash(),
      abort = new AbortController();
    vi.useFakeTimers();
    let now = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => (now += 300));
    try {
      const result = migrateSdkMessageBodies(db, {
        ...options(),
        signal: abort.signal,
        log: (line) => {
          if (line.includes('"phase":"slow_chunk_pause"')) setTimeout(() => abort.abort(), 1);
        },
      }).then(
        (value) => ({ value }),
        (error) => ({ error })
      );
      await vi.runAllTimersAsync();
      expect(await result).toMatchObject({ value: { status: 'cancelled' } });
      expect(pending()).toBe(4);
      expect(hash()).toBe(before);
      expect(vi.getTimerCount()).toBe(0);
      expect(db.prepare('SELECT * FROM sdk_message_body_copy_active').all()).toEqual([]);
    } finally {
      clock.mockRestore();
      vi.useRealTimers();
    }
  });

  test('keeps malformed bytes in full and records NULL derived columns', async () => {
    db.exec('DROP INDEX IF EXISTS idx_sdk_messages_uuid_status');
    db.exec(
      "DELETE FROM sdk_message_bodies WHERE seq=1; UPDATE sdk_messages SET sdk_message='{invalid historical body' WHERE seq=1"
    );
    const before = hash(),
      logs: string[] = [];
    await migrateSdkMessageBodies(db, { ...options(), log: (line) => logs.push(line) });
    expect(hash()).toBe(before);
    expect(logs.some((line) => line.includes('"malformed":1'))).toBe(true);
    expect(
      db
        .prepare('SELECT input_kind,info_level,user_status_eligible FROM sdk_messages WHERE seq=1')
        .get()
    ).toEqual({ input_kind: null, info_level: null, user_status_eligible: null });
  });
  test('preserves authoritative side bytes when the legacy copy disagrees', async () => {
    const before = hash();
    db.exec(
      `UPDATE sdk_messages SET sdk_message='{"type":"user","message":{"content":"stale legacy copy"}}'`
    );
    expect((await migrateSdkMessageBodies(db, options())).status).toBe('complete');
    expect(hash()).toBe(before);
    expect(pending()).toBe(0);
  });

  test('normal writers after a chunk keep the new full body and are not suppressed', async () => {
    const updated = JSON.stringify({
      type: 'user',
      uuid: 'tool-0',
      message: { role: 'user', content: 'new user content' },
    });
    let written = false;
    await migrateSdkMessageBodies(db, {
      ...options(),
      log: (line) => {
        if (written || !line.includes('"phase":"chunk"')) return;
        written = true;
        writeSdkMessageBody(
          db,
          () =>
            db
              .prepare('UPDATE sdk_messages SET sdk_message=? WHERE sdk_uuid=?')
              .run(updated, 'tool-0'),
          'sdk_uuid=?',
          ['tool-0']
        );
      },
    });
    expect(JSON.stringify(repo.getMessageByUuid('s', 'tool-0'))).toBe(updated);
    expect(db.prepare('SELECT * FROM sdk_message_body_copy_active').all()).toEqual([]);
  });

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
      const audit = JSON.parse(logs.find((line) => line.includes('"phase":"complete"'))!);
      expect(audit.beforeHash).toMatch(/^[a-f0-9]{64}$/);
      expect(audit.afterHash).toBe(audit.beforeHash);
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
