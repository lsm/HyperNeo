import { expect, spyOn, test } from 'bun:test';
import { createNeoProjectTreeOperations } from '../../../../src/lib/neo/packs/coding/project-tree-operations.ts';
import { createOperationRegistry } from '../../../../src/lib/operations/registry.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository.ts';
import { createNeoTables } from '../../../../src/storage/schema/neo.ts';
import { runMigration361 } from '../../../../src/storage/schema/m361-neo-project-avatars.ts';
import { bindGateway, DbGateway } from '../../../../src/storage/db-gateway/db-gateway.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

for (const readOnly of [false, true]) {
  test(`project move reads and updates the bound writer with ${readOnly ? 'read-only' : 'guarded'} main`, async () => {
    const main = new Database(':memory:'),
      writer = new Database(':memory:');
    for (const db of [main, writer]) {
      db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY)');
      createNeoTables(db);
      runMigration361(db);
    }
    const stored = new NeoRepository(writer);
    for (const id of ['a', 'b', 'child'])
      stored.saveProject(
        { id, title: id, summary: 'Retained summary.', context: 'Retained context.' },
        0
      );
    const gateway = new DbGateway(':memory:', writer);
    bindGateway(main, gateway);
    const prepare = main.prepare.bind(main);
    const fault = readOnly
      ? null
      : spyOn(main, 'prepare').mockImplementation(((sql: string) => {
          if (/neo_concerns|neo_project_workspaces/.test(sql))
            throw new Error('Project move SQL on main');
          return prepare(sql);
        }) as typeof main.prepare);
    if (readOnly) main.exec('PRAGMA query_only=ON');
    let notified = 0;
    const repo = new NeoRepository(main, () => {
      expect(stored.getProject('child')?.revision).toBe(2);
      notified++;
    });
    const registry = createOperationRegistry(
      createNeoProjectTreeOperations(repo, async () => {
        throw new Error('Project move must not read GitHub');
      })
    );
    const move = (parentId: string) =>
      invokeOperation(
        registry,
        'neo.project.move',
        { id: 'child', parentId, expectedRevision: 1 },
        { source: 'rpc', principal: 'local' }
      );
    try {
      const results = await Promise.all([move('a'), move('b')]);
      expect(
        results.filter(
          (result) => result.kind === 'completed' && (result.value as { ok: boolean }).ok
        )
      ).toHaveLength(1);
      expect(results).toContainEqual({
        kind: 'completed',
        value: { ok: false, reason: 'superseded' },
      });
      expect(stored.getProject('child')).toMatchObject({
        revision: 2,
        context: 'Retained context.',
        summary: 'Retained summary.',
      });
      expect(notified).toBe(1);
    } finally {
      fault?.mockRestore();
      await gateway.close();
      main.close();
      writer.close();
    }
  });
}
