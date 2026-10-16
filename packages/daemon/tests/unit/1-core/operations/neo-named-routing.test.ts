import { describe, expect, mock, test } from 'bun:test';
import {
  readNeoNamedProjectFacts,
  selectNeoNamedRouteFacts,
} from '../../../../src/lib/neo/named-route-facts.ts';
import { readNeoNamedRepositoryFacts } from '../../../../src/lib/neo/packs/coding/route-repository.ts';
import { chooseNeoRoute, type NeoHolder } from '../../../../src/lib/neo/router.ts';

const coding: NeoHolder = {
  projectId: 'coding',
  sessionId: 'coding-session',
  title: 'Build tools',
  summary: '',
  repository: 'lsm/HyperNeo',
};
const review: NeoHolder = {
  projectId: 'review',
  sessionId: 'review-session',
  title: 'HyperNeo Review',
  summary: '',
};
const other: NeoHolder = {
  projectId: 'club',
  sessionId: 'club-session',
  title: 'Book Club',
  summary: '',
};
const projects = [coding, review, other];

describe('readNeoNamedProjectFacts', () => {
  test.each(['Book Club', 'book club', 'club', '关于Book Club的安排'])(
    'recognizes an exact project identity in %s',
    (text) => {
      expect(
        selectNeoNamedRouteFacts(readNeoNamedProjectFacts(text, projects)).map(
          (fact) => fact.projectId
        )
      ).toEqual(['club']);
    }
  );
  test.each(['clubhouse', 'Book Clubs', '/club/path', 'coding-more'])(
    'does not turn a name fragment into a project identity: %s',
    (text) => {
      expect(selectNeoNamedRouteFacts(readNeoNamedProjectFacts(text, projects))).toEqual([]);
    }
  );
  test('escapes punctuation in names', () => {
    const matches = readNeoNamedProjectFacts('Use R&D [neo].', [
      { projectId: 'id', title: 'R&D [neo]' },
    ]);
    expect(selectNeoNamedRouteFacts(matches)).toEqual([
      { projectId: 'id', reference: 'R&D [neo]' },
    ]);
  });
});

describe('readNeoNamedRepositoryFacts', () => {
  test.each([
    'HyperNeo',
    'LSM/HYPERNEO',
    'https://github.com/lsm/HyperNeo',
    'github.com/lsm/HyperNeo',
    'git@github.com:lsm/HyperNeo.git',
  ])('recognizes a known repository in %s', (text) => {
    expect(selectNeoNamedRouteFacts(readNeoNamedRepositoryFacts(text, projects))).toEqual([
      { reference: text, projectId: 'coding', projectOnly: true },
    ]);
  });
  test.each([
    'HyperNeox',
    'other/HyperNeo',
    'lsm/HyperNeo#7',
    'https://github.com/lsm/HyperNeo/pull/7',
    '/HyperNeo/file',
  ])('leaves fragments and issue ownership to the existing reference reader: %s', (text) => {
    expect(selectNeoNamedRouteFacts(readNeoNamedRepositoryFacts(text, projects))).toEqual([]);
  });
});

describe('selectNeoNamedRouteFacts', () => {
  test('an explicit longer project name wins over an embedded repository name', () => {
    const named = (text: string) => [
      ...readNeoNamedProjectFacts(text, projects),
      ...readNeoNamedRepositoryFacts(text, projects),
    ];
    expect(selectNeoNamedRouteFacts(named('Work on HyperNeo Review'))).toEqual([
      { reference: 'HyperNeo Review', projectId: 'review' },
    ]);
    expect(
      selectNeoNamedRouteFacts(named('Compare HyperNeo and HyperNeo Review'))
        .map((fact) => fact.projectId)
        .sort()
    ).toEqual(['coding', 'review']);
  });
  test('retains ambiguous names as competing ownership facts', () => {
    const shared = projects.map((project) => ({ ...project, title: 'Shared' }));
    expect(selectNeoNamedRouteFacts(readNeoNamedProjectFacts('Shared', shared))).toHaveLength(3);
  });
});

describe('chooseNeoRoute explicit identity', () => {
  const deps = () => ({
    holders: () => projects,
    recentTurns: () => [],
    projectTurns: () => [],
    recentAsks: () => [],
    embed: mock(async () => new Float32Array([1, 0])),
    classify: mock(async () => ({
      decision: other,
      confidence: 1,
      basis: 'continues_turn' as const,
    })),
  });
  test.each(['lsm/HyperNeo', 'HyperNeo', 'Build tools', 'coding', 'HyperNeo Review'])(
    'routes %s ahead of conversational affinity and embeddings',
    async (text) => {
      const runtime = deps();
      const projectId = text === 'HyperNeo Review' ? 'review' : 'coding';
      expect((await chooseNeoRoute(text, runtime)).choice).toMatchObject({
        projectId,
        signal: 'facts',
        confidence: 1,
      });
      expect(runtime.embed).not.toHaveBeenCalled();
      expect(runtime.classify).not.toHaveBeenCalled();
    }
  );
  test('preserves exact record ownership ahead of incidental project words', async () => {
    expect(
      (
        await chooseNeoRoute('Book Club, inspect card-1', {
          ...deps(),
          facts: () => [{ reference: 'card-1', projectId: 'coding' }],
        })
      ).choice
    ).toMatchObject({ projectId: 'coding', signal: 'facts' });
  });
  test('keeps classifier affinity when no identity is named', async () => {
    const runtime = deps();
    expect((await chooseNeoRoute('How is it going?', runtime)).choice).toMatchObject({
      projectId: 'club',
      signal: 'classifier:continues_turn',
    });
    expect(runtime.classify).toHaveBeenCalledTimes(1);
  });
  test('several explicit owners stay at root without guessing from affinity', async () => {
    const runtime = deps();
    expect(await chooseNeoRoute('Book Club and lsm/HyperNeo', runtime)).toEqual({
      choice: null,
      fallback: 'facts:cross_project',
    });
    expect(runtime.classify).not.toHaveBeenCalled();
  });
});
