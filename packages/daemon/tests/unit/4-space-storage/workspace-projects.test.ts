import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../../../src/storage/sqlite-compat';
import { runMigration360 } from '../../../src/storage/schema/m360-workspace-projects';
import { WorkspaceHistoryRepository } from '../../../src/storage/repositories/workspace-history-repository';
import { createProjectFolderOperation } from '../../../src/lib/workspaces/project-folder-operation';
import { createOperationRegistry } from '../../../src/lib/operations/registry';
import { invokeOperation } from '../../../src/lib/operations/invoke';
import { createFindWorkOperation } from '../../../src/lib/drivers/find-operation';
import type { PlaceGroup } from '../../../src/lib/drivers/types';
import { buildHyperneoGroups } from '../../../src/lib/drivers/hyperneo-adapter';

describe('workspace project folders', () => {
  let db: Database;
  let repo: WorkspaceHistoryRepository;
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'workspace-projects-'));
    db = new Database(join(dir, 'db.sqlite'));
    db.exec(`PRAGMA foreign_keys = ON;
      CREATE TABLE workspace_history (id INTEGER PRIMARY KEY, path TEXT UNIQUE NOT NULL,
      last_used_at INTEGER NOT NULL, use_count INTEGER NOT NULL)`);
    repo = new WorkspaceHistoryRepository(db);
    repo.upsert('/legacy');
    runMigration360(db);
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('migration is repeatable and preserves standalone history', () => {
    runMigration360(db);
    expect(repo.entries()).toEqual([
      { path: '/legacy', lastUsedAt: expect.any(Number), useCount: 1 },
    ]);
    expect(repo.projects()).toEqual([]);
  });

  test('persists a stable project with several folders across reopening and repeated calls', () => {
    expect(repo.addProjectFolder('/a', '/b', 'Product')).toBe(true);
    expect(repo.addProjectFolder('/b', '/c', 'Ignored rename')).toBe(true);
    const entries = repo.entries();
    expect(repo.addProjectFolder('/a', '/b', 'Ignored rename')).toBe(true);
    expect(repo.entries()).toEqual(entries);
    const [project] = repo.projects();
    expect(project).toEqual({
      id: expect.any(String),
      name: 'Product',
      folders: ['/a', '/b', '/c'],
    });
    db.close();
    db = new Database(join(dir, 'db.sqlite'));
    db.exec('PRAGMA foreign_keys = ON');
    repo = new WorkspaceHistoryRepository(db);
    expect(repo.projects()).toEqual([project]);
    expect(repo.entries().filter((entry) => entry.project?.id === project.id)).toHaveLength(3);
    repo.remove('/a');
    expect(repo.projects()).toEqual([{ ...project, folders: ['/b', '/c'] }]);
    expect(repo.get('/b')).not.toBeNull();
  });

  test('refuses cross-project transfers atomically and rolls back failed writes', () => {
    repo.addProjectFolder('/a', '/b', 'One');
    repo.addProjectFolder('/x', '/y', 'Two');
    const before = repo.entries();
    expect(repo.addProjectFolder('/a', '/y', 'One')).toBe(false);
    expect(repo.addProjectFolder('/new', '/y', 'New')).toBe(false);
    expect(repo.entries()).toEqual(before);
    db.exec(`CREATE TRIGGER reject_new BEFORE INSERT ON workspace_project_folders
      WHEN NEW.path = '/fail' BEGIN SELECT RAISE(ABORT, 'injected fault'); END`);
    expect(() => repo.addProjectFolder('/a', '/fail', 'One')).toThrow('injected fault');
    expect(repo.entries()).toEqual(before);
  });

  test('history includes every folder even beyond the old twenty-entry limit', () => {
    for (let i = 0; i < 25; i++) repo.addProjectFolder('/a', `/folder-${i}`, 'Product');
    expect(repo.entries()).toHaveLength(27);
    expect(repo.entries().find((entry) => entry.path === '/a')?.project?.folders).toHaveLength(26);
  });

  test('operation validates all folders before writing and exposes domain rejections', async () => {
    const first = join(dir, 'first');
    const second = join(dir, 'second');
    mkdirSync(first);
    mkdirSync(second);
    writeFileSync(join(dir, 'file'), 'not a directory');
    const registry = createOperationRegistry([createProjectFolderOperation(repo)]);
    const invoke = (projectPath: string, path: string) =>
      invokeOperation(registry, 'work.project.addFolder', { projectPath, path }, { source: 'rpc' });
    for (const [projectPath, path] of [
      [first, join(dir, 'missing')],
      [join(dir, 'missing'), second],
      [first, join(dir, 'file')],
    ]) {
      expect(await invoke(projectPath, path)).toMatchObject({
        kind: 'completed',
        value: { accepted: false },
      });
      expect(repo.projects()).toEqual([]);
    }
    expect(await invoke(`${first}/../first`, second)).toEqual({
      kind: 'completed',
      value: { accepted: true },
    });
    expect(repo.projects()[0].folders).toEqual([first, second]);
    expect(repo.projects()[0].name).toBe('first');
    const third = join(dir, 'third');
    mkdirSync(third);
    expect(await invoke(third, second)).toMatchObject({
      kind: 'completed',
      value: { accepted: false, reason: 'Folder already belongs to another project.' },
    });
    expect(repo.get(third)).toBeNull();
  });

  test('adds to a persisted project after its first member vanished but still validates the new directory', async () => {
    const first = join(dir, 'a');
    const second = join(dir, 'b');
    const added = join(dir, 'c');
    for (const folder of [first, second, added]) mkdirSync(folder);
    repo.addProjectFolder(first, second, 'Product');
    const project = repo.projects()[0];
    rmSync(first, { recursive: true });
    const registry = createOperationRegistry([createProjectFolderOperation(repo)]);
    const invoke = (path: string) =>
      invokeOperation(
        registry,
        'work.project.addFolder',
        { projectPath: first, path },
        { source: 'rpc' }
      );
    expect(await invoke(join(dir, 'missing'))).toMatchObject({
      kind: 'completed',
      value: { accepted: false },
    });
    expect(repo.projects()).toEqual([project]);
    expect(await invoke(added)).toMatchObject({ kind: 'completed', value: { accepted: true } });
    expect(repo.projects()).toEqual([{ ...project, folders: [first, second, added] }]);
    expect(repo.remove(first)).toBe(true);
    expect(repo.projects()[0].id).toBe(project.id);
    repo.remove(second);
    repo.remove(added);
    expect(repo.projects()).toEqual([]);
    expect(db.prepare('SELECT id FROM workspace_projects').all()).toEqual([]);
  });

  test('driver discovery carries one tool project identity on all folders and matches its name', async () => {
    repo.addProjectFolder('/code', '/docs', 'Product');
    const places = ['/code', '/docs'].map((folder) => ({
      folder,
      known: 1,
      openCount: 0,
      archivedCount: 0,
      lastActiveAt: null,
    }));
    const groups = buildHyperneoGroups(
      places,
      [],
      { text: 'Product', includeClosed: false, limit: 20 },
      { machine: 'local' },
      new Map(),
      new Map(),
      repo.projects()
    );
    expect(groups.map((group) => group.place.folder)).toEqual(['/code', '/docs']);
    expect(groups.map((group) => group.place.toolProject)).toEqual(
      Array(2).fill({
        id: `hyperneo:${repo.projects()[0].id}`,
        name: 'Product',
      })
    );
    const registry = createOperationRegistry([
      createFindWorkOperation({
        adapters: () => [{ id: 'hyperneo', capabilities: ['find'], find: () => groups }],
        remote: {
          list: () => [],
          invoke: async () => {
            throw new Error('unexpected remote');
          },
        },
      }),
    ]);
    const result = await invokeOperation(
      registry,
      'work.find',
      { localOnly: true },
      { source: 'rpc' }
    );
    if (result.kind !== 'completed') throw new Error('find did not complete');
    const found = (result.value as { places: PlaceGroup[] }).places;
    expect(found).toHaveLength(1);
    expect(found[0].projectId).toBe(`tool:local:hyperneo:${repo.projects()[0].id}`);
    expect(found[0].workspaces?.map((place) => place.folder)).toEqual(['/code', '/docs']);
  });
});
