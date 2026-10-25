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
});
