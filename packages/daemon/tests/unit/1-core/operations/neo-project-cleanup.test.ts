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
  holder: null,
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
const oneOff = { asks: 1, work: [{ ref: null }] };

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
    const card = (ref: string) => ({ ref });
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

  test('a project with no repository, content and no home is kept however little it was used', () => {
    expect(
      plan([
        project('once', oneOff),
        project('notes', { context: 10, holderMessages: 4 }),
        project('addressed', { asks: 1, routed: 1 }),
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

  test('a project the human asked to archive is archived, even with a repository', () => {
    expect(
      planNeoProjectCleanup(
        [project('kept', { aliases: [repo], asks: 1, holder: 'holder:kept' })],
        {
          pinned: new Set(),
          machine: 'here',
          mirrored: new Set(),
          archive: new Set(['kept']),
        }
      )
    ).toEqual([{ action: 'archive', projectId: 'kept', title: 'kept', sessionId: 'holder:kept' }]);
  });

  test('an archived or to-be-archived project is no merge home, and a live project is not archived even when asked', () => {
    expect(
      plan([
        project('home', { title: 'App', aliases: [repo], archived: true }),
        project('topic', { title: 'App', ...oneOff }),
      ])
    ).toEqual([]);
    expect(
      planNeoProjectCleanup([project('busy', { aliases: [repo], liveWork: 1 })], {
        pinned: new Set(),
        machine: 'here',
        mirrored: new Set(),
        archive: new Set(['busy']),
      })
    ).toEqual([]);
    expect(
      planNeoProjectCleanup(
        [
          project('home', { title: 'App', aliases: [repo], holder: 'holder:home' }),
          project('topic', { title: 'App', ...oneOff }),
        ],
        { pinned: new Set(), machine: 'here', mirrored: new Set(), archive: new Set(['home']) }
      )
    ).toEqual([{ action: 'archive', projectId: 'home', title: 'App', sessionId: 'holder:home' }]);
  });

  test('the holder of a merged project is dropped when it never spoke and archived when it has history; a busy one waits', () => {
    expect(
      planNeoProjectCleanup([], {
        pinned: new Set(),
        machine: 'here',
        mirrored: new Set(),
        retired: [
          { projectId: 'silent', title: 'Silent', sessionId: 's1', spoke: false },
          { projectId: 'talked', title: 'Talked', sessionId: 's2', spoke: true },
          { projectId: 'turning', title: 'Turning', sessionId: 's3', spoke: true },
        ],
        busy: new Set(['s3']),
      })
    ).toEqual([
      { action: 'drop', projectId: 'silent', title: 'Silent', sessionId: 's1' },
      { action: 'archive', projectId: 'talked', title: 'Talked', sessionId: 's2' },
    ]);
  });

  test('an empty project only on another machine is deleted, since the mirror ignores attached daemons', () => {
    expect(plan([project('remote', { aliases: ['folder:tts\u0000/x'] })])).toEqual([
      { action: 'delete', projectId: 'remote', title: 'remote' },
    ]);
  });

  test('a kept project whose holder never spoke has the holder dropped; the project stays', () => {
    expect(
      plan([
        project('quiet', { aliases: [repo], holder: 'h1' }),
        project('talked', {
          aliases: ['repository:github.com/lsm/x'],
          holder: 'h2',
          holderMessages: 3,
        }),
        project('empty', { holder: 'h3' }),
      ])
    ).toEqual([
      { action: 'drop', projectId: 'quiet', title: 'quiet', sessionId: 'h1' },
      { action: 'delete', projectId: 'empty', title: 'empty' },
    ]);
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

  test('retiredHolders lists merged projects whose holder session is not archived', () => {
    repo.saveProject({ id: 'gone', title: 'Gone', summary: '', context: '' }, 0);
    repo.saveProject({ id: 'done', title: 'Done', summary: '', context: '' }, 0);
    repo.saveProject({ id: 'home', title: 'Home', summary: '', context: '' }, 0);
    const raw = db.getDatabase();
    const session =
      raw.prepare(`INSERT INTO sessions (id, title, created_at, last_active_at, status, config, metadata)
      VALUES (?, 'holder', '2026-01-01', '2026-01-01', ?, '{}', '{}')`);
    session.run('s-gone', 'active');
    session.run('s-done', 'archived');
    const merge =
      raw.prepare(`INSERT INTO neo_project_merges (source_id, target_id, source_session_id, merged_at)
      VALUES (?, 'home', ?, 1)`);
    merge.run('gone', 's-gone');
    merge.run('done', 's-done');
    expect(repo.retiredHolders()).toEqual([
      { projectId: 'gone', title: 'Gone', sessionId: 's-gone', spoke: false },
    ]);
    expect(repo.sessionSpoke('s-gone')).toBe(false);
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
  test('delete drops the empty project then its holder; merge is human-approved; archive archives an idle holder; drop deletes a silent one', async () => {
    const calls: unknown[] = [];
    const project = (id: string) => ({ id, revision: 3 });
    const apply = createNeoProjectCleanupApply({
      repo: {
        deleteEmptyProject: (id: string) => (calls.push(['dropped', id]), 'holder:a'),
        sessionSpoke: (id: string) => id === 'spoke',
        unbindHolder: (id: string) => calls.push(['unbound', id]),
        getProject: project,
        projectMerges: {
          merge: (input: unknown) => (calls.push(['merge', input]), { ok: true }),
        },
      },
      sessions: {
        deleteSessionResources: async (id: string, trigger: string) => {
          calls.push(['deleted', id, trigger]);
        },
        getCachedSession: (id: string) =>
          id === 'holder:busy'
            ? { getProcessingState: () => ({ status: 'processing' }) }
            : undefined,
        archiveSessionResources: async (id: string, trigger: string) => {
          calls.push(['archived', id, trigger]);
        },
      },
    } as never);
    await apply({ action: 'delete', projectId: 'a', title: 'A' });
    await apply({ action: 'merge', projectId: 'b', title: 'B', targetId: 'c' });
    await apply({ action: 'archive', projectId: 'd', title: 'D', sessionId: 'holder:d' });
    await expect(
      apply({ action: 'archive', projectId: 'busy', title: 'Busy', sessionId: 'holder:busy' })
    ).rejects.toThrow('the holder is mid-turn');
    await apply({ action: 'drop', projectId: 'e', title: 'E', sessionId: 'silent' });
    await expect(
      apply({ action: 'drop', projectId: 'f', title: 'F', sessionId: 'spoke' })
    ).rejects.toThrow('the holder has spoken');
    await expect(
      apply({ action: 'drop', projectId: 'g', title: 'G', sessionId: 'holder:busy' })
    ).rejects.toThrow('the holder is mid-turn');
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
      ['deleted', 'silent', 'ui_session_delete'],
      ['unbound', 'silent'],
    ]);
  });
});
