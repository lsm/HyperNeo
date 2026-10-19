import { describe, expect, test } from 'bun:test';
import { createTestDb } from '../../../../helpers/database.ts';
import { NeoWorkPrRepository } from '../../../../../src/lib/neo/packs/coding/neo-work-pr-repository.ts';
import { NeoRepository } from '../../../../../src/storage/repositories/neo-repository.ts';
import { runMigration365 } from '../../../../../src/storage/schema/m365-neo-cross-project-dispatch.ts';
import { runMigration392 } from '../../../../../src/storage/schema/m392-neo-todo-pr-refs.ts';
import { runMigration402 } from '../../../../../src/storage/schema/m402-drop-neo-pr-refs.ts';

const names = [
  'neo_route_pr_refs',
  'neo_todo_pr_refs',
  'neo_route_pr_insert',
  'neo_route_pr_update',
  'neo_route_pr_delete',
];

describe('runMigration402', () => {
  test('drops the PR reference tables and triggers, PR writes keep working, and it reruns', async () => {
    const test = await createTestDb();
    try {
      const db = test.getDatabase();
      const present = () =>
        db
          .prepare(
            `SELECT name FROM sqlite_master WHERE name IN (${names.map(() => '?').join(', ')})`
          )
          .all(...names);
      expect(present()).toEqual([]);
      runMigration365(db);
      runMigration392(db);
      expect(present()).toHaveLength(names.length);
      runMigration402(db);
      runMigration402(db);
      expect(present()).toEqual([]);
      new NeoRepository(db).proposeWork({
        id: 'card',
        requestKey: 'card',
        projectId: null,
        originSessionId: 'root',
        title: 'card',
        instruction: 'card',
      });
      const prs = new NeoWorkPrRepository(db);
      prs.record(
        'card',
        [
          {
            url: 'https://github.com/lsm/HyperNeo/pull/99',
            state: 'OPEN',
            checks: 'none',
            review: 'none',
          },
        ],
        0
      );
      prs.replacePrs('card', []);
    } finally {
      test.close();
    }
  });
});
