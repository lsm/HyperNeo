import { recordStartedWork } from '../../../../src/storage/work-started-sessions';
import { expect, test } from 'bun:test';
import { createFindWorkOperation } from '../../../../src/lib/drivers/find-operation';
import { mirrorNeoWorkspaceProjects } from '../../../../src/lib/neo/project-mirror';
import { mirrorNeoWorkspaceProjectsAsync } from '../../../../src/lib/neo/project-mirror-async';
import { invokeOperation } from '../../../../src/lib/operations/invoke';
import { createOperationRegistry } from '../../../../src/lib/operations/registry';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository';
import { createTestDb } from '../../../helpers/database';

test.each(['delayed', 'memory'])(
  'work.find replies after the discovered project is mirrored using %s storage',
  async (mode) => {
    const db = await createTestDb();
    recordStartedWork(db.getDatabase(), { adapter: 'fixture', id: 'owned' });
    let pending = Promise.resolve();
    const operation = createFindWorkOperation({
      adapters: () => [
        {
          id: 'fixture',
          capabilities: ['find'],
          find: () => [
            {
              place: {
                machine: 'synthetic',
                name: 'Synthetic',
                toolProject: { id: 't', name: 'Synthetic' },
                remotes: ['https://github.com/synthetic/repo.git'],
              },
              lastActivityAt: 1,
              openCount: 0,
              archivedCount: 0,
              adapters: ['fixture'],
              work: [
                {
                  ref: { adapter: 'fixture', id: 'owned' },
                  title: 'Synthetic',
                  status: 'done',
                  lastActivityAt: 1,
                  place: {
                    machine: 'synthetic',
                    name: 'Synthetic',
                    toolProject: { id: 't', name: 'Synthetic' },
                    remotes: ['https://github.com/synthetic/repo.git'],
                  },
                },
              ],
            },
          ],
        },
      ],
      remote: { list: () => [], invoke: async () => null },
      mirrorProjects: (groups) => {
        if (mode === 'memory')
          return mirrorNeoWorkspaceProjectsAsync(db, groups, () => {
            throw new Error('A private memory database must not spawn another connection');
          }).then(() => {});
        pending = new Promise<void>((done) => setTimeout(done, 15)).then(() => {
          mirrorNeoWorkspaceProjects(db.getDatabase(), groups);
        });
        return pending;
      },
    });
    try {
      const outcome = await invokeOperation(
        createOperationRegistry([operation]),
        'work.find',
        { localOnly: true },
        { source: 'rpc', role: 'neo' }
      );
      expect(outcome.kind).toBe('completed');
      expect(new NeoRepository(db.getDatabase()).listProjects()).toMatchObject([
        { title: 'Synthetic' },
      ]);
    } finally {
      await pending;
      db.close();
    }
  }
);
