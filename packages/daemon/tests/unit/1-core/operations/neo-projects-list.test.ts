import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createNeoProjectListOperation } from '../../../../src/lib/neo/project-list-operation.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import { createOperationRegistry } from '../../../../src/lib/operations/registry.ts';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository.ts';
import { createTestDb } from '../../../helpers/database.ts';

const human = { source: 'rpc' as const, principal: 'local' as const };

let db: Awaited<ReturnType<typeof createTestDb>>;
let repo: NeoRepository;

const alias = (name: string, projectId: string) =>
  db
    .getDatabase()
    .prepare('INSERT INTO neo_project_workspaces (alias, project_id) VALUES (?, ?)')
    .run(name, projectId);

const list = async () => {
  const registry = createOperationRegistry([createNeoProjectListOperation(repo, () => 'here')]);
  const result = await invokeOperation(registry, 'neo.projects.list', {}, human);
  return result.kind === 'completed' ? result.value : result;
};

beforeEach(async () => {
  db = await createTestDb();
  repo = new NeoRepository(db.getDatabase());
  for (const [id, title] of [
    ['project:read', 'neo-read'],
    ['project:empty', 'empty'],
    ['project:old', 'old'],
  ])
    repo.saveProject({ id, title, summary: '', context: '' }, 0);
  alias('folder:here\u0000/code/neo-read', 'project:read');
  alias('folder:there\u0000/remote/neo-read', 'project:read');
  alias('repository:github.com/lsm/neo-read', 'project:read');
  db.getDatabase()
    .prepare('INSERT INTO neo_project_merges (source_id, target_id, merged_at) VALUES (?, ?, 1)')
    .run('project:old', 'project:read');
});
afterEach(() => db.close());

describe('neo.projects.list', () => {
  test('lists every unmerged project with only its folders on this machine', async () => {
    const result = (await list()) as {
      projects: { id: string; name: string; folders: string[]; homePath: string | null }[];
    };
    const byId = new Map(result.projects.map((project) => [project.id, project]));

    expect([...byId.keys()].sort()).toEqual(['project:empty', 'project:read']);
    expect(byId.get('project:read')).toMatchObject({
      name: 'neo-read',
      folders: ['/code/neo-read'],
      homePath: null,
    });
    expect(byId.get('project:empty')?.folders).toEqual([]);
  });
});
