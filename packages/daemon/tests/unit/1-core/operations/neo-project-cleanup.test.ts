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
const oneOff = { asks: 1, work: [{ lastActivityAt: DAY }, { lastActivityAt: DAY + 60_000 }] };

describe('planNeoProjectCleanup', () => {
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

  test('a one-off project with no repository and no home is archived; ongoing work is kept', () => {
    expect(plan([project('once', oneOff)])).toEqual([
      { action: 'archive', projectId: 'once', title: 'once' },
    ]);
    const twoDays = { asks: 1, work: [{ lastActivityAt: DAY }, { lastActivityAt: 3 * DAY }] };
    expect(plan([project('days', twoDays), project('addressed', { asks: 1, routed: 1 })])).toEqual(
      []
    );
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
