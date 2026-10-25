import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  type NeoProjectFacts,
  neoCleanupFolders,
  neoMirroredAliases,
  planNeoProjectCleanup,
} from '../../../../src/lib/neo/project-cleanup.ts';
import { createNeoProjectCleanupApply } from '../../../../src/lib/neo/project-cleanup-apply.ts';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository.ts';
import { createTestDb } from '../../../helpers/database.ts';

const DAY = 24 * 60 * 60 * 1000;
const project = (id: string, overrides: Partial<NeoProjectFacts> = {}): NeoProjectFacts => ({
  id,
  title: id,
  createdAt: 1,
  section: false,
  context: 0,
  asks: 0,
  liveAsks: 0,
  aliases: [],
  ...overrides,
});
const plan = (projects: NeoProjectFacts[], pinned: string[] = [], mirrored: string[] = []) =>
  planNeoProjectCleanup(projects, {
    pinned: new Set(pinned),
    machine: 'here',
    mirrored: new Set(mirrored),
  });
const repo = 'repository:github.com/lsm/app';
const oneOff = { asks: 1 };

describe('project cleanup plan', () => {
  test('an empty project is deleted unless the mirror would create it again', () => {
    expect(plan([project('empty')])).toEqual([
      { action: 'delete', projectId: 'empty', title: 'empty' },
    ]);
    expect(
      plan(
        [project('driven', { aliases: ['folder:here\u0000/kept'] })],
        [],
        ['folder:here\u0000/kept']
      )
    ).toEqual([]);
  });

  test('a repository project is left to the mirror: never deleted, merged or archived here', () => {
    expect(plan([project('alone', { aliases: [repo] })])).toEqual([]);
  });

  test('an empty project that names a repository is never deleted, so the PR ledger keeps reading it', () => {
    const named = project('named', { aliases: ['repo:lsm/app\u0000folder'] });
    expect(plan([named])).toEqual([]);
    expect(
      neoCleanupFolders([{ ...named, aliases: [...named.aliases, 'folder:here\u0000/e'] }], 'here')
    ).toEqual([]);
  });

  test('a project with no repository merges into the repository project with its title', () => {
    const home = project('home', { title: 'App', createdAt: 5, aliases: [repo] });
    expect(plan([home, project('titled', { title: ' app ', ...oneOff })])).toEqual([
      { action: 'merge', projectId: 'titled', title: ' app ', targetId: 'home' },
    ]);
  });

  test('a project with no repository, content and no home is kept however little it was used', () => {
    expect(
      plan([
        project('once', oneOff),
        project('notes', { context: 10 }),
        project('addressed', { asks: 1 }),
      ])
    ).toEqual([]);
  });

  test('another machine is no home', () => {
    expect(
      plan([
        project('away', { title: 'App', aliases: [repo, 'folder:tts\u0000/app'] }),
        project('topic', { title: 'App', ...oneOff }),
      ])
    ).toEqual([]);
  });

  test('an empty project only on another machine is deleted, since the mirror ignores attached daemons', () => {
    expect(plan([project('remote', { aliases: ['folder:tts\u0000/x'] })])).toEqual([
      { action: 'delete', projectId: 'remote', title: 'remote' },
    ]);
  });

  test('live, section, pinned and other-machine projects are left alone', () => {
    expect(
      plan(
        [
          project('live', { ...oneOff, liveAsks: 1 }),
          project('section', { section: true }),
          project('inbox'),
          project('remote', { ...oneOff, aliases: ['folder:tts\u0000/x'] }),
        ],
        ['inbox']
      )
    ).toEqual([]);
  });
});

describe('NeoRepository.projectCleanupFacts', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let repo: NeoRepository;
  beforeEach(async () => {
    db = await createTestDb();
    repo = new NeoRepository(db.getDatabase());
  });
  afterEach(() => db.close());

  test('reads what each project holds, and a parent counts as a section', () => {
    repo.saveProject({ id: 'parent', title: 'Parent', summary: '', context: 'notes' }, 0);
    repo.saveProject({ id: 'child', title: 'Child', summary: '', context: '' }, 0);
    db.getDatabase()
      .prepare("UPDATE neo_concerns SET parent_id = 'parent' WHERE id = 'child'")
      .run();
    const facts = new Map(repo.projectCleanupFacts().map((item) => [item.id, item]));
    expect(facts.get('parent')).toMatchObject({ section: true, context: 5, asks: 0 });
    expect(facts.get('child')).toMatchObject({
      section: false,
      context: 0,
      asks: 0,
      aliases: [],
    });
    expect(
      planNeoProjectCleanup([...facts.values()], {
        pinned: new Set(),
        machine: 'here',
        mirrored: new Set(),
      })
    ).toEqual([{ action: 'delete', projectId: 'child', title: 'Child' }]);
  });

  test('a project that holds asks is never empty, even when they are all settled', () => {
    repo.saveProject({ id: 'asked', title: 'Asked', summary: '', context: '' }, 0);
    db.getDatabase()
      .prepare(
        `INSERT INTO neo_asks (id, project_id, session_id, title, request, status, created_at, updated_at)
         VALUES ('ask-1', 'asked', 'neo:root', 'Fix it', 'Fix it', 'done', 1, 1)`
      )
      .run();
    const facts = repo.projectCleanupFacts();
    expect(facts.find((item) => item.id === 'asked')).toMatchObject({ asks: 1, liveAsks: 0 });
    expect(
      planNeoProjectCleanup(facts, { pinned: new Set(), machine: 'here', mirrored: new Set() })
    ).toEqual([]);
    expect(() => repo.deleteEmptyProject('asked')).toThrow('the project is no longer empty');
  });

  test('deleteEmptyProject removes an empty project with its aliases, and refuses one with content', () => {
    repo.saveProject({ id: 'empty', title: 'Empty', summary: '', context: '' }, 0);
    repo.saveProject({ id: 'full', title: 'Full', summary: '', context: 'notes' }, 0);
    const raw = db.getDatabase();
    raw
      .prepare(
        "INSERT INTO neo_project_workspaces (alias, project_id) VALUES ('folder:here', 'empty')"
      )
      .run();
    repo.deleteEmptyProject('empty');
    expect(repo.getProject('empty')).toBeNull();
    expect(raw.prepare('SELECT count(*) AS n FROM neo_project_workspaces').get()).toEqual({ n: 0 });
    expect(() => repo.deleteEmptyProject('full')).toThrow('the project is no longer empty');
    expect(repo.getProject('full')).not.toBeNull();
  });
});

describe('neoMirroredAliases', () => {
  test('holds only repository aliases: folders without a repository are never mirrored, even when ongoing', () => {
    const group = (folder: string, remotes?: string[], days: number[] = []) => ({
      place: { folder, machine: 'here', name: folder.slice(1), ...(remotes ? { remotes } : {}) },
      lastActivityAt: 0,
      openCount: 0,
      archivedCount: 0,
      adapters: ['hyperneo'],
      work: days.map((day, index) => ({
        ref: { adapter: 'hyperneo', id: `${folder}-${index}` },
        place: { folder, machine: 'here', name: folder.slice(1) },
        lastActivityAt: day * DAY,
      })),
    });
    const aliases = [
      ...neoMirroredAliases(
        [
          group('/repo', ['https://github.com/lsm/app.git']),
          group('/ongoing', undefined, [1, 3]),
          group('/once', undefined, [1, 1]),
        ] as never,
        () => false
      ),
    ];
    expect(aliases).toContain('repository:github.com/lsm/app');
    expect(aliases.some((alias) => alias.includes('/ongoing'))).toBe(false);
    expect(aliases.some((alias) => alias.includes('/once'))).toBe(false);
  });
});

describe('neoCleanupFolders', () => {
  test('lists the local folders of empty projects with no repository, the ones the keep test must read', () => {
    expect(
      neoCleanupFolders(
        [
          project('empty', { aliases: ['folder:here\u0000/a', 'folder:tts\u0000/b'] }),
          project('full', { asks: 1, aliases: ['folder:here\u0000/c'] }),
          project('repo', { aliases: [repo, 'folder:here\u0000/d'] }),
        ],
        'here'
      )
    ).toEqual(['/a']);
  });
});

describe('createNeoProjectCleanupApply', () => {
  test('delete drops the empty project; merge is human-approved', async () => {
    const db = await createTestDb();
    try {
      const repo = new NeoRepository(db.getDatabase());
      for (const id of ['a', 'b', 'c'])
        repo.saveProject({ id, title: id, summary: '', context: '' }, 0);
      const apply = createNeoProjectCleanupApply({ repo });
      await apply({ action: 'delete', projectId: 'a', title: 'A' });
      await apply({ action: 'merge', projectId: 'b', title: 'B', targetId: 'c' });
      expect(repo.getProject('a')).toBeNull();
      expect(repo.projectMerges.resolve('b')).toBe('c');
      expect(repo.getProject('c')?.revision).toBe(2);
    } finally {
      await db.close();
    }
  });
});
