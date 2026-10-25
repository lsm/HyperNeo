import { describe, expect, test } from 'bun:test';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository.ts';
import { createTestDb } from '../../../helpers/database.ts';

describe('Neo Home reservation command', () => {
  test('rolls back every reserved path if one project fails', async () => {
    const db = await createTestDb();
    try {
      let notifications = 0;
      const repo = new NeoRepository(db.getDatabase(), () => {
        notifications++;
      });
      for (const id of ['first', 'second'])
        repo.saveProject({ id, title: id, summary: '', context: '' }, 0);
      notifications = 0;
      db.getDatabase().exec(`CREATE TRIGGER reject_home BEFORE UPDATE OF home_path ON neo_concerns
        WHEN NEW.id = 'second' BEGIN SELECT RAISE(ABORT, 'synthetic reservation failure'); END`);
      await expect(repo.reserveHomeProjects()).rejects.toThrow('synthetic reservation failure');
      expect(notifications).toBe(0);
      expect(repo.getProject('first')?.homePath).toBeNull();
      expect(repo.getProject('second')?.homePath).toBeNull();
      db.getDatabase().exec('DROP TRIGGER reject_home');
      const [left, right] = await Promise.all([
        repo.reserveHomeProjects(),
        repo.reserveHomeProjects(),
      ]);
      expect(left).toEqual(right);
      expect(notifications).toBe(1);
      expect(new Set(left.map((project) => project.homePath)).size).toBe(2);
    } finally {
      await db.close();
    }
  });
});
