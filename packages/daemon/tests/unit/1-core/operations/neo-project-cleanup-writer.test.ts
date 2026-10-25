import { describe, expect, spyOn, test } from 'bun:test';
import { createNeoProjectCleanupApply } from '../../../../src/lib/neo/project-cleanup-apply.ts';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository.ts';
import { createTestDb } from '../../../helpers/database.ts';

describe('Neo project cleanup writer', () => {
  test('cleanup does not execute its admission through the main repository', async () => {
    const db = await createTestDb();
    const repo = new NeoRepository(db.getDatabase());
    repo.saveProject({ id: 'empty', title: 'Empty', summary: '', context: '' }, 0);
    const main = spyOn(repo, 'deleteEmptyProject').mockImplementation(() => {
      throw new Error('cleanup admission ran on the main repository');
    });
    try {
      await createNeoProjectCleanupApply({ repo })({
        action: 'delete',
        projectId: 'empty',
        title: 'Empty',
      });
      expect(repo.getProject('empty')).toBeNull();
    } finally {
      main.mockRestore();
      await db.close();
    }
  });
  test('late content refuses deletion and a failing delete rolls back aliases without notification', async () => {
    const db = await createTestDb();
    let notifications = 0;
    const repo = new NeoRepository(db.getDatabase(), () => {
      notifications++;
    });
    const step = { action: 'delete' as const, projectId: 'empty', title: 'Empty' };
    try {
      repo.saveProject({ id: 'empty', title: 'Empty', summary: '', context: 'late content' }, 0);
      notifications = 0;
      await expect(repo.applyCleanup(step)).rejects.toThrow('no longer empty');
      expect(repo.getProject('empty')?.context).toBe('late content');
      repo.saveProject({ id: 'empty', title: 'Empty', summary: '', context: '' }, 1);
      db.getDatabase()
        .prepare('INSERT INTO neo_project_workspaces(alias, project_id) VALUES (?, ?)')
        .run('folder:synthetic', 'empty');
      db.getDatabase().exec(`CREATE TRIGGER reject_cleanup BEFORE DELETE ON neo_concerns
        BEGIN SELECT RAISE(ABORT, 'synthetic cleanup failure'); END`);
      notifications = 0;
      await expect(repo.applyCleanup(step)).rejects.toThrow('synthetic cleanup failure');
      expect(repo.getProject('empty')).not.toBeNull();
      expect(repo.workspaceAliases('empty')).toEqual(['folder:synthetic']);
      expect(notifications).toBe(0);
    } finally {
      await db.close();
    }
  });

  test('competing cleanup merges admit one winner and notify after the committed redirect', async () => {
    const db = await createTestDb();
    let notifications = 0;
    const repo = new NeoRepository(db.getDatabase(), () => {
      notifications++;
    });
    try {
      for (const id of ['source', 'target'])
        repo.saveProject({ id, title: id, summary: '', context: id }, 0);
      notifications = 0;
      const step = {
        action: 'merge' as const,
        projectId: 'source',
        title: 'Source',
        targetId: 'target',
      };
      const results = await Promise.allSettled([repo.applyCleanup(step), repo.applyCleanup(step)]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(repo.projectMerges.resolve('source')).toBe('target');
      expect(repo.getProject('target')?.context).toBe('target\n\nsource');
      expect(repo.getProject('target')?.revision).toBe(2);
      expect(notifications).toBe(1);
    } finally {
      await db.close();
    }
  });
});
