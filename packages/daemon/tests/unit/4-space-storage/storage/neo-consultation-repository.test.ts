import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createNeoTables } from '../../../../src/storage/schema/neo.ts';
import { runMigration279 } from '../../../../src/storage/schema/m279-neo-consultations.ts';
import { NeoConsultationRepository } from '../../../../src/storage/repositories/neo-consultation-repository.ts';
import {
  CONSULTATION_EXPIRED,
  CONSULTATION_TIMEOUT_MS,
} from '../../../../src/lib/neo/consultation-policy.ts';

describe('NeoConsultationRepository deadlines', () => {
  test('preserves the original deadline across reopen and never overwrites terminal state', () => {
    const dir = mkdtempSync(join(tmpdir(), 'neo-deadline-'));
    const path = join(dir, 'test.db');
    let db = new Database(path);
    try {
      createNeoTables(db);
      runMigration279(db);
      db.exec(
        "INSERT INTO neo_concerns VALUES ('club', 'Club', 'Sunday', 'Keep this context', 1, 1, 1)"
      );
      let notifications = 0;
      let repo = new NeoConsultationRepository(db, () => {
        notifications++;
      });
      const input = {
        id: 'old',
        requestKey: 'old',
        concernId: 'club',
        originSessionId: 'root',
        sessionId: 'holder',
        question: 'Next?',
      };
      repo.reserve(input);
      expect(repo.expire('old')?.status).toBe('pending');
      db.prepare('UPDATE neo_consultations SET created_at = ? WHERE id = ?').run(
        Date.now() - CONSULTATION_TIMEOUT_MS,
        'old'
      );
      db.close();
      db = new Database(path);
      repo = new NeoConsultationRepository(db, () => {
        notifications++;
      });
      expect(repo.expire('old')).toMatchObject({ status: 'failed', answer: CONSULTATION_EXPIRED });
      expect(repo.finish('old', 'reported', 'Late answer')).toMatchObject({
        status: 'failed',
        answer: CONSULTATION_EXPIRED,
      });
      expect(notifications).toBe(2);
      expect(repo.unsettled()).toHaveLength(1);
      repo.returned('old');
      expect(repo.unsettled()).toHaveLength(0);
      repo.reserve({ ...input, id: 'fresh', requestKey: 'fresh' });
      expect(repo.finish('fresh', 'reported', 'Accepted')).toMatchObject({ status: 'reported' });
      db.prepare('UPDATE neo_consultations SET created_at = 0').run();
      expect(repo.expire('fresh')?.answer).toBe('Accepted');
      expect(db.prepare('SELECT context FROM neo_concerns').get()).toEqual({
        context: 'Keep this context',
      });
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
