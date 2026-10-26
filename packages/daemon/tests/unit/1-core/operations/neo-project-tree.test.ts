import { requireNeoTreeAuthor } from '../../../../src/lib/neo/project-author.ts';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { neoProjectMoveReason, neoProjectPath } from '@hyperneo/shared/types/neo-project-tree';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createNeoTables } from '../../../../src/storage/schema/neo.ts';
import { runMigration361 } from '../../../../src/storage/schema/m361-neo-project-avatars.ts';
import { runMigration368 } from '../../../../src/storage/schema/m368-neo-project-tree.ts';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository.ts';
import {
  createNeoProjectTreeOperations,
  requireNeoEpic,
} from '../../../../src/lib/neo/packs/coding/project-tree-operations.ts';
import type { NeoRefState } from '../../../../src/lib/neo/packs/coding/ask-prs.ts';

const local = { source: 'rpc' as const, principal: 'local' as const };
const epicUrl = 'https://github.com/lsm/hyperneo/issues/6756';
const epic: NeoRefState = {
  url: epicUrl,
  title: 'Neo projects',
  kind: 'issue',
  state: 'OPEN',
  at: null,
  done: false,
  closedBy: null,
};
let db: Database;
let repo: NeoRepository;
const save = (id: string) =>
  repo.saveProject({ id, title: id, summary: id, context: 'retained' }, 0)!;
beforeEach(() => {
  db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY)');
  createNeoTables(db);
  runMigration361(db);
  repo = new NeoRepository(db);
});
afterEach(() => db.close());

function workspace(id: string) {
  db.prepare('INSERT INTO neo_project_workspaces (alias, project_id) VALUES (?, ?)').run(
    'repo:lsm/hyperneo\u0000history',
    id
  );
}

describe('Neo project hierarchy', () => {
  test('paths have no depth cap and reject corrupt ancestry', () => {
    const tree = Array.from({ length: 80 }, (_, index) => ({
      id: String(index),
      parentId: index ? String(index - 1) : null,
    }));
    const before = structuredClone(tree);
    expect(neoProjectPath(tree, '79')).toHaveLength(80);
    expect(neoProjectMoveReason(tree, '0', '79')).toBe('project_cycle');
    expect(neoProjectMoveReason(tree, '79', '0')).toBeNull();
    expect(neoProjectMoveReason(tree, '0', 'missing')).toBe('unknown_or_invalid_parent');
    expect(
      neoProjectPath(
        [
          { id: 'a', parentId: 'b' },
          { id: 'b', parentId: 'a' },
        ],
        'a'
      )
    ).toEqual([]);
    expect(neoProjectPath([{ id: 'a', parentId: 'missing' }], 'a')).toEqual([]);
    expect(tree).toEqual(before);
  });

  test('moves preserve context, reject stale changes and cycles, and detach to root', () => {
    save('root');
    save('child');
    save('leaf');
    save('inbox');
    expect(repo.moveProject('child', 'root', 1)).toEqual({ ok: true });
    expect(repo.moveProject('leaf', 'child', 1)).toEqual({ ok: true });
    const before = repo.listProjects();
    expect(repo.moveProject('root', 'leaf', 1)).toEqual({ ok: false, reason: 'project_cycle' });
    expect(repo.moveProject('child', null, 1)).toEqual({ ok: false, reason: 'superseded' });
    expect(repo.moveProject('inbox', 'root', 1)).toEqual({
      ok: false,
      reason: 'inbox_cannot_nest',
    });
    expect(repo.moveProject('root', 'missing', 1)).toEqual({
      ok: false,
      reason: 'unknown_or_invalid_parent',
    });
    expect(repo.listProjects()).toEqual(before);
    expect(repo.moveProject('child', null, 2)).toEqual({ ok: true });
    expect(repo.getProject('child')).toMatchObject({
      parentId: null,
      revision: 3,
      context: 'retained',
    });
    expect(repo.moveProject('child', null, 3)).toEqual({ ok: true });
    expect(repo.getProject('child')?.revision).toBe(3);
    expect(neoProjectPath(repo.listProjects(), 'leaf').map((item) => item.id)).toEqual([
      'child',
      'leaf',
    ]);
  });

  test('sections reuse the epic and inherit workspaces without duplicating aliases', () => {
    save('root');
    save('group');
    workspace('root');
    repo.moveProject('group', 'root', 1);
    const created = repo.createSection('group', epicUrl, 'Neo projects');
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(created.reason);
    expect(repo.createSection('group', epicUrl, 'Another title')).toEqual(created);
    expect(repo.workspaceAliases(created.projectId)).toEqual(repo.workspaceAliases('root'));
    expect(db.prepare('SELECT COUNT(*) AS n FROM neo_project_workspaces').get()).toEqual({ n: 1 });
    expect(repo.createSection('root', epicUrl, 'Duplicate')).toEqual({
      ok: false,
      reason: 'epic_already_has_section',
    });
    expect(repo.moveProject(created.projectId, null, 1)).toEqual({
      ok: false,
      reason: 'section_needs_parent',
    });
    expect(repo.moveProject('group', null, 2)).toEqual({
      ok: false,
      reason: 'section_workspace_mismatch',
    });
    save('other');
    expect(repo.moveProject(created.projectId, 'other', 1)).toEqual({
      ok: false,
      reason: 'section_workspace_mismatch',
    });
    expect(repo.createSection('root', 'https://github.com/other/repo/issues/1', 'Other')).toEqual({
      ok: false,
      reason: 'section_workspace_mismatch',
    });
  });

  test('the migration preserves existing projects and runs repeatedly', () => {
    const old = new Database(':memory:');
    try {
      old.exec(
        "CREATE TABLE neo_concerns (id TEXT PRIMARY KEY, title TEXT); INSERT INTO neo_concerns VALUES ('old', 'Old')"
      );
      runMigration368(old);
      runMigration368(old);
      expect(old.prepare('SELECT * FROM neo_concerns').get()).toEqual({
        id: 'old',
        title: 'Old',
        parent_id: null,
        epic_url: null,
      });
    } finally {
      old.close();
    }
  });

  test('any daemon session reorganizes the tree, and forgetting stays root or human', async () => {
    save('root');
    save('child');
    workspace('root');
    repo.reserveBinding({ kind: 'worker', projectId: 'child', sessionId: 'holder' });
    const read = mock(async () => [epic]);
    const [move, section] = createNeoProjectTreeOperations(repo, read);
    const caller = { source: 'mcp' as const, sessionId: 'holder' };
    expect(
      await move.execute({ id: 'child', parentId: 'root', expectedRevision: 1 }, caller)
    ).toEqual({ ok: true });
    expect(repo.getProject('child')?.parentId).toBe('root');
    expect(await section.execute({ parentId: 'root', epicUrl }, caller)).toMatchObject({
      ok: true,
    });
  });

  test('authorization rejects callers without a session before external reads or writes', async () => {
    save('root');
    save('child');
    workspace('root');
    repo.reserveBinding({ kind: 'worker', projectId: 'child', sessionId: 'holder' });
    const read = mock(async () => [epic]);
    const [move, section] = createNeoProjectTreeOperations(repo, read);
    const caller = { source: 'internal' as const };
    expect(
      await move.execute({ id: 'child', parentId: 'root', expectedRevision: 1 }, caller)
    ).toEqual({ ok: false, reason: 'local_session_required' });
    expect(await section.execute({ parentId: 'root', epicUrl }, caller)).toEqual({
      ok: false,
      reason: 'local_session_required',
    });
    expect(read).not.toHaveBeenCalled();
    expect(repo.getProject('child')?.parentId).toBeNull();
    expect(requireNeoTreeAuthor(local, null)).toEqual({ value: true });
    expect(requireNeoTreeAuthor({ source: 'mcp' }, null)).toMatchObject({ reason: { ok: false } });
    expect(requireNeoEpic([], epicUrl)).toEqual({
      reason: { ok: false, reason: 'epic_unavailable' },
    });
    expect(
      await move.execute({ id: 'child', parentId: 'root', expectedRevision: 1 }, local)
    ).toEqual({ ok: true });
    const created = await section.execute({ parentId: 'root', epicUrl }, local);
    expect(created.ok).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
    const before = repo.listProjects();
    expect(
      await section.execute({ parentId: 'root', epicUrl: 'https://example.com/issues/1' }, local)
    ).toEqual({ ok: false, reason: 'invalid_epic_url' });
    expect(repo.listProjects()).toEqual(before);
  });

  test('section creation normalizes HTTP epic URLs and reuses their HTTPS identity', async () => {
    save('root');
    workspace('root');
    const read = mock(async () => [
      { ...epic, url: 'https://github.com/lsm/HyperNeo/issues/6756' },
    ]);
    const [, section] = createNeoProjectTreeOperations(repo, read);
    const result = await section.execute(
      { parentId: 'root', epicUrl: 'http://github.com/LSM/HyperNeo/issues/6756/' },
      local
    );
    if (!result.ok) throw new Error(result.reason);
    expect(repo.getProject(result.projectId)?.epicUrl).toBe(epicUrl);
    expect(read).toHaveBeenCalledWith([{ owner: 'lsm', repo: 'hyperneo', number: 6756 }]);
    expect(await section.execute({ parentId: 'root', epicUrl }, local)).toEqual(result);
    expect(repo.listProjects()).toHaveLength(2);
  });

  test('section creation rejects invalid parents before reading GitHub', async () => {
    save('inbox');
    const read = mock(async () => [epic]);
    const [, section] = createNeoProjectTreeOperations(repo, read);
    const before = repo.listProjects();
    for (const parentId of ['missing', 'inbox'])
      expect(await section.execute({ parentId, epicUrl }, local)).toEqual({
        ok: false,
        reason: 'unknown_parent',
      });
    expect(read).not.toHaveBeenCalled();
    expect(repo.listProjects()).toEqual(before);
  });
});
