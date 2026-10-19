import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createNeoProjectForgetOperation } from '../../../../src/lib/neo/project-forget-operation.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import { createOperationRegistry } from '../../../../src/lib/operations/registry.ts';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository.ts';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';

const atlas = 'project:atlas';
const kept = 'project:kept';
const holder = 'neo:atlas-holder';
const human = { source: 'rpc' as const, principal: 'local' as const };

let db: Awaited<ReturnType<typeof createTestDb>>;
let repo: NeoRepository;

const alias = (name: string, projectId: string) =>
  db
    .getDatabase()
    .prepare('INSERT INTO neo_project_workspaces (alias, project_id) VALUES (?, ?)')
    .run(name, projectId);

const forget = async (projectId: string) => {
  const registry = createOperationRegistry([createNeoProjectForgetOperation(repo)]);
  const result = await invokeOperation(registry, 'neo.project.forget', { projectId }, human);
  return result.kind === 'completed' ? result.value : result;
};

beforeEach(async () => {
  db = await createTestDb();
  repo = new NeoRepository(db.getDatabase());
  repo.saveProject({ id: atlas, title: 'atlas', summary: '', context: '' }, 0);
  repo.saveProject({ id: kept, title: 'kept', summary: '', context: '' }, 0);
  alias('repo:lsm/neo-atlas\u0000', atlas);
  alias('repository:github.com/lsm/neo-atlas', atlas);
  alias('repository:github.com/lsm/hyperneo', kept);
  db.createSession(createTestSession(holder));
  repo.reserveBinding({ sessionId: holder, kind: 'project', projectId: atlas });
});
afterEach(() => db.close());

describe('neo.project.forget', () => {
  test('deletes the project and unbinds its holder, so its repository leaves the list', async () => {
    expect(repo.allRepositories()).toEqual(['lsm/hyperneo', 'lsm/neo-atlas']);
    expect(await forget(atlas)).toEqual({ ok: true, repos: ['lsm/neo-atlas'] });
    expect(repo.getProject(atlas)).toBeNull();
    expect(repo.getBindingForProject(atlas)).toBeNull();
    expect(repo.allRepositories()).toEqual(['lsm/hyperneo']);
    expect(repo.getProject(kept)?.title).toBe('kept');
    expect(db.getSession(holder)?.id).toBe(holder);
  });

  test('refuses a project that still has a card, and an unknown project', async () => {
    db.getDatabase()
      .prepare(
        `INSERT INTO neo_work (id, request_key, origin_session_id, concern_id, title, instruction,
           status, created_at, updated_at)
         VALUES ('w1', 'k1', 'neo:root', ?, 'Card', 'Do it', 'cancelled', 1, 1)`
      )
      .run(atlas);
    expect(await forget(atlas)).toEqual({ ok: false, reason: 'in_use' });
    expect(repo.getProject(atlas)?.title).toBe('atlas');
    expect(await forget('project:nope')).toEqual({ ok: false, reason: 'missing' });
    expect(repo.getBindingForProject(atlas)?.sessionId).toBe(holder);
  });
});
