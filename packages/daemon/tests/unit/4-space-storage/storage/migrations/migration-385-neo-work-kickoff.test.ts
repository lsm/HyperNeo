import { afterEach, describe, expect, test } from 'bun:test';
import { vi } from 'vitest';
import { Database } from '../../../../../src/storage/sqlite-compat.ts';
import { runMigration385 } from '../../../../../src/storage/schema/m385-neo-work-kickoff.ts';
import { NeoRepository } from '../../../../../src/storage/repositories/neo-repository.ts';
import { createTestDb } from '../../../../helpers/database.ts';

afterEach(() => vi.restoreAllMocks());

describe('runMigration385', () => {
  test('rolls back the kickoff column if resetting stale outcomes fails, then retries', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`CREATE TABLE neo_work(id TEXT);
        CREATE TABLE neo_asks(id TEXT, status TEXT, pack TEXT);
        CREATE TABLE neo_ask_items(ask_id TEXT, check_kind TEXT, state TEXT, met_by TEXT,
          evidence TEXT, verified_definition_hash TEXT, watch TEXT);
        INSERT INTO neo_asks VALUES ('active', 'open', 'coding');
        INSERT INTO neo_ask_items VALUES
          ('active', 'coding.pr_merged', 'met', 'daemon', 'old proof', 'old hash', NULL);
        CREATE TRIGGER interrupt_reset BEFORE UPDATE ON neo_ask_items
          BEGIN SELECT RAISE(ABORT, 'interrupted reset'); END`);
      expect(() => runMigration385(db)).toThrow('interrupted reset');
      expect(db.prepare('PRAGMA table_info(neo_work)').all()).not.toContainEqual(
        expect.objectContaining({ name: 'started_at' })
      );
      expect(db.prepare('SELECT state FROM neo_ask_items').get()).toEqual({ state: 'met' });
      db.exec('DROP TRIGGER interrupt_reset');
      runMigration385(db);
      expect(db.prepare('PRAGMA table_info(neo_work)').all()).toContainEqual(
        expect.objectContaining({ name: 'started_at' })
      );
      expect(db.prepare('SELECT state FROM neo_ask_items').get()).toEqual({ state: 'pending' });
    } finally {
      db.close();
    }
  });

  test('allows a fresh database and rechecks only active merge outcomes once', () => {
    const db = new Database(':memory:');
    try {
      runMigration385(db);
      db.exec(`CREATE TABLE neo_work(id TEXT);
        CREATE TABLE neo_asks(id TEXT, status TEXT, pack TEXT);
        CREATE TABLE neo_ask_items(ask_id TEXT, check_kind TEXT, state TEXT, met_by TEXT,
          evidence TEXT, verified_definition_hash TEXT, watch TEXT);
        INSERT INTO neo_asks VALUES ('active', 'open', 'coding'), ('done', 'achieved', 'coding'), ('human', 'open', 'coding');
        INSERT INTO neo_ask_items VALUES
          ('active', 'coding.pr_merged', 'met', 'daemon', 'old proof', 'old hash', NULL),
          ('active', 'life-admin.confirmed', 'met', 'human', 'words', 'hash', NULL),
          ('human', 'coding.pr_merged', 'met', 'human', 'Confirmed by the human', 'hash', NULL),
          ('done', 'coding.pr_merged', 'met', 'daemon', 'old proof', 'old hash', NULL),
          ('active', NULL, 'met', 'daemon', 'old watch', 'old hash', '["https://github.com/lsm/HyperNeo/pull/1"]')`);
      runMigration385(db);
      expect(
        db
          .prepare(
            'SELECT state, met_by, evidence, verified_definition_hash FROM neo_ask_items WHERE ask_id = ? AND check_kind = ?'
          )
          .get('active', 'coding.pr_merged')
      ).toEqual({
        state: 'pending',
        met_by: null,
        evidence: null,
        verified_definition_hash: null,
      });
      expect(
        db
          .prepare("SELECT state FROM neo_ask_items WHERE check_kind = 'life-admin.confirmed'")
          .get()
      ).toEqual({ state: 'met' });
      expect(
        db.prepare("SELECT state, evidence FROM neo_ask_items WHERE ask_id = 'human'").get()
      ).toEqual({
        state: 'met',
        evidence: 'Confirmed by the human',
      });
      expect(db.prepare("SELECT state FROM neo_ask_items WHERE ask_id = 'done'").get()).toEqual({
        state: 'met',
      });
      expect(db.prepare('SELECT state FROM neo_ask_items WHERE check_kind IS NULL').get()).toEqual({
        state: 'pending',
      });
      db.exec("UPDATE neo_ask_items SET state = 'met' WHERE ask_id = 'active'");
      runMigration385(db);
      expect(
        db
          .prepare(
            "SELECT state FROM neo_ask_items WHERE ask_id = 'active' AND check_kind = 'coding.pr_merged'"
          )
          .get()
      ).toEqual({ state: 'met' });
    } finally {
      db.close();
    }
  });
});

describe('NeoRepository.workStartedAt', () => {
  test('uses legacy driver admission or the exact native handoff receipt, never proposal time', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`CREATE TABLE neo_work(id TEXT, started_at INTEGER, session_id TEXT);
        CREATE TABLE neo_work_driver_targets(work_id TEXT, claimed_at INTEGER, started_at INTEGER);
        CREATE TABLE sdk_messages(session_id TEXT, sdk_message TEXT, timestamp TEXT);
        INSERT INTO neo_work VALUES ('driver', NULL, NULL), ('native', NULL, 'worker'), ('unknown', NULL, NULL);
        INSERT INTO neo_work_driver_targets VALUES ('driver', 2000, 1000), ('unknown', NULL, 1000);
        INSERT INTO sdk_messages VALUES ('worker', '{"uuid":"other"}', '2026-10-16T12:00:00.000Z'),
          ('worker', '{"uuid":"native"}', '2026-10-16T12:00:01.123Z')`);
      const repo = new NeoRepository(db);
      expect(repo.workStartedAt('driver')).toBe(2000);
      expect(repo.workStartedAt('native')).toBe(Date.parse('2026-10-16T12:00:01.123Z'));
      expect(repo.workStartedAt('unknown')).toBeNull();
      expect(repo.workStartedAt('absent')).toBeNull();
    } finally {
      db.close();
    }
  });

  test('records the first successful kickoff, preserving it through reports and retries', async () => {
    const db = await createTestDb();
    try {
      const repo = new NeoRepository(db.getDatabase());
      const work = repo.proposeWork({
        id: 'w',
        requestKey: 'w',
        projectId: null,
        originSessionId: 'root',
        title: '实现会话归属控制',
        instruction: '按原需求执行',
      });
      expect(repo.workStartedAt(work.id)).toBeNull();
      const clock = vi.spyOn(Date, 'now').mockReturnValue(2_000);
      const queued = repo.transitionWork(work.id, work, { status: 'queued' })!;
      expect(repo.workStartedAt(work.id)).toBe(2_000);
      clock.mockReturnValue(3_000);
      const reported = repo.transitionWork(work.id, queued, {
        status: 'reported',
        report: 'Done',
      })!;
      clock.mockReturnValue(4_000);
      expect(repo.transitionWork(work.id, work, { status: 'queued' })).toBeNull();
      expect(repo.workStartedAt(work.id)).toBe(2_000);
      repo.transitionWork(work.id, reported, { status: 'queued' });
      expect(repo.workStartedAt(work.id)).toBe(2_000);
      expect(repo.getWork(work.id)?.title).toBe('实现会话归属控制');
    } finally {
      db.close();
    }
  });
});
