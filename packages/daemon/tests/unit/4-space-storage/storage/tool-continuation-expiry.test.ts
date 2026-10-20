import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from '../../../../src/storage/sqlite-compat';
import { ToolContinuationRecoveryRepository } from '../../../../src/storage/repositories/tool-continuation-recovery-repository';

let db: Database;
let writer: Database;
let repo: ToolContinuationRecoveryRepository;
let run: string;
beforeEach(() => {
  run = mkdtempSync(join(tmpdir(), 'continuation-expiry-'));
  const path = join(run, 'synthetic.db');
  db = new Database(path);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1');
  repo = new ToolContinuationRecoveryRepository(db);
  repo.ensureSchema();
  writer = new Database(path);
});
afterEach(() => {
  writer.close();
  db.close();
  rmSync(run, { recursive: true, force: true });
});

function mapping(id: string, status: string, expires: number, reason: string | null = null) {
  db.prepare(`INSERT INTO tool_continuation_recovery
    (tool_use_id,session_id,status,created_at,updated_at,expires_at,recovery_reason)
    VALUES (?,'s',?,1,2,?,?)`).run(id, status, expires, reason);
}

function inbox(id: string, status: string, expires: number, reason: string | null = null) {
  db.prepare(`INSERT INTO tool_continuation_inbox
    (id,tool_use_id,session_id,status,request_json,created_at,updated_at,expires_at,recovery_reason)
    VALUES (?,?,'s',?,?,1,2,?,?)`).run(
    id,
    id,
    status,
    '完整工具结果'.repeat(10000),
    expires,
    reason
  );
}

describe('ToolContinuationRecoveryRepository expiry', () => {
  test('an empty expiry sweep completes while an unrelated connection holds the writer lock', () => {
    db.transaction(() => {
      for (let i = 0; i < 22269; i++) mapping(`consumed-${i}`, 'consumed', 0);
      for (let i = 0; i < 18; i++) mapping(`expired-${i}`, 'expired', 0);
      mapping('active-future', 'active', 101);
      mapping('waiting-boundary', 'waiting_rebind', 100);
      inbox('pending-future', 'pending', 100);
    })();
    writer.exec('BEGIN IMMEDIATE');
    try {
      expect(repo.markExpired(100)).toBe(0);
    } finally {
      writer.exec('ROLLBACK');
    }
    expect(repo.getToolUse('active-future')?.status).toBe('active');
    expect(repo.getToolUse('waiting-boundary')?.status).toBe('waiting_rebind');
  });

  test('expires only past-due eligible records, retains reasons and full requests, and counts only mappings', () => {
    for (const [id, status, expires, reason] of [
      ['active', 'active', 99, null],
      ['waiting', 'waiting_rebind', 99, 'existing'],
      ['empty-reason', 'active', 99, ''],
      ['boundary', 'active', 100, null],
      ['future', 'waiting_rebind', 101, null],
      ...['consumed', 'failed', 'expired', 'rebound'].map((status) => [status, status, 0, null]),
    ] as [string, string, number, string | null][])
      mapping(id, status, expires, reason);
    for (const status of ['pending', 'rebound', 'failed', 'expired']) inbox(status, status, 99);
    inbox('boundary', 'pending', 100);
    inbox('with-reason', 'pending', 99, 'original reason');
    const before = db.prepare('SELECT * FROM tool_continuation_inbox ORDER BY id').all() as Record<
      string,
      unknown
    >[];
    expect(repo.markExpired(100)).toBe(3);
    expect(repo.getToolUse('active')).toMatchObject({
      status: 'expired',
      recoveryReason: 'TTL expired',
      updatedAt: 100,
      expiresAt: 99,
    });
    expect(repo.getToolUse('waiting')?.recoveryReason).toBe('existing');
    expect(repo.getToolUse('empty-reason')?.recoveryReason).toBe('');
    for (const id of ['boundary', 'future', 'consumed', 'failed', 'expired', 'rebound'])
      expect(repo.getToolUse(id)?.updatedAt).toBe(2);
    const after = db.prepare('SELECT * FROM tool_continuation_inbox ORDER BY id').all() as Record<
      string,
      unknown
    >[];
    expect(after).toEqual(
      before.map((row) =>
        row.status === 'pending' && Number(row.expires_at) < 100
          ? {
              ...row,
              status: 'expired',
              updated_at: 100,
              recovery_reason: row.recovery_reason ?? 'TTL expired',
            }
          : row
      )
    );
    expect(repo.markExpired(100)).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM tool_continuation_recovery').get()).toEqual({
      n: 9,
    });
  });
});
