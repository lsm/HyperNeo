import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../../../../src/storage/sqlite-compat';
import { runMigration369 } from '../../../../src/storage/schema/m369-neo-input-receipts';
import { NeoWorkDriverTargetRepository } from '../../../../src/storage/repositories/neo-work-driver-target-repository';

describe('NeoWorkDriverTargetRepository input receipt storage', () => {
  test('migrates legacy anchors and restores ref-scoped receipts across database reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'neo-receipt-'));
    const file = join(dir, 'receipt.db');
    let db = new Database(file);
    const ref = { adapter: 'space', id: 'task', daemon: 'remote' };
    const anchor = { inputBefore: 10, opening: 'Continue' };
    const receipt = { executionId: 'worker', inputId: 'input' };
    try {
      runMigration369(db);
      db.exec(`CREATE TABLE neo_work_driver_targets (
        work_id TEXT PRIMARY KEY, ref TEXT, input_before INTEGER, sent_opening TEXT,
        started_at INTEGER, link TEXT, actual_model TEXT, actual_effort TEXT)`);
      db.prepare(`INSERT INTO neo_work_driver_targets(work_id, ref, input_before, sent_opening)
        VALUES ('work', ?, 10, 'Continue')`).run(JSON.stringify(ref));
      runMigration369(db);
      runMigration369(db);
      let repo = new NeoWorkDriverTargetRepository(db);
      expect(repo.readSent('work')).toEqual(anchor);
      repo.recordSent('work', { ...anchor, receipt });
      db.close();
      db = new Database(file);
      repo = new NeoWorkDriverTargetRepository(db);
      expect(repo.readSent('work')).toEqual({ ...anchor, receipt });
      repo.recordRef('work', ref);
      expect(repo.readSent('work')?.receipt).toEqual(receipt);
      repo.recordRef('work', { ...ref, daemon: 'another' });
      expect(repo.readSent('work')).toEqual(anchor);
      repo.recordRef('work', ref);
      expect(repo.readSent('work')).toEqual(anchor);
      repo.recordSent('work', { ...anchor, receipt: { ...receipt, inputId: 'next' } });
      expect(repo.readSent('work')?.receipt?.inputId).toBe('next');
      repo.recordSent('work', anchor);
      expect(repo.readSent('work')).toEqual(anchor);
      repo.recordSent('work', { ...anchor, receipt });
      repo.recordSent('work', null);
      expect(repo.readSent('work')).toBeNull();
      expect(repo.readSent('missing')).toBeNull();
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.each([
    '{',
    'null',
    JSON.stringify({ ref: 'different', receipt: { executionId: 'e', inputId: 'i' } }),
    JSON.stringify({ ref: 'same', receipt: { executionId: '', inputId: 'i' } }),
    JSON.stringify({ ref: 'same', receipt: { executionId: 'e' } }),
  ])('ignores malformed or mismatched receipt %s without losing the anchor', (raw) => {
    const db = new Database(':memory:');
    try {
      db.exec(`CREATE TABLE neo_work_driver_targets (
        work_id TEXT PRIMARY KEY, ref TEXT, input_before INTEGER, sent_opening TEXT)`);
      runMigration369(db);
      db.prepare(
        `INSERT INTO neo_work_driver_targets VALUES ('work', 'same', 10, 'Continue', ?)`
      ).run(raw);
      expect(new NeoWorkDriverTargetRepository(db).readSent('work')).toEqual({
        inputBefore: 10,
        opening: 'Continue',
      });
    } finally {
      db.close();
    }
  });
});
