import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { neoProjectMoveReason, neoProjectPath } from '@hyperneo/shared/types/neo-project-tree';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createNeoTables } from '../../../../src/storage/schema/neo.ts';
import { runMigration361 } from '../../../../src/storage/schema/m361-neo-project-avatars.ts';
import { runMigration368 } from '../../../../src/storage/schema/m368-neo-project-tree.ts';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository.ts';
import {
  createNeoProjectTreeOperations,
  requireNeoTreeAuthor,
  requireNeoEpic,
} from '../../../../src/lib/neo/project-tree-operations.ts';
import {
  chooseNeoRoute,
  runnableNeoHolders,
  type NeoHolder,
  type NeoRouterDeps,
} from '../../../../src/lib/neo/router.ts';
import {
  createNeoSectionRefReader,
  refineNeoCoarseFacts,
  readNeoSectionFacts,
} from '../../../../src/lib/neo/section-route-facts.ts';
import type { NeoRefState } from '../../../../src/lib/neo/packs/coding/ask-prs.ts';

const local = { source: 'rpc' as const, principal: 'local' as const };
const epicUrl = 'https://github.com/lsm/hyperneo/issues/6756';
const epic: NeoRefState = {
  url: epicUrl,
  title: 'Neo projects',
  kind: 'issue',
  state: 'OPEN',
  at: null,
  done: false,
  closedBy: null,
};
let db: Database;
let repo: NeoRepository;
const save = (id: string) =>
  repo.saveProject({ id, title: id, summary: id, context: 'retained' }, 0)!;
beforeEach(() => {
  db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY)');
  createNeoTables(db);
  runMigration361(db);
  repo = new NeoRepository(db);
});
afterEach(() => db.close());

function workspace(id: string) {
  db.prepare('INSERT INTO neo_project_workspaces (alias, project_id) VALUES (?, ?)').run(
    'repo:lsm/hyperneo\u0000history',
    id
  );
}

describe('Neo project hierarchy', () => {
  test('paths have no depth cap and reject corrupt ancestry', () => {
    const tree = Array.from({ length: 80 }, (_, index) => ({
      id: String(index),
      parentId: index ? String(index - 1) : null,
    }));
    const before = structuredClone(tree);
    expect(neoProjectPath(tree, '79')).toHaveLength(80);
    expect(neoProjectMoveReason(tree, '0', '79')).toBe('project_cycle');
    expect(neoProjectMoveReason(tree, '79', '0')).toBeNull();
    expect(neoProjectMoveReason(tree, '0', 'missing')).toBe('unknown_or_invalid_parent');
    expect(
      neoProjectPath(
        [
          { id: 'a', parentId: 'b' },
          { id: 'b', parentId: 'a' },
        ],
        'a'
      )
    ).toEqual([]);
    expect(neoProjectPath([{ id: 'a', parentId: 'missing' }], 'a')).toEqual([]);
    expect(tree).toEqual(before);
  });

  test('moves preserve context, reject stale changes and cycles, and detach to root', () => {
    save('root');
    save('child');
    save('leaf');
    save('inbox');
    expect(repo.moveProject('child', 'root', 1)).toEqual({ ok: true });
    expect(repo.moveProject('leaf', 'child', 1)).toEqual({ ok: true });
    expect(repo.discardUnopenedProject('root')).toBe(false);
    const before = repo.listProjects();
    expect(repo.moveProject('root', 'leaf', 1)).toEqual({ ok: false, reason: 'project_cycle' });
    expect(repo.moveProject('child', null, 1)).toEqual({ ok: false, reason: 'superseded' });
    expect(repo.moveProject('inbox', 'root', 1)).toEqual({
      ok: false,
      reason: 'inbox_cannot_nest',
    });
    expect(repo.moveProject('root', 'missing', 1)).toEqual({
      ok: false,
      reason: 'unknown_or_invalid_parent',
    });
    expect(repo.listProjects()).toEqual(before);
    expect(repo.moveProject('child', null, 2)).toEqual({ ok: true });
    expect(repo.getProject('child')).toMatchObject({
      parentId: null,
      revision: 3,
      context: 'retained',
    });
    expect(repo.moveProject('child', null, 3)).toEqual({ ok: true });
    expect(repo.getProject('child')?.revision).toBe(3);
    expect(neoProjectPath(repo.listProjects(), 'leaf').map((item) => item.id)).toEqual([
      'child',
      'leaf',
    ]);
  });

  test('sections reuse the epic and inherit workspaces without duplicating aliases', () => {
    save('root');
    save('group');
    workspace('root');
    repo.moveProject('group', 'root', 1);
    const created = repo.createSection('group', epicUrl, 'Neo projects');
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(created.reason);
    expect(repo.createSection('group', epicUrl, 'Another title')).toEqual(created);
    expect(repo.workspaceAliases(created.projectId)).toEqual(repo.workspaceAliases('root'));
    expect(db.prepare('SELECT COUNT(*) AS n FROM neo_project_workspaces').get()).toEqual({ n: 1 });
    expect(repo.createSection('root', epicUrl, 'Duplicate')).toEqual({
      ok: false,
      reason: 'epic_already_has_section',
    });
    expect(repo.moveProject(created.projectId, null, 1)).toEqual({
      ok: false,
      reason: 'section_needs_parent',
    });
    expect(repo.moveProject('group', null, 2)).toEqual({
      ok: false,
      reason: 'section_workspace_mismatch',
    });
    save('other');
    expect(repo.moveProject(created.projectId, 'other', 1)).toEqual({
      ok: false,
      reason: 'section_workspace_mismatch',
    });
    expect(repo.createSection('root', 'https://github.com/other/repo/issues/1', 'Other')).toEqual({
      ok: false,
      reason: 'section_workspace_mismatch',
    });
  });

  test('the migration preserves existing projects and runs repeatedly', () => {
    const old = new Database(':memory:');
    try {
      old.exec(
        "CREATE TABLE neo_concerns (id TEXT PRIMARY KEY, title TEXT); INSERT INTO neo_concerns VALUES ('old', 'Old')"
      );
      runMigration368(old);
      runMigration368(old);
      expect(old.prepare('SELECT * FROM neo_concerns').get()).toEqual({
        id: 'old',
        title: 'Old',
        parent_id: null,
        epic_url: null,
      });
    } finally {
      old.close();
    }
  });

  test('authorization rejects holders before external reads or writes', async () => {
    save('root');
    save('child');
    workspace('root');
    repo.reserveBinding({ kind: 'project', projectId: 'child', sessionId: 'holder' });
    const read = mock(async () => [epic]);
    const [move, section] = createNeoProjectTreeOperations(repo, read);
    const caller = { source: 'mcp' as const, sessionId: 'holder' };
    expect(
      await move.execute({ id: 'child', parentId: 'root', expectedRevision: 1 }, caller)
    ).toEqual({ ok: false, reason: 'root_or_human_only' });
    expect(await section.execute({ parentId: 'root', epicUrl }, caller)).toEqual({
      ok: false,
      reason: 'root_or_human_only',
    });
    expect(read).not.toHaveBeenCalled();
    expect(repo.getProject('child')?.parentId).toBeNull();
    expect(requireNeoTreeAuthor(local, null)).toEqual({ value: true });
    expect(requireNeoTreeAuthor({ source: 'mcp' }, null)).toMatchObject({ reason: { ok: false } });
    expect(requireNeoEpic([], epicUrl)).toEqual({
      reason: { ok: false, reason: 'epic_unavailable' },
    });
    expect(
      await move.execute({ id: 'child', parentId: 'root', expectedRevision: 1 }, local)
    ).toEqual({ ok: true });
    const created = await section.execute({ parentId: 'root', epicUrl }, local);
    expect(created.ok).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
    const before = repo.listProjects();
    expect(
      await section.execute({ parentId: 'root', epicUrl: 'https://example.com/issues/1' }, local)
    ).toEqual({ ok: false, reason: 'invalid_epic_url' });
    expect(repo.listProjects()).toEqual(before);
  });

  test('section creation normalizes HTTP epic URLs and reuses their HTTPS identity', async () => {
    save('root');
    workspace('root');
    const read = mock(async () => [
      { ...epic, url: 'https://github.com/lsm/HyperNeo/issues/6756' },
    ]);
    const [, section] = createNeoProjectTreeOperations(repo, read);
    const result = await section.execute(
      { parentId: 'root', epicUrl: 'http://github.com/LSM/HyperNeo/issues/6756/' },
      local
    );
    if (!result.ok) throw new Error(result.reason);
    expect(repo.getProject(result.projectId)?.epicUrl).toBe(epicUrl);
    expect(read).toHaveBeenCalledWith([{ owner: 'lsm', repo: 'hyperneo', number: 6756 }]);
    expect(await section.execute({ parentId: 'root', epicUrl }, local)).toEqual(result);
    expect(repo.listProjects()).toHaveLength(2);
  });

  test('section creation rejects invalid parents before reading GitHub', async () => {
    save('inbox');
    const read = mock(async () => [epic]);
    const [, section] = createNeoProjectTreeOperations(repo, read);
    const before = repo.listProjects();
    for (const parentId of ['missing', 'inbox'])
      expect(await section.execute({ parentId, epicUrl }, local)).toEqual({
        ok: false,
        reason: 'unknown_parent',
      });
    expect(read).not.toHaveBeenCalled();
    expect(repo.listProjects()).toEqual(before);
  });
});

const holder = (id: string, parentId: string | null = null): NeoHolder => ({
  projectId: id,
  parentId,
  sessionId: `session:${id}`,
  title: id,
  summary: id,
});
const routeDeps = (holders: NeoHolder[]): NeoRouterDeps => ({
  holders: () => holders,
  recentTurns: () => [],
  projectTurns: () => [],
  recentAsks: () => [],
  embed: async () => null,
});

describe('hierarchical Neo routing', () => {
  test('classification sees one level at a time, can stay at a parent, and never creates levels', async () => {
    const holders = [
      holder('product'),
      holder('repo', 'product'),
      holder('section', 'repo'),
      holder('other'),
    ];
    const levels: string[][] = [];
    const deps = {
      ...routeDeps(holders),
      classify: mock(async (_text: string, choices: readonly NeoHolder[]) => {
        levels.push(choices.map((choice) => choice.projectId));
        return choices.find(
          (choice) => choice.projectId === ['product', 'repo', 'section'][levels.length - 1]
        )!;
      }),
    };
    expect((await chooseNeoRoute('Implement this task', deps)).choice?.projectId).toBe('section');
    expect(levels).toEqual([
      ['product', 'other'],
      ['product', 'repo'],
      ['repo', 'section'],
    ]);
    expect(holders).toHaveLength(4);
    expect(
      (
        await chooseNeoRoute('Keep it broad', {
          ...routeDeps(holders),
          classify: async () => holders[0],
        })
      ).choice?.projectId
    ).toBe('product');
  });

  test('workspace facts select the project before text descends into its sections', async () => {
    const holders = [
      holder('repo'),
      holder('section', 'repo'),
      holder('subsection', 'section'),
      holder('other'),
    ];
    const choices: string[][] = [];
    const result = await chooseNeoRoute('this folder needs subsection work', {
      ...routeDeps(holders),
      facts: () => [{ reference: '/repo', projectId: 'repo', projectOnly: true }],
      classify: async (_text, options) => {
        choices.push(options.map((option) => option.projectId));
        return options.find(
          (option) => option.projectId === (choices.length === 1 ? 'section' : 'subsection')
        )!;
      },
    });
    expect(result.choice?.projectId).toBe('subsection');
    expect(choices).toEqual([
      ['repo', 'section'],
      ['section', 'subsection'],
    ]);
  });

  test('facts descend arbitrary depth and cross-owner messages pick no project', async () => {
    const holders = Array.from({ length: 40 }, (_, index) =>
      holder(String(index), index ? String(index - 1) : null)
    );
    const classify = mock(async () => null);
    const deps = {
      ...routeDeps(holders),
      classify,
      facts: () => [{ reference: 'ask', projectId: '39' }],
    };
    expect((await chooseNeoRoute('ask', deps)).choice?.projectId).toBe('39');
    expect(classify).not.toHaveBeenCalled();
    expect(
      await chooseNeoRoute('two asks', {
        ...deps,
        facts: () => [
          { reference: 'a', projectId: '1' },
          { reference: 'b', projectId: '39' },
        ],
      })
    ).toEqual({ choice: null, fallback: 'facts:cross_project' });
  });

  test('exact fact owners remain authoritative when an ancestor provider is unavailable', async () => {
    const tree = [holder('root'), holder('middle', 'root'), holder('owner', 'middle')];
    const classify = mock(async () => null);
    for (const unavailable of ['root', 'middle']) {
      const holders = runnableNeoHolders(
        tree.map((item) => ({
          ...item,
          provider: item.projectId === unavailable ? 'offline' : 'anthropic',
        })),
        new Map([['offline', false]])
      );
      expect(
        await chooseNeoRoute('existing ask', {
          ...routeDeps(holders),
          classify,
          facts: () => [{ reference: 'ask', projectId: 'owner' }],
        })
      ).toEqual({
        choice: { projectId: 'owner', sessionId: 'session:owner', signal: 'facts', confidence: 1 },
      });
    }
    expect(classify).not.toHaveBeenCalled();
    expect(
      await chooseNeoRoute('unavailable owner', {
        ...routeDeps([tree[0], tree[1]]),
        facts: () => [{ reference: 'ask', projectId: 'owner' }],
      })
    ).toEqual({ choice: null, fallback: 'facts:root' });
  });

  test('workspace facts still descend within their owner when its ancestor is unavailable', async () => {
    const holders = [holder('repo', 'unavailable'), holder('section', 'repo')];
    expect(
      (
        await chooseNeoRoute('folder section work', {
          ...routeDeps(holders),
          facts: () => [{ reference: '/repo', projectId: 'repo', projectOnly: true }],
          classify: async () => holders[1],
        })
      ).choice?.projectId
    ).toBe('section');
  });

  test('coarse workspace and repository facts follow a refined section on the same path', async () => {
    save('root');
    workspace('root');
    const section = repo.createSection('root', epicUrl, 'Neo');
    if (!section.ok) throw new Error(section.reason);
    const childUrl = 'https://github.com/lsm/hyperneo/issues/6761';
    const otherUrl = 'https://github.com/lsm/hyperneo/issues/7000';
    const facts = ['/repo', 'work:123', childUrl, otherUrl].map((reference) => ({
      reference,
      projectId: 'root',
      projectOnly: true as const,
    }));
    const refined = await readNeoSectionFacts(
      `${childUrl} ${otherUrl} /repo work:123`,
      facts,
      repo.listProjects(),
      async ([ref]) => [
        { ...epic, url: childUrl, parent: ref.number === 6761 ? { url: epicUrl, at: 1 } : null },
      ]
    );
    expect(refined.map((fact) => fact.projectId)).toEqual(Array(4).fill(section.projectId));
    const classify = mock(async () => null);
    expect(
      (
        await chooseNeoRoute('same project message', {
          ...routeDeps([holder('root'), holder(section.projectId, 'root')]),
          facts: () => refined,
          classify,
        })
      ).choice?.projectId
    ).toBe(section.projectId);
    expect(classify).not.toHaveBeenCalled();
    expect(facts.every((fact) => fact.projectId === 'root')).toBe(true);
  });

  test('coarse refinement preserves distinct explicit owners, sibling sections and other projects', async () => {
    for (const id of ['root', 'a', 'b', 'other']) save(id);
    repo.moveProject('a', 'root', 1);
    repo.moveProject('b', 'root', 1);
    const projects = repo.listProjects();
    const holders = projects.map((project) => holder(project.id, project.parentId));
    for (const facts of [
      [
        { reference: 'ask-root', projectId: 'root' },
        { reference: 'ask-a', projectId: 'a' },
      ],
      [
        { reference: '/root', projectId: 'root', projectOnly: true as const },
        { reference: 'ask-a', projectId: 'a' },
        { reference: 'ask-b', projectId: 'b' },
      ],
      [
        { reference: '/other', projectId: 'other', projectOnly: true as const },
        { reference: 'ask-a', projectId: 'a' },
      ],
    ]) {
      const refined = refineNeoCoarseFacts(facts, projects);
      expect(refined).toEqual(facts);
      expect(
        await chooseNeoRoute('multiple owners', { ...routeDeps(holders), facts: () => refined })
      ).toEqual({ choice: null, fallback: 'facts:cross_project' });
    }
  });

  test('classification reaches descendants at the nearest runnable ancestor during outages', async () => {
    const tree = [
      holder('root'),
      holder('middle', 'root'),
      holder('leaf', 'middle'),
      holder('other'),
    ];
    const before = structuredClone(tree);
    for (const unavailable of [['middle'], ['root'], ['root', 'middle']]) {
      const holders = runnableNeoHolders(
        tree.map((item) => ({
          ...item,
          provider: unavailable.includes(item.projectId) ? 'offline' : 'anthropic',
        })),
        new Map([['offline', false]])
      );
      const levels: string[][] = [];
      expect(
        (
          await chooseNeoRoute('Implement this task', {
            ...routeDeps(holders),
            classify: async (_text, choices) => {
              levels.push(choices.map((choice) => choice.projectId));
              return (
                choices.find((choice) => choice.projectId === 'leaf') ??
                choices.find((choice) => choice.projectId === 'middle') ??
                choices.find((choice) => choice.projectId === 'root')!
              );
            },
          })
        ).choice?.projectId
      ).toBe('leaf');
      expect(levels).toEqual(
        unavailable.length === 2
          ? [['leaf', 'other']]
          : unavailable[0] === 'root'
            ? [
                ['middle', 'other'],
                ['middle', 'leaf'],
              ]
            : [
                ['root', 'other'],
                ['root', 'leaf'],
              ]
      );
    }
    expect(tree).toEqual(before);
  });

  test('unavailable workspace owners constrain classification to their runnable descendants', async () => {
    const holders = runnableNeoHolders(
      [{ ...holder('root'), provider: 'offline' }, holder('section', 'root'), holder('other')],
      new Map([['offline', false]])
    );
    const classify = mock(async (_text: string, choices: readonly NeoHolder[]) => {
      expect(choices.map((choice) => choice.projectId)).toEqual(['section']);
      return choices[0];
    });
    expect(
      (
        await chooseNeoRoute('workspace section work', {
          ...routeDeps(holders),
          facts: () => [{ reference: '/repo', projectId: 'root', projectOnly: true }],
          classify,
        })
      ).choice?.projectId
    ).toBe('section');
    expect(classify).toHaveBeenCalledTimes(1);
    expect(
      await chooseNeoRoute('root-owned ask', {
        ...routeDeps(holders),
        facts: () => [{ reference: 'ask', projectId: 'root' }],
        classify,
      })
    ).toEqual({ choice: null, fallback: 'facts:root' });
    expect(classify).toHaveBeenCalledTimes(1);
  });

  test('section lookups reuse concurrent issue reads and refresh changed ancestry after the TTL', async () => {
    save('root');
    workspace('root');
    const section = repo.createSection('root', epicUrl, 'Neo');
    if (!section.ok) throw new Error(section.reason);
    const text = 'https://github.com/lsm/hyperneo/issues/6761';
    const facts = [{ reference: text, projectId: 'root', projectOnly: true as const }];
    let now = 0;
    let parent: NeoRefState['parent'] = { url: epicUrl, at: 1 };
    const source = mock(async () => [{ ...epic, url: text, parent }]);
    const read = createNeoSectionRefReader(source, () => now);
    const lookup = () => readNeoSectionFacts(text, facts, repo.listProjects(), read);
    expect(await Promise.all([lookup(), lookup()])).toEqual([
      [{ reference: text, projectId: section.projectId }],
      [{ reference: text, projectId: section.projectId }],
    ]);
    parent = null;
    now = 29_999;
    expect(await lookup()).toEqual([{ reference: text, projectId: section.projectId }]);
    expect(source).toHaveBeenCalledTimes(1);
    now = 30_000;
    expect(await lookup()).toEqual(facts);
    expect(source).toHaveBeenCalledTimes(2);
  });

  test('link-heavy messages bound section reference lookups and preserve unexamined facts', async () => {
    save('root');
    workspace('root');
    const section = repo.createSection('root', epicUrl, 'Neo');
    if (!section.ok) throw new Error(section.reason);
    const urls = Array.from(
      { length: 25 },
      (_, i) => `https://github.com/lsm/hyperneo/issues/${7000 + i}`
    );
    const facts = urls.map((reference) => ({
      reference,
      projectId: 'root',
      projectOnly: true as const,
    }));
    const read = mock(async () => [epic]);
    expect(await readNeoSectionFacts(urls.join(' '), facts, repo.listProjects(), read)).toEqual(
      facts
    );
    expect(read).toHaveBeenCalledTimes(10);
  });

  test('issue ancestry refines repository facts without stealing another owner’s objects', async () => {
    save('root');
    workspace('root');
    const section = repo.createSection('root', epicUrl, 'Neo');
    if (!section.ok) throw new Error(section.reason);
    const text = 'https://github.com/lsm/hyperneo/issues/6761';
    const facts = [{ reference: text, projectId: 'root', projectOnly: true as const }];
    const read = mock(async () => [{ ...epic, url: text, parent: { url: epicUrl, at: 1 } }]);
    expect(await readNeoSectionFacts(text, facts, repo.listProjects(), read)).toEqual([
      { reference: text, projectId: section.projectId },
    ]);
    expect(
      await readNeoSectionFacts(
        'lsm/hyperneo#6756',
        [{ reference: 'lsm/hyperneo#6756', projectId: 'root', projectOnly: true }],
        repo.listProjects(),
        read
      )
    ).toEqual([{ reference: 'lsm/hyperneo#6756', projectId: section.projectId }]);
    expect(
      await readNeoSectionFacts(
        text,
        [{ reference: text, projectId: 'other' }],
        repo.listProjects(),
        read
      )
    ).toEqual([{ reference: text, projectId: 'other' }]);
    const owned = [{ reference: text, projectId: 'root' }];
    expect(await readNeoSectionFacts(text, owned, repo.listProjects(), read)).toEqual(owned);
    expect(await readNeoSectionFacts(text, facts, repo.listProjects(), async () => [])).toEqual(
      facts
    );
  });
});
