import { describe, expect, test } from 'bun:test';
import { Database } from '../../../../../src/storage/sqlite-compat.ts';
import { createNeoTables } from '../../../../../src/storage/schema/neo.ts';
import { runMigration279 } from '../../../../../src/storage/schema/m279-neo-consultations.ts';
import { runMigration280 } from '../../../../../src/storage/schema/m280-neo-context-write-grants.ts';
import { runMigration282 } from '../../../../../src/storage/schema/m282-neo-consultation-origins.ts';
import { runMigration285 } from '../../../../../src/storage/schema/m285-neo-consultation-waiters.ts';
import { NeoConsultationRepository } from '../../../../../src/storage/repositories/neo-consultation-repository.ts';
import { NeoConsultationWaiterRepository } from '../../../../../src/storage/repositories/neo-consultation-waiter-repository.ts';
import {
  getAccessibleTableNames,
  getExcludedTableNames,
} from '../../../../../src/lib/db-query/scope-config.ts';

describe('migration 285 consultation waiters', () => {
  test('is additive and repeatable without touching active receipts or their revision grants', () => {
    const db = new Database(':memory:');
    try {
      db.exec('PRAGMA foreign_keys = ON');
      createNeoTables(db);
      runMigration279(db);
      runMigration282(db);
      runMigration280(db);
      db.exec("INSERT INTO neo_concerns VALUES ('club', 'Club', 'Sunday', 'Recorded', 3, 1, 1)");
      const consultations = new NeoConsultationRepository(db, () => {});
      const active = consultations.reserve({
        id: 'active',
        requestKey: 'active',
        concernId: 'club',
        originSessionId: 'root',
        originMessageId: 'ask-A',
        sessionId: 'holder',
        question: 'Status?',
      });
      const grants = db.prepare('SELECT * FROM neo_context_write_grants').all();
      runMigration285(db);
      const waiters = new NeoConsultationWaiterRepository(db, () => {});
      const queued = waiters.enqueue({
        id: 'correction',
        requestKey: 'correction',
        concernId: 'club',
        originSessionId: 'root',
        originMessageId: 'ask-B',
        sessionId: 'holder',
        question: 'Save the correction',
      });
      runMigration285(db);
      expect(consultations.get('active')).toEqual(active);
      expect(db.prepare('SELECT * FROM neo_context_write_grants').all()).toEqual(grants);
      expect(waiters.get('correction')).toEqual(queued);
      expect(waiters.admitNext('club')).toBeNull();
      expect(() =>
        db.prepare("UPDATE neo_consultation_waiters SET status = 'pending'").run()
      ).toThrow();
      expect(waiters.get('correction')?.status).toBe('queued');
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      const indexes = db.prepare('PRAGMA index_list(neo_consultation_waiters)').all() as {
        name: string;
      }[];
      expect(indexes.some(({ name }) => name === 'idx_neo_consultation_waiters_queued')).toBe(true);
      expect(getExcludedTableNames()).toContain('neo_consultation_waiters');
      for (const scope of ['global', 'room', 'space'] as const)
        expect(getAccessibleTableNames(scope)).not.toContain('neo_consultation_waiters');
    } finally {
      db.close();
    }
  });
});
