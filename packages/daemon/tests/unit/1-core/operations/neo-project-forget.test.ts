import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { createNeoProjectForgetOperation } from '../../../../src/lib/neo/project-forget-operation.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository.ts';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';

const atlas = 'project:atlas';
const kept = 'project:kept';
const agentSession = 'session:agent';
const human = { source: 'rpc' as const, principal: 'local' as const };

let db: Awaited<ReturnType<typeof createTestDb>>;
let repo: NeoRepository;

const alias = (name: string, projectId: string) =>
  db
    .getDatabase()
    .prepare('INSERT INTO neo_project_workspaces (alias, project_id) VALUES (?, ?)')
    .run(name, projectId);

const forget = async (projectId: string, caller: OperationCaller = human) => {
  const registry = createOperationRegistry([createNeoProjectForgetOperation(repo)]);
  const result = await invokeOperation(registry, 'neo.project.forget', { projectId }, caller);
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
});
afterEach(() => db.close());

describe('neo.project.forget', () => {
  test('forget admission does not read repositories on the main repository', async () => {
    const main = spyOn(repo, 'allRepositories').mockImplementation(() => {
      throw new Error('forget admission used the main repository');
    });
    try {
      expect(await forget(atlas)).toEqual({ ok: true, repos: ['lsm/neo-atlas'] });
      expect(repo.getProject(atlas)).toBeNull();
    } finally {
      main.mockRestore();
    }
  });

  test('concurrent forget requests admit only one winner', async () => {
    const results = await Promise.all([forget(atlas), forget(atlas)]);
    expect(results.filter((result) => (result as { ok: boolean }).ok)).toHaveLength(1);
    expect(results).toContainEqual({ ok: false, reason: 'project_missing' });
  });

  test('an external callback failure cannot roll back a committed forget', async () => {
    const registry = createOperationRegistry([
      createNeoProjectForgetOperation(repo, () => {
        expect(repo.getProject(atlas)).toBeNull();
        throw new Error('synthetic external effect failure');
      }),
    ]);
    const result = await invokeOperation(
      registry,
      'neo.project.forget',
      { projectId: atlas },
      human
    );
    expect(result).toMatchObject({ kind: 'failed', message: 'synthetic external effect failure' });
    expect(repo.getProject(atlas)).toBeNull();
  });

  test('deletes the project, so its repository leaves the list', async () => {
    expect(repo.allRepositories()).toEqual(['lsm/hyperneo', 'lsm/neo-atlas']);
    expect(await forget(atlas)).toEqual({ ok: true, repos: ['lsm/neo-atlas'] });
    expect(repo.getProject(atlas)).toBeNull();
    expect(repo.allRepositories()).toEqual(['lsm/hyperneo']);
    expect(repo.getProject(kept)?.title).toBe('kept');
  });

  test('refuses an unknown project', async () => {
    expect(await forget('project:nope')).toEqual({ ok: false, reason: 'project_missing' });
  });

  test('refuses an agent session that is not root Neo', async () => {
    const agent: OperationCaller = { source: 'mcp', sessionId: agentSession };
    expect(await forget(atlas, agent)).toEqual({ ok: false, reason: 'root_or_human_only' });
    expect(await forget(atlas, { source: 'mcp', sessionId: 'session:other' })).toEqual({
      ok: false,
      reason: 'root_or_human_only',
    });
    expect(repo.getProject(atlas)?.title).toBe('atlas');
  });

  test('refuses the Inbox and a project a worker is still bound to', async () => {
    repo.saveProject({ id: 'inbox', title: 'Inbox', summary: '', context: '' }, 0);
    expect(await forget('inbox')).toEqual({ ok: false, reason: 'project_protected' });
    expect(repo.getProject('inbox')?.title).toBe('Inbox');
    await db.createSession(createTestSession('session:worker'));
    db.getDatabase()
      .prepare(
        "INSERT INTO neo_session_bindings (session_id, concern_id, kind) VALUES (?, ?, 'worker')"
      )
      .run('session:worker', atlas);
    expect(await forget(atlas)).toEqual({ ok: false, reason: 'project_in_use' });
    expect(repo.getProject(atlas)?.title).toBe('atlas');
  });

  test('an open ask blocks forget; a settled ask moves to the root', async () => {
    const ask = (id: string, status: string) =>
      db
        .getDatabase()
        .prepare(
          `INSERT INTO neo_asks (id, session_id, project_id, title, request, status, created_at, updated_at)
           VALUES (?, 'neo:root', ?, 'Ask', 'Ask', ?, 1, 1)`
        )
        .run(id, atlas, status);
    ask('a-open', 'open');
    expect(await forget(atlas)).toEqual({ ok: false, reason: 'project_in_use' });
    db.getDatabase().prepare("UPDATE neo_asks SET status = 'dropped' WHERE id = 'a-open'").run();
    ask('a-done', 'done');
    expect(await forget(atlas)).toEqual({ ok: true, repos: ['lsm/neo-atlas'] });
    const rows = db
      .getDatabase()
      .prepare("SELECT id, project_id AS projectId FROM neo_asks WHERE id LIKE 'a-%' ORDER BY id")
      .all();
    expect(rows).toEqual([
      { id: 'a-done', projectId: null },
      { id: 'a-open', projectId: null },
    ]);
  });
});
