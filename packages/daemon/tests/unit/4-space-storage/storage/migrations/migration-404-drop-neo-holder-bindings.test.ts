import { describe, expect, test } from 'bun:test';
import { createTestDb } from '../../../../helpers/database.ts';
import { NeoRepository } from '../../../../../src/storage/repositories/neo-repository.ts';
import { runMigration404 } from '../../../../../src/storage/schema/m404-drop-neo-holder-bindings.ts';

describe('runMigration404', () => {
  test('deletes holder bindings and keeps root, workers, projects and their aliases', async () => {
    const test = await createTestDb();
    try {
      const db = test.getDatabase();
      const repo = new NeoRepository(db);
      repo.saveProject({ id: 'web', title: 'Web', summary: '', context: 'Notes' }, 0);
      repo.reserveBinding({ sessionId: 'neo:root', projectId: null, kind: 'neo' });
      repo.reserveBinding({ sessionId: 'worker', projectId: 'web', kind: 'worker' });
      db.exec(`INSERT INTO neo_session_bindings (session_id, concern_id, kind)
          VALUES ('neo:holder:web', 'web', 'project')`);
      db.prepare('INSERT INTO neo_project_workspaces (alias, project_id) VALUES (?, ?)').run(
        'repo:lsm/web\u0000web',
        'web'
      );
      runMigration404(db);
      runMigration404(db);
      expect(
        db.prepare('SELECT session_id, kind FROM neo_session_bindings ORDER BY session_id').all()
      ).toEqual([
        { session_id: 'neo:root', kind: 'neo' },
        { session_id: 'worker', kind: 'worker' },
      ]);
      expect(repo.getProject('web')?.context).toBe('Notes');
      expect(repo.allRepositories()).toEqual(['lsm/web']);
    } finally {
      test.close();
    }
  });
});
