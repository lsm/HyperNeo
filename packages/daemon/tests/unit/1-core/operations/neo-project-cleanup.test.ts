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
  work: [],
  liveWork: 0,
  routed: 0,
  holderMessages: 0,
  archived: false,
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
const oneOff = {
  asks: 1,
  work: [
    { lastActivityAt: DAY, ref: null },
    { lastActivityAt: DAY + 60_000, ref: null },
  ],
};

describe('project cleanup plan', () => {
  test('an empty project with a silent holder is deleted unless the mirror would create it again', () => {
    expect(plan([project('empty')])).toEqual([
      { action: 'delete', projectId: 'empty', title: 'empty' },
    ]);
    expect(
      plan(
        [
          project('spoke', { holderMessages: 1, routed: 1 }),
          project('driven', { aliases: ['folder:here\u0000/kept'] }),
        ],
        [],
        ['folder:here\u0000/kept']
      )
    ).toEqual([]);
  });

  test('a repository project is left to the mirror: never deleted, merged or archived here', () => {
    expect(plan([project('alone', { aliases: [repo] })])).toEqual([]);
  });

  test('a project with no repository merges into the repository project with its title', () => {
    const home = project('home', { title: 'App', createdAt: 5, aliases: [repo] });
    expect(plan([home, project('titled', { title: ' app ', ...oneOff })])).toEqual([
      { action: 'merge', projectId: 'titled', title: ' app ', targetId: 'home' },
    ]);
  });

  test('a project with no repository merges where most of its cards ran, before any title match', () => {
    const card = (ref: string) => ({ lastActivityAt: DAY, ref });
    const ios = project('ios', { createdAt: 2, aliases: [repo, 'work:here\u0000claude\u0000s1'] });
    const web = project('web', {
      title: 'Topic',
      aliases: [
        'repository:github.com/lsm/web',
        'work:here\u0000claude\u0000s2',
        'work:here\u0000claude\u0000s3',
      ],
    });
    expect(
      plan([
        ios,
        web,
        project('topic', {
          title: 'Topic',
          asks: 1,
          routed: 1,
          work: [card('claude\u0000s1'), card('claude\u0000s1')],
        }),
      ])
    ).toEqual([{ action: 'merge', projectId: 'topic', title: 'Topic', targetId: 'ios' }]);
  });

  test('a one-off project with no repository and no home is archived; ongoing work, no work, or another machine is kept', () => {
    expect(plan([project('once', oneOff)])).toEqual([
      { action: 'archive', projectId: 'once', title: 'once' },
    ]);
    expect(
      plan([
        project('notes', { context: 10, holderMessages: 4 }),
        project('host', { ...oneOff, aliases: ['folder:here2\u0000/x'] }),
      ])
    ).toEqual([]);
    const twoDays = {
      asks: 1,
      work: [
        { lastActivityAt: DAY, ref: null },
        { lastActivityAt: 3 * DAY, ref: null },
      ],
    };
    expect(plan([project('days', twoDays), project('addressed', { asks: 1, routed: 1 })])).toEqual(
      []
    );
  });

  test('another machine is no home', () => {
    expect(
      plan([
        project('away', { title: 'App', aliases: [repo, 'folder:tts\u0000/app'] }),
        project('topic', { title: 'App', ...oneOff }),
      ])
    ).toEqual([{ action: 'archive', projectId: 'topic', title: 'App' }]);
  });

  test('a project the human asked to archive is archived, even with a repository', () => {
    expect(
      planNeoProjectCleanup([project('kept', { aliases: [repo], asks: 1 })], {
        pinned: new Set(),
        machine: 'here',
        mirrored: new Set(),
        archive: new Set(['kept']),
      })
    ).toEqual([{ action: 'archive', projectId: 'kept', title: 'kept' }]);
  });

  test('live, section, already archived, pinned and other-machine projects are left alone', () => {
    expect(
      plan(
        [
          project('live', { ...oneOff, liveAsks: 1 }),
          project('section', { section: true }),
          project('archived', { ...oneOff, archived: true }),
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
      work: [],
      routed: 0,
      holderMessages: 0,
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

  test('deleteEmptyProject removes an empty project with its binding and aliases, and refuses one with content', () => {
    repo.saveProject({ id: 'empty', title: 'Empty', summary: '', context: '' }, 0);
    repo.saveProject({ id: 'full', title: 'Full', summary: '', context: 'notes' }, 0);
    const raw = db.getDatabase();
    raw
      .prepare(
        "INSERT INTO neo_session_bindings (session_id, concern_id, kind) VALUES ('holder', 'empty', 'project')"
      )
      .run();
    raw
      .prepare(
        "INSERT INTO neo_project_workspaces (alias, project_id) VALUES ('folder:here', 'empty')"
      )
      .run();
    expect(repo.deleteEmptyProject('empty')).toBe('holder');
    expect(repo.getProject('empty')).toBeNull();
    expect(repo.getBindingForProject('empty')).toBeNull();
    expect(raw.prepare('SELECT count(*) AS n FROM neo_project_workspaces').get()).toEqual({ n: 0 });
    expect(() => repo.deleteEmptyProject('full')).toThrow('the project is no longer empty');
    expect(repo.getProject('full')).not.toBeNull();
  });
});

describe('neoMirroredAliases', () => {
  test('holds the aliases of places the mirror would make a project for: repositories and ongoing folders', () => {
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
    expect(aliases.some((alias) => alias.includes('/ongoing'))).toBe(true);
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
  test('delete drops the empty project then its holder; merge is human-approved; archive archives the holder', async () => {
    const calls: unknown[] = [];
    const project = (id: string) => ({ id, revision: 3 });
    const apply = createNeoProjectCleanupApply({
      repo: {
        deleteEmptyProject: (id: string) => (calls.push(['dropped', id]), 'holder:a'),
        getBindingForProject: (id: string) => ({ sessionId: `holder:${id}` }),
        getProject: project,
        projectMerges: {
          merge: (input: unknown) => (calls.push(['merge', input]), { ok: true }),
        },
      },
      sessions: {
        deleteSessionResources: async (id: string, trigger: string) => {
          calls.push(['deleted', id, trigger]);
        },
        archiveSessionResources: async (id: string, trigger: string) => {
          calls.push(['archived', id, trigger]);
        },
      },
    } as never);
    await apply({ action: 'delete', projectId: 'a', title: 'A' });
    await apply({ action: 'merge', projectId: 'b', title: 'B', targetId: 'c' });
    await apply({ action: 'archive', projectId: 'd', title: 'D' });
    expect(calls).toEqual([
      ['dropped', 'a'],
      ['deleted', 'holder:a', 'ui_session_delete'],
      [
        'merge',
        {
          sourceId: 'b',
          targetId: 'c',
          sourceRevision: 3,
          targetRevision: 3,
          sourceIdentities: [],
          targetIdentities: [],
          humanApproved: true,
        },
      ],
      ['archived', 'holder:d', 'ui_session_archive'],
    ]);
  });
});
