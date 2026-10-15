import { hostname } from 'node:os';
import { createFindWorkOperation } from '../../../../src/lib/drivers/find-operation.ts';
import { createOperationRegistry } from '../../../../src/lib/operations/registry.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createNeoTables } from '../../../../src/storage/schema/neo.ts';
import { runMigration361 } from '../../../../src/storage/schema/m361-neo-project-avatars.ts';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository.ts';
import {
  backfillNeoRepositoryIdentities,
  isNeoPlumbingFolder,
  neoRepositoryIdentity,
  mirrorNeoWorkspaceProjects,
  planNeoWorkspaceProjects,
} from '../../../../src/lib/neo/project-mirror.ts';
import { mergePlaceGroups } from '../../../../src/lib/drivers/places.ts';
import type { PlaceGroup } from '../../../../src/lib/drivers/types.ts';
import { isTempCwd } from '../../../../src/lib/drivers/claude-feed.ts';
import { createTestDb } from '../../../helpers/database.ts';

const elsewhere = `not-${hostname()}`;

function workspace(folder: string, machine = elsewhere, identity = 'root:123'): PlaceGroup {
  return {
    place: { folder, machine, name: 'HyperNeo', codeIdentity: identity },
    lastActivityAt: 0,
    openCount: 0,
    archivedCount: 0,
    adapters: ['hyperneo'],
    work: [],
  };
}

describe('mirrorNeoWorkspaceProjects', () => {
  let db: Database;
  let repo: NeoRepository;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    createNeoTables(db);
    runMigration361(db);
    repo = new NeoRepository(db);
  });
  afterEach(() => db.close());

  test('discovery persists an avatar through the real work.find operation', async () => {
    const registry = createOperationRegistry([
      createFindWorkOperation({
        adapters: () => [
          { id: 'hyperneo', capabilities: ['find'], find: () => [workspace('/one')] },
        ],
        remote: {
          list: () => [{ daemonId: 'desktop' }],
          invoke: async () => ({ places: [workspace('/two', 'desktop')], unreachable: [] }),
        },
        mirrorProjects: (groups) => {
          mirrorNeoWorkspaceProjects(db, groups);
        },
      }),
    ]);
    const caller = { source: 'rpc' as const, principal: 'local' as const };
    expect((await invokeOperation(registry, 'work.find', {}, caller)).kind).toBe('completed');
    expect(repo.listProjects()).toHaveLength(1);
    expect(repo.listProjects()[0].title).toBe('HyperNeo');
    expect((await invokeOperation(registry, 'work.find', {}, caller)).kind).toBe('completed');
    expect(repo.listProjects()).toHaveLength(1);
  });

  test('mirrors folders with shared history across machines once and preserves context', () => {
    mirrorNeoWorkspaceProjects(
      db,
      mergePlaceGroups([workspace('/one'), workspace('/two', 'desktop')], 50)
    );
    const [project] = repo.listProjects();
    expect(repo.listProjects()).toHaveLength(1);
    expect(project.title).toBe('HyperNeo');
    repo.saveProject(
      { ...project, context: 'Human decisions', title: 'My project' },
      project.revision
    );
    mirrorNeoWorkspaceProjects(db, mergePlaceGroups([workspace('/three', 'cloud')], 50));
    expect(repo.listProjects()).toHaveLength(1);
    expect(repo.getProject(project.id)).toMatchObject({
      context: 'Human decisions',
      title: 'My project',
      revision: 2,
    });
    expect(db.prepare('SELECT COUNT(*) AS n FROM neo_project_workspaces').get()).toMatchObject({
      n: 4,
    });
  });

  test('merges older folder-only projects into the project of their stored code identity, without reading any folder here', async () => {
    const full = await createTestDb();
    const db = full.getDatabase();
    const repo = new NeoRepository(db);
    const neokai = `git:${'a'.repeat(40)}`;
    const other = `git:${'b'.repeat(40)}`;
    const group = (folder: string, machine: string, identity?: string) => {
      const found = workspace(folder, machine);
      return [{ ...found, place: { ...found.place, codeIdentity: identity } }];
    };
    mirrorNeoWorkspaceProjects(db, group('/w1', 'laptop'));
    mirrorNeoWorkspaceProjects(db, group('/w2', 'laptop'));
    mirrorNeoWorkspaceProjects(db, group('/w3', 'laptop', other));
    mirrorNeoWorkspaceProjects(db, group('/repo', 'imac', neokai));
    expect(repo.listProjects()).toHaveLength(4);
    const owner = db
      .prepare('SELECT project_id AS id FROM neo_project_workspaces WHERE alias = ?')
      .get(neokai) as { id: string };
    expect(
      mirrorNeoWorkspaceProjects(
        db,
        mergePlaceGroups(
          [
            workspace('/repo', 'imac', neokai),
            workspace('/w1', 'laptop', neokai),
            workspace('/w2', 'laptop', neokai),
            workspace('/w3', 'laptop', neokai),
          ],
          50
        )
      )
    ).toBe(true);
    const left = repo.listProjects();
    expect(left).toHaveLength(2);
    expect(left.map((project) => project.id)).toContain(owner.id);
    expect(
      left.find((project) => project.id !== owner.id) &&
        db.prepare('SELECT project_id FROM neo_project_workspaces WHERE alias = ?').get(other)
    ).toMatchObject({ project_id: left.find((project) => project.id !== owner.id)!.id });
    expect(repo.projectMerges.redirects()).toHaveLength(2);
    full.close();
  });

  test('titles a project after its repository, never a generated worktree folder, and keeps a title a human chose', () => {
    const uuid = 'f793a97e-2b7e-4088-92a1-2506bde88670';
    const tree = (remotes?: string[]) => {
      const found = workspace(`/w/neokai/worktrees/${uuid}`, 'laptop', 'git:1');
      return [{ ...found, place: { ...found.place, name: uuid, remotes } }];
    };
    mirrorNeoWorkspaceProjects(db, tree());
    expect(repo.listProjects().map((project) => project.title)).toEqual(['neokai']);
    const [first] = repo.listProjects();
    repo.saveProject({ ...first, title: uuid, summary: `Project: ${uuid}` }, first.revision);
    expect(mirrorNeoWorkspaceProjects(db, tree(['git@github.com:lsm/HyperNeo.git']))).toBe(true);
    expect(repo.listProjects().map((project) => project.title)).toEqual(['HyperNeo']);
    const [named] = repo.listProjects();
    repo.saveProject({ ...named, title: 'My app' }, named.revision);
    mirrorNeoWorkspaceProjects(db, tree(['git@github.com:lsm/other.git']));
    expect(repo.listProjects().map((project) => project.title)).toEqual(['My app']);
  });

  test('does not let a reused folder collapse unrelated repository histories', () => {
    mirrorNeoWorkspaceProjects(db, mergePlaceGroups([workspace('/one')], 50));
    mirrorNeoWorkspaceProjects(
      db,
      mergePlaceGroups([workspace('/one', elsewhere, 'root:456')], 50)
    );
    expect(repo.listProjects()).toHaveLength(2);
    const owner = db
      .prepare("SELECT project_id FROM neo_project_workspaces WHERE alias = 'root:456'")
      .get();
    expect(
      db.prepare("SELECT project_id FROM neo_project_workspaces WHERE alias LIKE 'folder:%'").get()
    ).toEqual(owner);
  });

  test('keeps unrelated identities separate and preserves projects without workspaces', () => {
    repo.saveProject({ id: 'travel', title: 'Travel', summary: '', context: 'Passport' }, 0);
    mirrorNeoWorkspaceProjects(
      db,
      mergePlaceGroups([workspace('/one'), workspace('/other', elsewhere, 'root:456')], 50)
    );
    mirrorNeoWorkspaceProjects(db, []);
    expect(repo.listProjects()).toHaveLength(3);
    expect(repo.getProject('travel')?.context).toBe('Passport');
  });

  test('mirrors several folders in a named tool project with different histories once', () => {
    const groups = [workspace('/one'), workspace('/other', elsewhere, 'root:456')].map((group) => ({
      ...group,
      place: { ...group.place, toolProject: { id: 'product', name: 'Product' } },
    }));
    mirrorNeoWorkspaceProjects(db, mergePlaceGroups(groups, 50));
    expect(repo.listProjects()).toHaveLength(1);
    expect(repo.listProjects()[0].title).toBe('Product');
  });
});

describe('runMigration361', () => {
  test('preserves legacy holders and publication links on repeatable migration', () => {
    const db = new Database(':memory:');
    try {
      createNeoTables(db);
      new NeoRepository(db).saveProject(
        { id: 'old', title: 'Old', summary: '', context: 'Keep' },
        0
      );
      db.exec(`DROP TABLE neo_session_bindings;
        CREATE TABLE neo_session_bindings (session_id TEXT PRIMARY KEY, concern_id TEXT,
          kind TEXT CHECK(kind IN ('neo', 'concern', 'worker')));
        INSERT INTO neo_session_bindings VALUES ('holder', 'old', 'concern');`);
      const payload = JSON.stringify({ links: [{ kind: 'concern', id: 'old', label: 'Old' }] });
      db.prepare(
        'INSERT INTO neo_publications (conversation_id, publication_id, payload_json, created_at) VALUES (?, ?, ?, ?)'
      ).run('root', 'reply', payload, 'now');
      runMigration361(db);
      runMigration361(db);
      const repo = new NeoRepository(db);
      expect(repo.getBindingForProject('old')).toEqual({
        sessionId: 'holder',
        projectId: 'old',
        kind: 'project',
      });
      expect(repo.getProject('old')?.context).toBe('Keep');
      expect(db.prepare('SELECT payload_json FROM neo_publications').get()).toEqual({
        payload_json: payload.replace('concern', 'project'),
      });
      expect(() =>
        repo.reserveBinding({ sessionId: 'duplicate', projectId: 'old', kind: 'project' })
      ).not.toThrow();
      expect(repo.getBindingForProject('old')?.sessionId).toBe('holder');
    } finally {
      db.close();
    }
  });
});

describe('isNeoPlumbingFolder', () => {
  const local = {
    machine: 'laptop',
    neoFolder: '/home/fictional/.hyperneo/Neo',
    isTemp: isTempCwd,
    exists: (path: string) => path !== '/home/fictional/gone',
  };

  test("skips Neo's own runtime folders, temp folders and folders that are gone on this machine", () => {
    for (const folder of [
      '/home/fictional/.hyperneo/Neo',
      '/home/fictional/.hyperneo/Neo/.coordinators/neo-1',
      '/private/tmp',
      '/private/var/folders/xy/T/scratch',
      '/home/fictional/gone',
    ])
      expect(isNeoPlumbingFolder({ folder, machine: 'laptop' }, local)).toBe(true);
  });

  test('keeps real folders, and judges only shape, never existence, on another machine', () => {
    expect(isNeoPlumbingFolder({ folder: '/home/fictional/tmp', machine: 'laptop' }, local)).toBe(
      false
    );
    expect(
      isNeoPlumbingFolder(
        { folder: '/home/fictional/.hyperneo/Neo-site', machine: 'laptop' },
        local
      )
    ).toBe(false);
    expect(isNeoPlumbingFolder({ folder: '/home/fictional/gone', machine: 'imac' }, local)).toBe(
      false
    );
    for (const folder of ['/tmp', '/Users/other/.hyperneo/Neo/.coordinators/neo-2'])
      expect(isNeoPlumbingFolder({ folder, machine: 'imac', daemon: 'tts' }, local)).toBe(true);
  });
});

describe('planNeoWorkspaceProjects', () => {
  test('mints no project for a plumbing folder', () => {
    const plan = planNeoWorkspaceProjects(
      [workspace('/repo'), workspace('/home/fictional/.hyperneo/Neo/.coordinators/neo-1')],
      (place) => place.folder?.includes('.coordinators') ?? false
    );
    expect(
      plan.map((project) => project.aliases.find((alias) => alias.startsWith('folder:')))
    ).toEqual([`folder:${elsewhere}\u0000/repo`]);
  });
});

describe('planNeoWorkspaceProjects with a gone primary', () => {
  test('keeps the live workspaces of a group whose primary folder is gone', () => {
    const group = workspace('/gone');
    const [plan] = planNeoWorkspaceProjects(
      [{ ...group, workspaces: [group.place, { ...group.place, folder: '/live', name: 'live' }] }],
      (place) => place.folder === '/gone'
    );
    expect(plan.title).toBe('live');
    expect(plan.aliases.filter((alias) => alias.startsWith('folder:'))).toEqual([
      `folder:${elsewhere}\u0000/live`,
    ]);
  });

  test('names a repository the same way from every remote form', () => {
    for (const remote of [
      'git@github.com:lsm/HyperNeo.git',
      'https://github.com/lsm/hyperneo',
      'https://token@github.com/lsm/HyperNeo.git/',
      'ssh://git@github.com/lsm/hyperneo.git',
    ])
      expect(neoRepositoryIdentity(remote)).toBe('repository:github.com/lsm/hyperneo');
    expect(neoRepositoryIdentity('git@gitlab.example.com:team/app.git')).toBe(
      'repository:gitlab.example.com/team/app'
    );
    expect(neoRepositoryIdentity('file:///Users/lsm/repo')).toBeNull();
    expect(neoRepositoryIdentity(undefined)).toBeNull();
  });

  test('folds projects whose folders are gone into their repository by the stored remote, and leaves other repositories and repo-less projects alone', async () => {
    const full = await createTestDb();
    const raw = full.getDatabase();
    const store = new NeoRepository(raw);
    const save = (title: string, aliases: string[]) => {
      const id = `project:${title}`;
      store.saveProject({ id, title, summary: `Project: ${title}`, context: '' }, 0);
      for (const alias of aliases)
        raw
          .prepare('INSERT INTO neo_project_workspaces (alias, project_id) VALUES (?, ?)')
          .run(alias, id);
      return id;
    };
    const repoAlias = (name: string, folder: string) => `repo:${name}\u0000tts\u0000${folder}`;
    const kept = save('neokai', [repoAlias('lsm/hyperneo', '/focus/neokai')]);
    save('001ce5d6-494e-4db1-9d65-0a8745ef4162', [
      'folder:tts\u0000/gone/001ce5d6',
      repoAlias('lsm/hyperneo', '/gone/001ce5d6'),
    ]);
    save('3a4a1989-7093-4b8e-bb18-0248d528a9dd', [repoAlias('lsm/hyperneo', '/gone/3a4a1989')]);
    const other = save('makai', [repoAlias('lsm/makai', '/focus/makai')]);
    const bare = save('180460d2-753e-4418-91b9-6636a831c0c0', ['folder:laptop\u0000/w/180460d2']);
    expect(backfillNeoRepositoryIdentities(raw)).toBe(true);
    expect(
      store
        .listProjects()
        .map((project) => project.id)
        .sort()
    ).toEqual([bare, kept, other].sort());
    expect(store.getProject(kept)?.title).toBe('neokai');
    expect(
      raw
        .prepare('SELECT project_id FROM neo_project_workspaces WHERE alias = ?')
        .get('repository:github.com/lsm/hyperneo')
    ).toEqual({ project_id: kept });
    expect(store.projectMerges.redirects()).toHaveLength(2);
    expect(backfillNeoRepositoryIdentities(raw)).toBe(false);
    full.close();
  });

  test('retitles a generated title from the repository when the project kept it', async () => {
    const full = await createTestDb();
    const raw = full.getDatabase();
    const store = new NeoRepository(raw);
    const title = '6c79b9f4-531a-4c83-a514-fa20c272ea80';
    store.saveProject({ id: 'project:x', title, summary: `Project: ${title}`, context: '' }, 0);
    raw
      .prepare('INSERT INTO neo_project_workspaces (alias, project_id) VALUES (?, ?)')
      .run('repo:lsm/hyperneo\u0000x', 'project:x');
    backfillNeoRepositoryIdentities(raw);
    expect(store.getProject('project:x')?.title).toBe('hyperneo');
    full.close();
  });

  test('merges a re-created repository with the same remote though its history differs', async () => {
    const full = await createTestDb();
    const raw = full.getDatabase();
    const store = new NeoRepository(raw);
    const place = (folder: string, root: string) => {
      const found = workspace(folder, 'laptop', `git:${root.repeat(40)}`);
      return [{ ...found, place: { ...found.place, remotes: ['git@github.com:lsm/neokai.git'] } }];
    };
    mirrorNeoWorkspaceProjects(raw, place('/old', 'a'));
    mirrorNeoWorkspaceProjects(raw, place('/new', 'b'));
    expect(store.listProjects()).toHaveLength(1);
    full.close();
  });
});
