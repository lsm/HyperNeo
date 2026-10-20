import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SDKMessageRepository } from '../../../../src/storage/repositories/sdk-message-repository';
import { createTables, runMigrations } from '../../../../src/storage/schema/index';
import { Database } from '../../../../src/storage/sqlite-compat';

const STALE_STATS = [
  ['idx_sdk_messages_session_uuid', '16937 521 1'],
  ['idx_sdk_messages_send_status_timestamp', '16937 521 521 1'],
  ['idx_sdk_messages_session_timestamp_id', '16937 521 1 1'],
  ['idx_sdk_messages_session_subtype_parent', '16937 521 521 521'],
];

function queuedInputsPlan(db: Database): string[] {
  const plans: string[] = [];
  const prepare = db.prepare.bind(db);
  const repository = new SDKMessageRepository(
    Object.assign(Object.create(db), {
      prepare: (sql: string) => {
        plans.push(
          ...(
            prepare(`EXPLAIN QUERY PLAN ${sql}`).all('big', 'system') as { detail: string }[]
          ).map((row) => row.detail)
        );
        return prepare(sql);
      },
    })
  );
  repository.listQueuedInputs('big');
  return plans;
}

describe('SDKMessageRepository.listQueuedInputs', () => {
  test('reads a long session by status even when planner statistics are stale', () => {
    const dir = mkdtempSync(join(tmpdir(), 'planner-stats-'));
    const path = join(dir, 'd.db');
    const seed = new Database(path);
    runMigrations(seed, () => {});
    createTables(seed);
    seed.exec('PRAGMA foreign_keys = OFF');
    const insert = seed.prepare(
      `INSERT INTO sdk_messages (id, session_id, message_type, sdk_message, timestamp, send_status, sdk_uuid)
       VALUES (?, ?, 'user', '{"inputKind":"system"}', ?, 'consumed', ?)`
    );
    seed.transaction(() => {
      for (let i = 0; i < 4_000; i++) insert.run(`b${i}`, 'big', String(i), `u${i}`);
      for (let i = 0; i < 400; i++) insert.run(`s${i}`, `small-${i}`, String(i), `v${i}`);
    })();
    seed.exec('ANALYZE');
    const stale = seed.prepare(
      "UPDATE sqlite_stat1 SET stat = ? WHERE tbl = 'sdk_messages' AND idx = ?"
    );
    for (const [idx, stat] of STALE_STATS) stale.run(stat, idx);
    seed.close();

    const db = new Database(path);
    expect(queuedInputsPlan(db).join('\n')).toContain('idx_sdk_messages_send_status_timestamp');
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
