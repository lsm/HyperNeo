import { describe, expect, test } from 'bun:test';
import { Database } from '../../../../../src/storage/sqlite-compat.ts';
import { runMigration385 } from '../../../../../src/storage/schema/m385-hyperneo-driver-ids.ts';

describe('runMigration385', () => {
  test('migrates pending targets, refs and receipts without changing unrelated card data', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`CREATE TABLE neo_work_driver_targets(work_id TEXT, target TEXT, ref TEXT, sent_receipt TEXT);
        CREATE TABLE neo_work_refusals(work_id TEXT, ref TEXT, what TEXT)`);
      for (const [oldId, newId] of [
        ['hyperneo', 'hyperneo-sessions'],
        ['space', 'hyperneo-spaces'],
        ['codex-desktop', 'codex-desktop'],
      ]) {
        const ref = { adapter: oldId, daemon: 'remote', id: 'session' };
        const receipt = { executionId: 'execution', inputId: 'input' };
        const serialized = JSON.stringify(ref);
        const target = { verb: 'send', ref, message: 'hyperneo space' };
        db.prepare('INSERT INTO neo_work_driver_targets VALUES (?, ?, ?, ?)').run(
          oldId,
          JSON.stringify(target),
          serialized,
          JSON.stringify({ ref: serialized, receipt })
        );
        db.prepare('INSERT INTO neo_work_driver_targets VALUES (?, ?, NULL, NULL)').run(
          `${oldId}-start`,
          JSON.stringify({ verb: 'start', adapter: oldId, place: { spaceId: 'space' } })
        );
        db.prepare('INSERT INTO neo_work_refusals VALUES (?, ?, ?)').run(
          oldId,
          serialized,
          'space'
        );
        runMigration385(db);
        runMigration385(db);
        const row = db
          .prepare('SELECT * FROM neo_work_driver_targets WHERE work_id = ?')
          .get(oldId) as {
          target: string;
          ref: string;
          sent_receipt: string;
        };
        const migratedRef = { ...ref, adapter: newId };
        expect(JSON.parse(row.ref)).toEqual(migratedRef);
        expect(JSON.parse(row.target)).toEqual({ ...target, ref: migratedRef });
        expect(JSON.parse(row.sent_receipt)).toEqual({ ref: row.ref, receipt });
        const start = db
          .prepare('SELECT target FROM neo_work_driver_targets WHERE work_id = ?')
          .get(`${oldId}-start`) as { target: string };
        expect(JSON.parse(start.target)).toEqual({
          verb: 'start',
          adapter: newId,
          place: { spaceId: 'space' },
        });
        const refusal = db
          .prepare('SELECT ref, what FROM neo_work_refusals WHERE work_id = ?')
          .get(oldId) as { ref: string; what: string };
        expect(JSON.parse(refusal.ref)).toEqual(migratedRef);
        expect(refusal.what).toBe('space');
      }
    } finally {
      db.close();
    }
  });

  test('tolerates absent tables on older empty databases', () => {
    const db = new Database(':memory:');
    try {
      runMigration385(db);
      expect(db.prepare('PRAGMA table_info(neo_work_driver_targets)').all()).toEqual([]);
    } finally {
      db.close();
    }
  });
});
