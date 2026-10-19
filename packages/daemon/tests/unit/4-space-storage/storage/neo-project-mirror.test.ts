import { hostname } from 'node:os';
import { runMigration387 } from '../../../../src/storage/schema/m387-neo-ask-todo-tables.ts';
import { createFindWorkOperation } from '../../../../src/lib/drivers/find-operation.ts';
import { createOperationRegistry } from '../../../../src/lib/operations/registry.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createNeoTables } from '../../../../src/storage/schema/neo.ts';
import { runMigration313 } from '../../../../src/storage/schema/m313-neo-asks.ts';
import { runMigration361 } from '../../../../src/storage/schema/m361-neo-project-avatars.ts';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository.ts';
import {
  backfillNeoRepositoryIdentities,
  canNeoMirrorCreateProject,
  isNeoPlumbingFolder,
  neoIdentityOwner,
  neoRepositoryIdentity,
  mirrorNeoWorkspaceProjects,
  planNeoWorkspaceProjects,
} from '../../../../src/lib/neo/project-mirror.ts';
import { mergePlaceGroups } from '../../../../src/lib/drivers/places.ts';
import type { PlaceGroup } from '../../../../src/lib/drivers/types.ts';
import { isTempCwd } from '../../../../src/lib/drivers/claude-feed.ts';
import { createTestDb } from '../../../helpers/database.ts';

const elsewhere = `not-${hostname()}`;

const HYPERNEO = 'git@github.com:lsm/HyperNeo.git';

function workspace(
  folder: string,
  machine = elsewhere,
  identity = 'root:123',
  remote?: string
): PlaceGroup {
  return {
    place: {
      folder,
      machine,
      name: 'HyperNeo',
      codeIdentity: identity,
      ...(remote ? { remotes: [remote] } : {}),
    },
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
    runMigration313(db);
    runMigration361(db);
    runMigration387(db);
    repo = new NeoRepository(db);
  });
  afterEach(() => db.close());

  test('discovery persists an avatar through the real work.find operation', async () => {
    const registry = createOperationRegistry([
      createFindWorkOperation({
        adapters: () => [
          {
            id: 'hyperneo',
            capabilities: ['find'],
            find: () => [workspace('/one', elsewhere, 'root:123', HYPERNEO)],
          },
        ],
        remote: {
          list: () => [{ daemonId: 'desktop' }],
          invoke: async () => ({
            places: [workspace('/two', 'desktop', 'root:123', HYPERNEO)],
            unreachable: [],
          }),
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

  test('a folder some tool worked in becomes a project only when it has a repository', () => {
    const scratch = workspace('/tmp/bg-test-repo-2448f54b', elsewhere, `git:${'c'.repeat(40)}`);
    const tool = {
      ...workspace('/Users/me/Claude Code', 'tts', 'none'),
      place: {
        folder: '/Users/me/Claude Code',
        machine: 'tts',
        name: 'Claude Code',
        toolProject: { id: 'claude', name: 'Claude Code' },
      },
    };
    expect(mirrorNeoWorkspaceProjects(db, [scratch, tool])).toBe(false);
    expect(repo.listProjects()).toEqual([]);
    expect(canNeoMirrorCreateProject({ aliases: ['folder:x', 'git:abc'] })).toBe(false);
    expect(canNeoMirrorCreateProject({ aliases: ['repository:github.com/lsm/neokai'] })).toBe(true);
  });

  test('a folder without a repository never becomes a project, even with work on several days', () => {
    const day = 24 * 60 * 60 * 1000;
    const session = (id: string, at: number) => ({
      ref: { adapter: 'claude-desktop', id },
      title: id,
      place: { folder: '/Users/me/notes', machine: elsewhere, name: 'notes' },
      status: 'done' as const,
      lastActivityAt: at,
    });
    const notes = (work: ReturnType<typeof session>[]) => ({
      ...workspace('/Users/me/notes', elsewhere, 'none'),
      place: { folder: '/Users/me/notes', machine: elsewhere, name: 'notes' },
      work,
    });
    mirrorNeoWorkspaceProjects(db, [
      notes([session('a', 10 * day), session('b', 10 * day + 60_000)]),
    ]);
    expect(repo.listProjects()).toEqual([]);
    mirrorNeoWorkspaceProjects(db, [notes([session('a', 10 * day), session('c', 12 * day)])]);
    expect(repo.listProjects()).toEqual([]);
  });

  test('ignores places reported by attached daemons', () => {
    const remote = workspace('/repo', 'imac', 'root:123', HYPERNEO);
    expect(
      mirrorNeoWorkspaceProjects(db, [{ ...remote, place: { ...remote.place, daemon: 'tts' } }])
    ).toBe(false);
    expect(repo.listProjects()).toEqual([]);
  });

  test('a folder without a repository still joins the project that already holds its identity', () => {
    mirrorNeoWorkspaceProjects(db, [workspace('/repo', elsewhere, 'root:123', HYPERNEO)]);
    const [project] = repo.listProjects();
    mirrorNeoWorkspaceProjects(db, [workspace('/worktree', 'laptop')]);
    expect(repo.listProjects()).toHaveLength(1);
    expect(
      db
        .prepare('SELECT project_id FROM neo_project_workspaces WHERE alias = ?')
        .get('folder:laptop\u0000/worktree')
    ).toEqual({ project_id: project.id });
  });

  test('mirrors folders with shared history across machines once and preserves context', () => {
    mirrorNeoWorkspaceProjects(
      db,
      mergePlaceGroups(
        [
          workspace('/one', elsewhere, 'root:123', HYPERNEO),
          workspace('/two', 'desktop', 'root:123', HYPERNEO),
        ],
        50
      )
    );
    const [project] = repo.listProjects();
    expect(repo.listProjects()).toHaveLength(1);
    expect(project.title).toBe('HyperNeo');
    repo.saveProject(
      { ...project, context: 'Human decisions', title: 'My project' },
      project.revision
    );
    mirrorNeoWorkspaceProjects(
      db,
      mergePlaceGroups([workspace('/three', 'cloud', 'root:123', HYPERNEO)], 50)
    );
    expect(repo.listProjects()).toHaveLength(1);
    expect(repo.getProject(project.id)).toMatchObject({
      context: 'Human decisions',
      title: 'My project',
      revision: 2,
    });
    expect(db.prepare('SELECT COUNT(*) AS n FROM neo_project_workspaces').get()).toMatchObject({
      n: 6,
    });
  });

  test('leaves older folder-only projects apart from the project of their code identity', async () => {
    const full = await createTestDb();
    const db = full.getDatabase();
    const repo = new NeoRepository(db);
    const neokai = `git:${'a'.repeat(40)}`;
    const other = `git:${'b'.repeat(40)}`;
    const legacy = (id: string, folder: string, identity?: string) => {
      repo.saveProject({ id, title: id, summary: `Project: ${id}`, context: '' }, 0);
      for (const alias of [`folder:laptop\u0000${folder}`, ...(identity ? [identity] : [])])
        db.prepare('INSERT INTO neo_project_workspaces (alias, project_id) VALUES (?, ?)').run(
          alias,
          id
        );
    };
    legacy('project:w1', '/w1');
    legacy('project:w2', '/w2');
    legacy('project:w3', '/w3', other);
    mirrorNeoWorkspaceProjects(db, [
      workspace('/repo', 'imac', neokai, 'git@github.com:lsm/neokai.git'),
    ]);
    expect(repo.listProjects()).toHaveLength(4);
    const owner = db
      .prepare('SELECT project_id AS id FROM neo_project_workspaces WHERE alias = ?')
      .get(neokai) as { id: string };
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
    );
    expect(repo.listProjects()).toHaveLength(4);
    expect(
      db.prepare('SELECT project_id AS id FROM neo_project_workspaces WHERE alias = ?').get(neokai)
    ).toEqual(owner);
    expect(repo.projectMerges.redirects()).toEqual([]);
    full.close();
  });

  test('names a project once after its repository and never renames it', () => {
    const uuid = 'f793a97e-2b7e-4088-92a1-2506bde88670';
    const tree = (remotes?: string[]) => {
      const found = workspace(`/w/neokai/worktrees/${uuid}`, 'laptop', 'git:1');
      return [{ ...found, place: { ...found.place, name: uuid, remotes } }];
    };
    mirrorNeoWorkspaceProjects(db, tree());
    expect(repo.listProjects()).toEqual([]);
    mirrorNeoWorkspaceProjects(db, tree(['git@github.com:lsm/neokai.git']));
    expect(repo.listProjects().map((project) => project.title)).toEqual(['neokai']);
    mirrorNeoWorkspaceProjects(db, tree(['git@github.com:lsm/HyperNeo.git']));
    expect(repo.listProjects().map((project) => project.title)).toEqual(['neokai']);
    mirrorNeoWorkspaceProjects(db, tree(['git@github.com:lsm/open-agent-protocol.git']));
    expect(repo.listProjects().map((project) => project.title)).toEqual(['neokai']);
    const [named] = repo.listProjects();
    repo.saveProject({ ...named, title: 'My app' }, named.revision);
    mirrorNeoWorkspaceProjects(db, tree(['git@github.com:lsm/other.git']));
    expect(repo.listProjects().map((project) => project.title)).toEqual(['My app']);
  });

  test('does not let a reused folder collapse unrelated repository histories', () => {
    mirrorNeoWorkspaceProjects(
      db,
      mergePlaceGroups([workspace('/one', elsewhere, 'root:123', 'git@github.com:lsm/one.git')], 50)
    );
    mirrorNeoWorkspaceProjects(
      db,
      mergePlaceGroups([workspace('/one', elsewhere, 'root:456', 'git@github.com:lsm/two.git')], 50)
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
      mergePlaceGroups(
        [
          workspace('/one', elsewhere, 'root:123', 'git@github.com:lsm/one.git'),
          workspace('/other', elsewhere, 'root:456', 'git@github.com:lsm/two.git'),
        ],
        50
      )
    );
    mirrorNeoWorkspaceProjects(db, []);
    expect(repo.listProjects()).toHaveLength(3);
    expect(repo.getProject('travel')?.context).toBe('Passport');
  });

  test('a standalone repository project keeps its identity when a tool project also holds the repository', () => {
    const one = 'git@github.com:lsm/one.git';
    const owner = (alias: string) =>
      (
        db.prepare('SELECT project_id FROM neo_project_workspaces WHERE alias = ?').get(alias) as {
          project_id: string;
        } | null
      )?.project_id;
    mirrorNeoWorkspaceProjects(
      db,
      mergePlaceGroups([workspace('/solo', elsewhere, 'root:1', one)], 50)
    );
    const [standalone] = repo.listProjects();
    const product = [
      workspace('/p/one', elsewhere, 'root:1', one),
      workspace('/p/two', elsewhere, 'root:2', 'git@github.com:lsm/two.git'),
    ].map((group) => ({
      ...group,
      place: { ...group.place, toolProject: { id: 'product', name: 'Product' } },
    }));
    for (let pass = 0; pass < 2; pass++)
      mirrorNeoWorkspaceProjects(
        db,
        mergePlaceGroups([workspace('/solo', elsewhere, 'root:1', one), ...product], 50)
      );
    expect(repo.listProjects()).toHaveLength(2);
    expect(owner('repository:github.com/lsm/one')).toBe(standalone.id);
    expect(owner('repository:github.com/lsm/two')).not.toBe(standalone.id);
  });

  test('a clone outside the tool project joins the tool project holding its repository', () => {
    const one = 'git@github.com:lsm/one.git';
    const product = workspace('/p/one', elsewhere, 'root:1', one);
    mirrorNeoWorkspaceProjects(
      db,
      mergePlaceGroups(
        [{ ...product, place: { ...product.place, toolProject: { id: 'p', name: 'Product' } } }],
        50
      )
    );
    mirrorNeoWorkspaceProjects(
      db,
      mergePlaceGroups([workspace('/clone', elsewhere, 'root:1', one)], 50)
    );
    expect(repo.listProjects()).toHaveLength(1);
  });

  test('mirrors a named tool project spanning two repositories as one project', () => {
    const groups = [
      workspace('/one', elsewhere, 'root:123', 'git@github.com:lsm/one.git'),
      workspace('/other', elsewhere, 'root:456', 'git@github.com:lsm/two.git'),
    ].map((group) => ({
      ...group,
      place: { ...group.place, toolProject: { id: 'product', name: 'Product' } },
    }));
    mirrorNeoWorkspaceProjects(db, mergePlaceGroups(groups, 50));
    expect(repo.listProjects().map((project) => project.title)).toEqual(['Product']);
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
      expect(
        db.prepare("SELECT kind FROM neo_session_bindings WHERE session_id = 'holder'").get()
      ).toEqual({ kind: 'project' });
      expect(repo.getProject('old')?.context).toBe('Keep');
      expect(db.prepare('SELECT payload_json FROM neo_publications').get()).toEqual({
        payload_json: payload.replace('concern', 'project'),
      });
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

  test('gives a repository to its oldest project by the stored remote and merges nothing', async () => {
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
    const gone = save('001ce5d6-494e-4db1-9d65-0a8745ef4162', [
      'folder:tts\u0000/gone/001ce5d6',
      repoAlias('lsm/hyperneo', '/gone/001ce5d6'),
    ]);
    const shallow = save('3a4a1989-7093-4b8e-bb18-0248d528a9dd', [
      repoAlias('lsm/hyperneo', '/gone/3a4a1989'),
    ]);
    const other = save('makai', [repoAlias('lsm/makai', '/focus/makai')]);
    const bare = save('180460d2-753e-4418-91b9-6636a831c0c0', ['folder:laptop\u0000/w/180460d2']);
    expect(backfillNeoRepositoryIdentities(raw)).toBe(true);
    expect(
      store
        .listProjects()
        .map((project) => project.id)
        .sort()
    ).toEqual([bare, kept, other, gone, shallow].sort());
    expect(store.getProject(kept)?.title).toBe('neokai');
    expect(
      raw
        .prepare('SELECT project_id FROM neo_project_workspaces WHERE alias = ?')
        .get('repository:github.com/lsm/hyperneo')
    ).toEqual({ project_id: kept });
    expect(store.projectMerges.redirects()).toEqual([]);
    expect(backfillNeoRepositoryIdentities(raw)).toBe(false);
    full.close();
  });

  test('does not pull an old project into a new repository through a reused folder', async () => {
    const full = await createTestDb();
    const raw = full.getDatabase();
    const store = new NeoRepository(raw);
    const at = (root: string, remote?: string) => {
      const found = workspace('/w/app', 'laptop', `git:${root.repeat(40)}`);
      return [{ ...found, place: { ...found.place, remotes: remote ? [remote] : undefined } }];
    };
    mirrorNeoWorkspaceProjects(raw, at('a', 'git@github.com:lsm/old.git'));
    const old = store.listProjects()[0]!.id;
    const other = workspace('/w/other', 'laptop', `git:${'b'.repeat(40)}`);
    mirrorNeoWorkspaceProjects(raw, [
      { ...other, place: { ...other.place, remotes: ['git@github.com:lsm/new.git'] } },
    ]);
    mirrorNeoWorkspaceProjects(raw, at('b', 'git@github.com:lsm/new.git'));
    expect(store.listProjects().map((project) => project.id)).toContain(old);
    expect(store.projectMerges.redirects()).toEqual([]);
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

describe('neoIdentityOwner', () => {
  test('a standalone project owns a repository over a tool project, which owns it otherwise', () => {
    const tool = (id: string) => id.startsWith('tool');
    expect(neoIdentityOwner('tool-a', ['tool-a', 'solo'], tool)).toBe('solo');
    expect(neoIdentityOwner('solo', ['tool-a', 'other'], tool)).toBe('solo');
    expect(neoIdentityOwner('tool-a', ['tool-a', 'tool-b'], tool)).toBe('tool-a');
    expect(neoIdentityOwner(null, ['tool-b'], tool)).toBe('tool-b');
    expect(neoIdentityOwner(null, [], tool)).toBeNull();
  });
});
