import { describe, expect, test } from 'bun:test';
import { Database } from '../../../../../src/storage/sqlite-compat.ts';
import { createNeoTables } from '../../../../../src/storage/schema/neo.ts';
import { runMigration279 } from '../../../../../src/storage/schema/m279-neo-consultations.ts';
import { runMigration282 } from '../../../../../src/storage/schema/m282-neo-consultation-origins.ts';
import { NeoConsultationRepository } from '../../../../../src/storage/repositories/neo-consultation-repository.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('migration 279 and consultation persistence', () => {
  test('preserves existing concerns, survives reopening, and enforces one pending consultation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'neo-consultation-'));
    const path = join(dir, 'test.db');
    let db = new Database(path);
    try {
      createNeoTables(db);
      db.exec(
        "INSERT INTO neo_concerns VALUES ('club', 'Book club', 'Sunday', 'Eight people', 1, 1, 1)"
      );
      runMigration279(db);
      runMigration279(db);
      runMigration282(db);
      let repo = new NeoConsultationRepository(db, () => {});
      const input = {
        id: 'one',
        requestKey: 'request',
        concernId: 'club',
        originSessionId: 'root',
        sessionId: 'holder',
        question: 'What is next?',
      };
      expect(repo.reserve(input)).toMatchObject({ status: 'pending', answer: null });
      expect(repo.reserve({ ...input, id: 'two', requestKey: 'second' })).toBeNull();
      expect(repo.reserve({ ...input, id: 'retry' })?.id).toBe('one');
      db.close();
      db = new Database(path);
      repo = new NeoConsultationRepository(db, () => {});
      expect(repo.get('one')).toMatchObject({ ...input, status: 'pending' });
      expect(repo.finish('one', 'reported', 'Choose a book')).toMatchObject({
        answer: 'Choose a book',
      });
      expect(repo.finish('one', 'failed', 'Stale failure')).toMatchObject({
        status: 'reported',
        answer: 'Choose a book',
      });
      expect(repo.unsettled()).toHaveLength(1);
      repo.returned('one');
      expect(repo.unsettled()).toHaveLength(0);
      expect(repo.reserve({ ...input, id: 'two', requestKey: 'second' })).toMatchObject({
        status: 'pending',
      });
      expect(db.prepare('SELECT context FROM neo_concerns').get()).toEqual({
        context: 'Eight people',
      });
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
