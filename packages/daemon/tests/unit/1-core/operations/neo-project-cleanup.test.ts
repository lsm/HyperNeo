import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  type NeoProjectFacts,
  planNeoProjectCleanup,
} from '../../../../src/lib/neo/project-cleanup.ts';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository.ts';
import { createTestDb } from '../../../helpers/database.ts';

const now = 1_800_000_000_000;
const NEO_PROJECT_ARCHIVE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
const project = (id: string, overrides: Partial<NeoProjectFacts> = {}): NeoProjectFacts => ({
  id,
  title: id,
  createdAt: 1,
  lastActivity: now,
  section: false,
  context: 0,
  asks: 0,
  liveAsks: 0,
  work: 0,
  liveWork: 0,
  routed: 0,
  workspaces: [],
  ...overrides,
});
const plan = (projects: NeoProjectFacts[], pinned: string[] = []) =>
  planNeoProjectCleanup(projects, now, new Set(pinned));

describe('planNeoProjectCleanup', () => {
  test('an empty project is deleted', () => {
    expect(plan([project('empty')])).toEqual([
      { action: 'delete', projectId: 'empty', title: 'empty' },
    ]);
  });

  test('saved context, an ask, work, a routed message or children keep a project from deletion', () => {
    for (const filled of [
      { context: 10 },
      { asks: 1 },
      { work: 1 },
      { routed: 1 },
      { section: true },
    ])
      expect(plan([project('p', filled)])).toEqual([]);
  });

  test('a same-title or same-workspace duplicate with content merges into the older one', () => {
    const older = project('old', { title: 'App', createdAt: 1, asks: 1 });
    const sameTitle = project('new', { title: ' app ', createdAt: 2, routed: 1 });
    const sameFolder = project('folder', {
      title: 'Other',
      createdAt: 3,
      work: 1,
      workspaces: ['/code/app'],
    });
    expect(plan([older, sameTitle, sameFolder])).toEqual([
      { action: 'merge', projectId: 'new', title: ' app ', targetId: 'old' },
    ]);
    expect(
      plan([{ ...older, workspaces: ['/code/app'] }, sameTitle, sameFolder]).map(
        (step) => 'targetId' in step && step.targetId
      )
    ).toEqual(['old', 'old']);
  });

  test('a project with live asks or work is never merged or archived', () => {
    const older = project('old', { title: 'App', asks: 1 });
    expect(
      plan([older, project('new', { title: 'App', createdAt: 2, asks: 1, liveAsks: 1 })])
    ).toEqual([]);
    expect(plan([project('idle', { work: 1, liveWork: 1, lastActivity: 0 })])).toEqual([]);
  });

  test('an idle project with content is archived once untouched past the limit', () => {
    const idle = (lastActivity: number) => project('idle', { asks: 1, lastActivity });
    expect(plan([idle(now - NEO_PROJECT_ARCHIVE_AFTER_MS - 1)])).toEqual([
      { action: 'archive', projectId: 'idle', title: 'idle' },
    ]);
    expect(plan([idle(now - NEO_PROJECT_ARCHIVE_AFTER_MS + 1)])).toEqual([]);
  });

  test('a pinned project such as the inbox is left alone', () => {
    expect(plan([project('inbox')], ['inbox'])).toEqual([]);
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
      work: 0,
      routed: 0,
      workspaces: [],
    });
    expect(planNeoProjectCleanup([...facts.values()], Date.now(), new Set())).toEqual([
      { action: 'delete', projectId: 'child', title: 'Child' },
    ]);
  });
});
