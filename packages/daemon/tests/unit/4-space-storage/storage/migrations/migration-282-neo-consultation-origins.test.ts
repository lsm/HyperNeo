import { describe, expect, test } from 'bun:test';
import { Database } from '../../../../../src/storage/sqlite-compat.ts';
import { createNeoTables } from '../../../../../src/storage/schema/neo.ts';
import { runMigration279 } from '../../../../../src/storage/schema/m279-neo-consultations.ts';
import { runMigration282 } from '../../../../../src/storage/schema/m282-neo-consultation-origins.ts';
import { NeoConsultationRepository } from '../../../../../src/storage/repositories/neo-consultation-repository.ts';

describe('migration 282 and consultation origins', () => {
  test('is idempotent, preserves legacy receipts and records new input identities', () => {
    const db = new Database(':memory:');
    try {
      createNeoTables(db);
      runMigration279(db);
      db.exec("INSERT INTO neo_concerns VALUES ('club', 'Club', '', '', 1, 1, 1)");
      db.exec(`INSERT INTO neo_consultations
        (id, request_key, concern_id, origin_session_id, session_id, question, status, answer, created_at)
        VALUES ('legacy', 'legacy', 'club', 'root', 'holder', 'Next?', 'reported', 'Old answer', 1)`);
      runMigration282(db);
      runMigration282(db);
      const repo = new NeoConsultationRepository(db, () => {});
      expect(repo.get('legacy')).toMatchObject({
        status: 'reported',
        answer: 'Old answer',
        originMessageId: null,
      });
      const input = {
        id: 'current',
        requestKey: 'current',
        concernId: 'club',
        originSessionId: 'root',
        originMessageId: 'ask-A',
        sessionId: 'holder',
        question: 'New question',
      };
      const original = repo.reserve(input);
      expect(original).toMatchObject({ ...input, status: 'pending' });
      expect(repo.reserve({ ...input, id: 'retry', originMessageId: 'ask-B' })).toEqual(original);
      const reopened = new NeoConsultationRepository(db, () => {});
      expect(reopened.list()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ originMessageId: 'ask-A' }),
          expect.objectContaining({ originMessageId: null }),
        ])
      );
      expect(reopened.unsettled()).toEqual(
        expect.arrayContaining([expect.objectContaining({ originMessageId: 'ask-A' })])
      );
      expect(reopened.finish('current', 'reported', 'Answer')?.originMessageId).toBe('ask-A');
      reopened.returned('current');
      expect(reopened.get('current')?.originMessageId).toBe('ask-A');
      expect(
        reopened.reserve({
          ...input,
          id: 'internal',
          requestKey: 'internal',
          originMessageId: undefined,
        })
      ).toMatchObject({ originMessageId: null });
    } finally {
      db.close();
    }
  });
  test('does not create a missing Neo subsystem', () => {
    const db = new Database(':memory:');
    try {
      runMigration282(db);
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE name = 'neo_consultations'").get()
      ).toBeNull();
    } finally {
      db.close();
    }
  });
});
