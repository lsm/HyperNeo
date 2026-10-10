import { describe, expect, test } from 'bun:test';
import {
  extractNeoWorkPrUrls,
  isNeoWorkPrWaiting,
  neoWorkPrSignature,
  countNeoWorkPrApprovals,
  planNeoWorkPrBlockers,
  planNeoWorkPrRefresh,
  readGithubPrs,
  requireNeoWorkPrDelivery,
  requireNeoWorkPrRefresh,
  shouldReadNeoWorkPrs,
  summarizeNeoWorkPr,
  wantsNeoWorkPrBlockers,
} from '../../../../src/lib/neo/work-prs.ts';
import type { NeoWorkPr } from '@hyperneo/shared/types/neo-snapshot';

const head = 'abc123';
const ghPr = (overrides: Record<string, unknown> = {}) => ({
  url: 'https://github.com/lsm/HyperNeo/pull/42',
  state: 'OPEN',
  headRefOid: head,
  reviews: [],
  statusCheckRollup: [],
  ...overrides,
});
const run = (status: string, conclusion = '') => ({ __typename: 'CheckRun', status, conclusion });
const pr: NeoWorkPr = {
  url: 'https://github.com/lsm/HyperNeo/pull/42',
  state: 'OPEN',
  checks: 'passing',
  review: 'none',
};

describe('extractNeoWorkPrUrls', () => {
  test('keeps each GitHub pull request link once', () => {
    expect(
      extractNeoWorkPrUrls(
        'Opened https://github.com/lsm/HyperNeo/pull/42 (see https://github.com/lsm/HyperNeo/pull/42/files) and https://github.com/lsm/neo-ios/pull/8.'
      )
    ).toEqual(['https://github.com/lsm/HyperNeo/pull/42', 'https://github.com/lsm/neo-ios/pull/8']);
    expect(extractNeoWorkPrUrls('No link here.')).toEqual([]);
    expect(extractNeoWorkPrUrls(null)).toEqual([]);
  });

  test('keeps the pull requests a card already tracks ahead of new links', () => {
    const tracked = [{ url: 'https://github.com/lsm/HyperNeo/pull/1' }];
    expect(
      extractNeoWorkPrUrls('Opened https://github.com/lsm/HyperNeo/pull/2 too.', tracked)
    ).toEqual(['https://github.com/lsm/HyperNeo/pull/1', 'https://github.com/lsm/HyperNeo/pull/2']);
  });
});

describe('summarizeNeoWorkPr', () => {
  test.each<[string, unknown[], NeoWorkPr['checks']]>([
    ['no checks', [], 'none'],
    ['a running check', [run('COMPLETED', 'SUCCESS'), run('IN_PROGRESS')], 'pending'],
    ['a failed check', [run('COMPLETED', 'SUCCESS'), run('COMPLETED', 'FAILURE')], 'failing'],
    [
      'passed and skipped checks',
      [run('COMPLETED', 'SUCCESS'), run('COMPLETED', 'SKIPPED')],
      'passing',
    ],
    ['a pending status', [{ __typename: 'StatusContext', state: 'PENDING' }], 'pending'],
    ['an errored status', [{ __typename: 'StatusContext', state: 'ERROR' }], 'failing'],
  ])('reads %s', (_case, statusCheckRollup, checks) => {
    expect(summarizeNeoWorkPr(ghPr({ statusCheckRollup }))?.checks).toBe(checks);
  });

  test.each<[string, unknown[], NeoWorkPr['review']]>([
    ['no review', [], 'none'],
    ['an approval of an older commit', [{ state: 'APPROVED', commit: { oid: 'old' } }], 'none'],
    ['a comment on the head', [{ state: 'COMMENTED', commit: { oid: head } }], 'none'],
    [
      'the latest verdict on the head',
      [
        { state: 'CHANGES_REQUESTED', commit: { oid: head } },
        { state: 'APPROVED', commit: { oid: head } },
      ],
      'approved',
    ],
    [
      'changes requested on the head',
      [{ state: 'CHANGES_REQUESTED', commit: { oid: head } }],
      'changes_requested',
    ],
  ])('reads %s', (_case, reviews, review) => {
    expect(summarizeNeoWorkPr(ghPr({ reviews }))?.review).toBe(review);
  });

  test('refuses a reply it cannot read', () => {
    expect(summarizeNeoWorkPr({ url: 'x' })).toBe(null);
  });
});

describe('planNeoWorkPrRefresh', () => {
  const at = (prs: NeoWorkPr[], delivered: string | null, readOkAt = 0) => ({
    prs,
    delivered,
    readAt: 0,
    readOkAt,
  });
  const halfHour = 30 * 60_000;

  test.each<
    [string, ReturnType<typeof at>, boolean, number, ReturnType<typeof planNeoWorkPrRefresh>]
  >([
    ['an open PR with running checks', at([{ ...pr, checks: 'pending' }], null), true, 0, 'wait'],
    [
      'a merged PR with leftover pending checks',
      at([{ ...pr, state: 'MERGED', checks: 'pending' }], null),
      true,
      0,
      'deliver',
    ],
    ['a state Neo has not seen', at([pr], null), true, 0, 'deliver'],
    ['the state Neo already saw', at([pr], neoWorkPrSignature([pr])), true, 0, 'unchanged'],
    [
      'a new review',
      at([{ ...pr, review: 'approved' }], neoWorkPrSignature([pr])),
      true,
      0,
      'deliver',
    ],
    [
      'a failed read soon after a good one',
      at([{ ...pr, checks: 'pending' }], null),
      false,
      halfHour - 1,
      'wait',
    ],
    [
      'reads failing for half an hour',
      at([{ ...pr, checks: 'pending' }], null),
      false,
      halfHour,
      'deliver',
    ],
    [
      'reads still failing after Neo was told',
      at([pr], neoWorkPrSignature([pr])),
      false,
      halfHour,
      'wait',
    ],
  ])('%s', (_case, row, read, now, plan) => {
    expect(planNeoWorkPrRefresh(row, read, now)).toBe(plan);
  });

  const ready: NeoWorkPr = { ...pr, state: 'OPEN', checks: 'passing', review: 'approved' };
  const seen = neoWorkPrSignature([ready]);
  const now = 10 * halfHour;
  const told: Parameters<typeof planNeoWorkPrRefresh>[0] = {
    ...at([ready], seen),
    deliveredAt: now - halfHour,
    reminded: null,
  };
  const quiet = { quietSince: now - halfHour, remindable: true };
  test.each<
    [
      string,
      typeof told,
      Parameters<typeof planNeoWorkPrRefresh>[3],
      ReturnType<typeof planNeoWorkPrRefresh>,
    ]
  >([
    ['an approved green PR left open for half an hour', told, quiet, 'remind'],
    [
      'one Neo was told about a minute ago',
      { ...told, deliveredAt: now - 60_000 },
      quiet,
      'unchanged',
    ],
    ['one whose session moved since', told, { ...quiet, quietSince: now - 60_000 }, 'unchanged'],
    ['one already reminded in this state', { ...told, reminded: seen }, quiet, 'unchanged'],
    [
      'one under an ask that is settled or waits on the human',
      told,
      { ...quiet, remindable: false },
      'unchanged',
    ],
    ['one told before delivery times were kept', { ...told, deliveredAt: null }, quiet, 'remind'],
    [
      'one still waiting for review',
      {
        ...told,
        prs: [{ ...ready, review: 'none' }],
        delivered: neoWorkPrSignature([{ ...ready, review: 'none' }]),
      },
      quiet,
      'unchanged',
    ],
  ])('%s', (_case, row, card, plan) => {
    expect(planNeoWorkPrRefresh(row, true, now, card)).toBe(plan);
  });
});

describe('isNeoWorkPrWaiting', () => {
  test('means an open PR still runs checks', () => {
    expect(isNeoWorkPrWaiting([{ ...pr, checks: 'pending' }])).toBe(true);
    expect(isNeoWorkPrWaiting([{ ...pr, state: 'MERGED', checks: 'pending' }])).toBe(false);
  });
});

describe('shouldReadNeoWorkPrs', () => {
  const stored = { prs: [pr], delivered: null, readAt: 0, readOkAt: 0 };
  const late = 2 * 60_000;

  test.each<[string, typeof stored | null, string[], number, boolean]>([
    ['a report with no links', null, [], late, false],
    ['a first report', null, [pr.url], 0, true],
    ['a new pull request', stored, [pr.url, 'https://github.com/lsm/HyperNeo/pull/7'], 0, true],
    ['an open PR read moments ago', stored, [pr.url], late - 1, false],
    ['an open PR read a while ago', stored, [pr.url], late, true],
    ['a merged PR', { ...stored, prs: [{ ...pr, state: 'MERGED' }] }, [pr.url], late, false],
  ])('%s', (_case, row, urls, now, read) => {
    expect(shouldReadNeoWorkPrs(row, urls, now)).toBe(read);
  });
});

describe('readGithubPrs', () => {
  test('reads each pull request with gh and gives up on any it cannot read', async () => {
    const asked: string[][] = [];
    const spawn = (args: string[]) => {
      asked.push(args);
      const ok = args[3].endsWith('/42');
      return {
        stdout: new Response(ok ? JSON.stringify(ghPr()) : '').body,
        stderr: new Response(ok ? '' : 'not found').body,
        exited: Promise.resolve(ok ? 0 : 1),
        exitCode: ok ? 0 : 1,
        kill: () => {},
      };
    };
    expect(await readGithubPrs([pr.url], spawn as never)).toEqual([{ ...pr, checks: 'none' }]);
    expect(
      await readGithubPrs([pr.url, 'https://github.com/lsm/HyperNeo/pull/7'], spawn as never)
    ).toBe(null);
    expect(asked[0].slice(0, 4)).toEqual(['gh', 'pr', 'view', pr.url]);
  });
});

describe('planNeoWorkPrBlockers', () => {
  const rules = [
    { type: 'required_signatures' },
    {
      type: 'pull_request',
      parameters: { required_approving_review_count: 0, required_review_thread_resolution: true },
    },
  ];
  const unsigned = { commits: [{ oid: '1bad987012', signed: false }], unresolved: 0 };
  const base = { base: 'dev', approvals: 1, rules };
  test.each<[string, Parameters<typeof planNeoWorkPrBlockers>[0], string[]]>([
    [
      'an unsigned commit on a branch that requires signatures',
      { ...base, detail: unsigned },
      ['unsigned commits: dev requires signed commits (1bad987)'],
    ],
    [
      'an unsigned commit where signatures are optional',
      { ...base, rules: [], detail: unsigned },
      [],
    ],
    [
      'unresolved threads where they must be resolved',
      { ...base, detail: { commits: [], unresolved: 2 } },
      ['2 unresolved review threads'],
    ],
    [
      'a missing required approval',
      {
        ...base,
        approvals: 1,
        rules: [{ type: 'pull_request', parameters: { required_approving_review_count: 2 } }],
        detail: null,
      },
      ['needs 2 approving reviews, has 1'],
    ],
    [
      'an approval from before the last push that still counts',
      {
        ...base,
        rules: [{ type: 'pull_request', parameters: { required_approving_review_count: 1 } }],
        detail: null,
      },
      [],
    ],
    [
      'a pull request GitHub calls mergeable',
      { ...base, mergeState: 'CLEAN', detail: unsigned },
      [],
    ],
    ['a branch behind its base', { ...base, mergeState: 'BEHIND', detail: null }, ['behind dev']],
    ['conflicts', { ...base, mergeState: 'DIRTY', detail: null }, ['merge conflicts with dev']],
    [
      'a clean signed pull request',
      { ...base, detail: { commits: [{ oid: 'abc', signed: true }], unresolved: 0 } },
      [],
    ],
  ])('%s', (_label, input, blockers) => {
    expect(planNeoWorkPrBlockers(input)).toEqual(blockers);
  });
});

describe('countNeoWorkPrApprovals', () => {
  const by = (login: string, state: string) => ({ state, author: { login } });
  test.each<[string, ReturnType<typeof by>[], number]>([
    ['two reviewers who approved', [by('a', 'APPROVED'), by('b', 'APPROVED')], 2],
    ['an approval later dismissed', [by('a', 'APPROVED'), by('a', 'DISMISSED')], 0],
    ['changes requested after approving', [by('a', 'APPROVED'), by('a', 'CHANGES_REQUESTED')], 0],
    ['a comment after approving', [by('a', 'APPROVED'), by('a', 'COMMENTED')], 1],
  ])('%s', (_label, reviews, approvals) => {
    expect(countNeoWorkPrApprovals(reviews)).toBe(approvals);
  });
});

describe('wantsNeoWorkPrBlockers', () => {
  test.each<[string, NeoWorkPr, string | undefined, boolean]>([
    ['an open green pull request', pr, 'dev', true],
    ['one without checks', { ...pr, checks: 'none' }, 'dev', true],
    ['one still running CI', { ...pr, checks: 'pending' }, 'dev', false],
    ['one with changes requested', { ...pr, review: 'changes_requested' }, 'dev', false],
    ['a merged one', { ...pr, state: 'MERGED' }, 'dev', false],
    ['one whose base is unknown', pr, undefined, false],
  ])('%s', (_label, at, base, wants) => {
    expect(wantsNeoWorkPrBlockers(at, base)).toBe(wants);
  });
});

describe('neoWorkPrSignature', () => {
  test('changes when blockers appear, and keeps its old form without them', () => {
    expect(neoWorkPrSignature([pr])).toBe(JSON.stringify([[pr.url, 'OPEN', 'passing', 'none']]));
    expect(neoWorkPrSignature([{ ...pr, blockers: ['behind dev'] }])).not.toBe(
      neoWorkPrSignature([pr])
    );
  });
});

describe('readGithubPrs blockers', () => {
  test('names the unsigned commit that keeps a green pull request from merging', async () => {
    const url = 'https://github.com/lsm/blockers-test/pull/6013';
    const reply = (args: string[]) => {
      if (args[2] === 'view')
        return ghPr({
          url,
          baseRefName: 'dev',
          mergeStateStatus: 'BLOCKED',
          headRefOid: '1bad987',
        });
      if (args[2] === 'graphql')
        return {
          data: {
            repository: {
              pullRequest: {
                commits: { nodes: [{ commit: { oid: '1bad987012', signature: null } }] },
                reviewThreads: { nodes: [{ isResolved: true }] },
              },
            },
          },
        };
      return [{ type: 'required_signatures' }, { type: 'pull_request', parameters: {} }];
    };
    const asked: string[][] = [];
    const spawn = (args: string[]) => {
      asked.push(args);
      return {
        stdout: new Response(JSON.stringify(reply(args))).body,
        stderr: new Response('').body,
        exited: Promise.resolve(0),
        exitCode: 0,
        kill: () => {},
      };
    };
    expect(await readGithubPrs([url], spawn as never)).toEqual([
      {
        url,
        state: 'OPEN',
        checks: 'none',
        review: 'none',
        blockers: ['unsigned commits: dev requires signed commits (1bad987)'],
      },
    ]);
    await readGithubPrs([url], spawn as never);
    expect(asked.filter((args) => args[2]?.startsWith('repos/'))).toHaveLength(1);

    const release = 'https://github.com/lsm/blockers-release/pull/1';
    const view = reply;
    asked.length = 0;
    await readGithubPrs([release], ((args: string[]) => {
      asked.push(args);
      const body =
        args[2] === 'view' ? ghPr({ url: release, baseRefName: 'release/1.x' }) : view(args);
      return {
        stdout: new Response(JSON.stringify(body)).body,
        stderr: new Response('').body,
        exited: Promise.resolve(0),
        exitCode: 0,
        kill: () => {},
      };
    }) as never);
    expect(asked.find((args) => args[2]?.startsWith('repos/'))?.[2]).toBe(
      'repos/lsm/blockers-release/rules/branches/release%2F1.x'
    );
  });
});

describe('requireNeoWorkPrRefresh', () => {
  const row = { readAt: 0 };
  type Card = { goal: boolean; row: { readAt: number } | null; session: boolean };
  const card: Card = { goal: true, row, session: true };
  const reported = { status: 'reported', report: 'Merged.' };
  test.each<[string, typeof reported, Partial<Card>, number, boolean]>([
    ['a reported card read over two minutes ago', reported, {}, 3 * 60_000, true],
    ['one read a minute ago', reported, {}, 60_000, false],
    ['one still running', { ...reported, status: 'queued' }, {}, 3 * 60_000, false],
    ['one the user closed as done', { ...reported, report: 'closed' }, {}, 3 * 60_000, false],
    ['one with no done list', reported, { goal: false }, 3 * 60_000, false],
    ['one without tracked pull requests', reported, { row: null }, 3 * 60_000, false],
    ['one whose Neo session is gone', reported, { session: false }, 3 * 60_000, false],
  ])('%s', (_label, work, overrides, now, refreshes) => {
    expect(requireNeoWorkPrRefresh(work, { ...card, ...overrides }, now, 'closed')).toEqual(
      refreshes ? { value: row } : { reason: null }
    );
  });
});

describe('requireNeoWorkPrDelivery', () => {
  test.each<['deliver' | 'remind' | 'wait' | 'unchanged', boolean]>([
    ['deliver', true],
    ['remind', true],
    ['wait', false],
    ['unchanged', false],
  ])('%s', (plan, delivers) => {
    const gate = requireNeoWorkPrDelivery(plan);
    expect('value' in gate).toBe(delivers);
    if ('value' in gate) expect(gate.value as string).toBe(plan);
  });
});
