import { createFindWorkOperation } from '../../../../src/lib/drivers/find-operation.ts';
import { createOperationRegistry } from '../../../../src/lib/operations/registry.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createNeoTables } from '../../../../src/storage/schema/neo.ts';
import { runMigration361 } from '../../../../src/storage/schema/m361-neo-project-avatars.ts';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository.ts';
import {
  isNeoPlumbingFolder,
  mirrorNeoWorkspaceProjects,
  planNeoWorkspaceProjects,
} from '../../../../src/lib/neo/project-mirror.ts';
import { mergePlaceGroups } from '../../../../src/lib/drivers/places.ts';
import type { PlaceGroup } from '../../../../src/lib/drivers/types.ts';
import { isTempCwd } from '../../../../src/lib/drivers/claude-feed.ts';

function workspace(folder: string, machine = 'laptop', identity = 'root:123'): PlaceGroup {
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

  test('does not let a reused folder collapse unrelated repository histories', () => {
    mirrorNeoWorkspaceProjects(db, mergePlaceGroups([workspace('/one')], 50));
    mirrorNeoWorkspaceProjects(db, mergePlaceGroups([workspace('/one', 'laptop', 'root:456')], 50));
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
      mergePlaceGroups([workspace('/one'), workspace('/other', 'laptop', 'root:456')], 50)
    );
    mirrorNeoWorkspaceProjects(db, []);
    expect(repo.listProjects()).toHaveLength(3);
    expect(repo.getProject('travel')?.context).toBe('Passport');
  });

  test('mirrors several folders in a named tool project with different histories once', () => {
    const groups = [workspace('/one'), workspace('/other', 'laptop', 'root:456')].map((group) => ({
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

  test('keeps real folders here and never judges another machine', () => {
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
    expect(isNeoPlumbingFolder({ folder: '/tmp', machine: 'laptop', daemon: 'tts' }, local)).toBe(
      false
    );
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
    ).toEqual(['folder:laptop\u0000/repo']);
  });
});
