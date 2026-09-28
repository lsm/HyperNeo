import { describe, expect, test } from 'bun:test';
import { Database } from '../../../../../src/storage/sqlite-compat.ts';
import { createNeoTables } from '../../../../../src/storage/schema/neo.ts';
import { runMigration283 } from '../../../../../src/storage/schema/m283-neo-work-origins.ts';
import { NeoRepository } from '../../../../../src/storage/repositories/neo-repository.ts';

describe('migration 283 and work origins', () => {
  test('preserves old work and persists actual origins across reservations and CAS transitions', () => {
    const db = new Database(':memory:');
    try {
      createNeoTables(db);
      db.exec(`INSERT INTO neo_work
        (id, request_key, concern_id, origin_session_id, title, instruction, session_id, status, report, created_at, updated_at)
        VALUES ('legacy', 'legacy', NULL, 'root', 'Old work', 'Old brief', 'worker', 'reported', 'Old report', 1, 2)`);
      runMigration283(db);
      runMigration283(db);
      const repo = new NeoRepository(db);
      expect(repo.getWork('legacy')).toMatchObject({
        originMessageId: null,
        report: 'Old report',
        status: 'reported',
        createdAt: 1,
        updatedAt: 2,
      });
      const input = {
        id: 'new',
        requestKey: 'new',
        concernId: null,
        originSessionId: 'root',
        originMessageId: 'ask-A',
        title: 'New work',
        instruction: 'New brief',
      };
      const original = repo.proposeWork(input);
      expect(original).toMatchObject({ ...input, status: 'proposed' });
      expect(repo.proposeWork({ ...input, id: 'retry', originMessageId: 'ask-B' })).toEqual(
        original
      );
      const queued = repo.transitionWork(original.id, original, {
        status: 'queued',
        sessionId: 'worker',
      })!;
      expect(queued.originMessageId).toBe('ask-A');
      const returned = repo.transitionWork(queued.id, queued, {
        status: 'reported',
        report: 'Response',
      })!;
      expect(returned.originMessageId).toBe('ask-A');
      const reopened = new NeoRepository(db);
      expect(reopened.findWorkBySession('worker')).toEqual(returned);
      expect(reopened.listWork(null)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'legacy', originMessageId: null }),
          returned,
        ])
      );
      expect(
        reopened.proposeWork({
          ...input,
          id: 'manual',
          requestKey: 'manual',
          originMessageId: undefined,
        }).originMessageId
      ).toBeNull();
    } finally {
      db.close();
    }
  });
  test('does not create a missing Neo subsystem', () => {
    const db = new Database(':memory:');
    try {
      runMigration283(db);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'neo_work'").get()).toBeNull();
    } finally {
      db.close();
    }
  });
});
