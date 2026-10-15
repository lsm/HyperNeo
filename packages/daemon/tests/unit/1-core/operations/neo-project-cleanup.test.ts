import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  type NeoProjectFacts,
  planNeoProjectCleanup,
} from '../../../../src/lib/neo/project-cleanup.ts';
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
  aliases: [],
  ...overrides,
});
const plan = (projects: NeoProjectFacts[], pinned: string[] = []) =>
  planNeoProjectCleanup(projects, { pinned: new Set(pinned), machine: 'here' });
const repo = 'repository:github.com/lsm/app';
const oneOff = {
  asks: 1,
  work: [
    { lastActivityAt: DAY, ref: null },
    { lastActivityAt: DAY + 60_000, ref: null },
  ],
};

describe('project cleanup plan', () => {
  test('an empty project with a silent holder is deleted', () => {
    expect(plan([project('empty')])).toEqual([
      { action: 'delete', projectId: 'empty', title: 'empty' },
    ]);
    expect(plan([project('spoke', { holderMessages: 1, routed: 1 })])).toEqual([]);
  });

  test('a repository project is never deleted or archived, and duplicates merge into the oldest', () => {
    const oldest = project('old', { createdAt: 1, aliases: [repo] });
    const twin = project('twin', { createdAt: 2, ...oneOff, aliases: [repo] });
    expect(plan([twin, oldest])).toEqual([
      { action: 'merge', projectId: 'twin', title: 'twin', targetId: 'old' },
    ]);
    expect(plan([project('alone', { aliases: [repo] })])).toEqual([]);
  });

  test('a project with no repository merges into the repository project with its title or folder', () => {
    const home = project('home', {
      title: 'App',
      createdAt: 5,
      aliases: [repo, 'folder:here/app'],
    });
    expect(
      plan([
        home,
        project('titled', { title: ' app ', ...oneOff }),
        project('foldered', { title: 'Other', ...oneOff, aliases: ['folder:here/app'] }),
      ])
    ).toEqual([
      { action: 'merge', projectId: 'titled', title: ' app ', targetId: 'home' },
      { action: 'merge', projectId: 'foldered', title: 'Other', targetId: 'home' },
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

  test('a one-off project with no repository and no home is archived; ongoing work is kept', () => {
    expect(plan([project('once', oneOff)])).toEqual([
      { action: 'archive', projectId: 'once', title: 'once' },
    ]);
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

  test('a live or other-machine repository duplicate is not merged, and another machine is no home', () => {
    const oldest = project('old', { createdAt: 1, aliases: [repo] });
    expect(
      plan([
        oldest,
        project('live', { createdAt: 2, aliases: [repo], liveWork: 1 }),
        project('remote', { createdAt: 3, aliases: [repo, 'folder:tts/app'] }),
      ])
    ).toEqual([]);
    expect(
      plan([
        project('away', { title: 'App', aliases: [repo, 'folder:tts/app'] }),
        project('topic', { title: 'App', ...oneOff }),
      ])
    ).toEqual([{ action: 'archive', projectId: 'topic', title: 'App' }]);
  });

  test('live, section, pinned and other-machine projects are left alone', () => {
    expect(
      plan(
        [
          project('live', { ...oneOff, liveAsks: 1 }),
          project('section', { section: true }),
          project('inbox'),
          project('remote', { ...oneOff, aliases: ['folder:tts/x'] }),
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
      planNeoProjectCleanup([...facts.values()], { pinned: new Set(), machine: 'here' })
    ).toEqual([{ action: 'delete', projectId: 'child', title: 'Child' }]);
  });
});
