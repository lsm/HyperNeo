import { expect, test } from 'bun:test';
import { createFindWorkOperation } from '../../../../src/lib/drivers/find-operation';
import { mirrorNeoWorkspaceProjects } from '../../../../src/lib/neo/project-mirror';
import { invokeOperation } from '../../../../src/lib/operations/invoke';
import { createOperationRegistry } from '../../../../src/lib/operations/registry';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository';
import { createTestDb } from '../../../helpers/database';

test('work.find replies only after the discovered project has been mirrored', async () => {
  const db = await createTestDb();
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
            work: [],
          },
        ],
      },
    ],
    remote: { list: () => [], invoke: async () => null },
    mirrorProjects: (groups) => {
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
});
