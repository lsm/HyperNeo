import { describe, expect, test } from 'bun:test';
import {
  extractNeoWorkPrUrls,
  mergeNeoWorkPrReads,
  countNeoWorkPrApprovals,
  planNeoWorkPrBlockers,
  readGithubPrs,
  shouldReadNeoWorkPrs,
  summarizeNeoWorkPr,
  wantsNeoWorkPrBlockers,
} from '../../../../src/lib/neo/packs/coding/work-prs.ts';
import { type NeoWorkPr, neoWorkPrVerdict } from '@hyperneo/shared/types/neo-snapshot';

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

  test('treats links that differ only in case as one pull request', () => {
    const tracked = [{ url: 'https://github.com/lsm/HyperNeo/pull/1' }];
    expect(extractNeoWorkPrUrls('Merged https://github.com/lsm/hyperneo/pull/1.', tracked)).toEqual(
      ['https://github.com/lsm/HyperNeo/pull/1']
    );
  });

  test('keeps the pull requests a card already tracks ahead of new links', () => {
    const tracked = [{ url: 'https://github.com/lsm/HyperNeo/pull/1' }];
    expect(
      extractNeoWorkPrUrls('Opened https://github.com/lsm/HyperNeo/pull/2 too.', tracked)
    ).toEqual(['https://github.com/lsm/HyperNeo/pull/1', 'https://github.com/lsm/HyperNeo/pull/2']);
  });
});

describe('summarizeNeoWorkPr', () => {
  test('keeps when a closed PR was closed', () => {
    expect(
      summarizeNeoWorkPr(ghPr({ state: 'CLOSED', closedAt: '2026-10-19T03:00:00Z' }))?.closedAt
    ).toBe(Date.parse('2026-10-19T03:00:00Z'));
  });

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

  test('reads the issues and PRs a PR refers to from its title, body and closing issues', () => {
    expect(
      summarizeNeoWorkPr(
        ghPr({
          title: 'fix(neo): stalled asks wake Neo (#6587)',
          body: 'Part of #6002. See https://github.com/lsm/HyperNeo/pull/6601.',
          closingIssuesReferences: [{ number: 6587 }, { number: 6590 }],
        })
      )?.refs
    ).toEqual([6587, 6002, 6601, 6590]);
    expect(summarizeNeoWorkPr(ghPr({}))?.refs).toBeUndefined();
  });
});

describe('neoWorkPrVerdict', () => {
  test.each<[string, Partial<NeoWorkPr>, ReturnType<typeof neoWorkPrVerdict>]>([
    ['merged', { state: 'MERGED' }, 'done'],
    ['closed unmerged', { state: 'CLOSED' }, 'failed'],
    [
      'CI still running, even with changes requested',
      { checks: 'pending', review: 'changes_requested' },
      'waiting',
    ],
    ['failing checks', { checks: 'failing' }, 'failed'],
    [
      'changes requested on settled checks',
      { checks: 'passing', review: 'changes_requested' },
      'failed',
    ],
    ['approved with green checks', { checks: 'passing', review: 'approved' }, 'ready'],
    ['green checks, no review yet', { checks: 'passing' }, 'pending'],
  ])('%s', (_label, overrides, verdict) => {
    expect(neoWorkPrVerdict({ ...pr, ...overrides })).toBe(verdict);
  });
});

describe('shouldReadNeoWorkPrs', () => {
  const stored = { prs: [pr], readAt: 0, readOkAt: 0 };
  const late = 2 * 60_000;

  test.each<[string, typeof stored | null, string[], number, boolean]>([
    ['a report with no links', null, [], late, false],
    ['a first report', null, [pr.url], 0, true],
    ['a new pull request', stored, [pr.url, 'https://github.com/lsm/HyperNeo/pull/7'], 0, true],
    ['an open PR read moments ago', stored, [pr.url], late - 1, false],
    ['the same PR spelled in another case', stored, [pr.url.toLowerCase()], late - 1, false],
    ['an open PR read a while ago', stored, [pr.url], late, true],
    ['a merged PR', { ...stored, prs: [{ ...pr, state: 'MERGED' }] }, [pr.url], late, false],
  ])('%s', (_case, row, urls, now, read) => {
    expect(shouldReadNeoWorkPrs(row, urls, now)).toBe(read);
  });
});

describe('readGithubPrs', () => {
  test('reads each pull request with gh, skips one it cannot read, and fails only when none read', async () => {
    const asked: string[][] = [];
    const spawn = (args: string[]) => {
      asked.push(args);
      const ok = args[2] === 'view' && args[3].endsWith('/42');
      const api =
        args[1] === 'api'
          ? String(args.find((arg) => arg.startsWith('repos/')) ?? '').includes('check-runs')
            ? [{ check_runs: [] }]
            : [{ statuses: [] }]
          : null;
      return {
        stdout: new Response(ok ? JSON.stringify(ghPr()) : api ? JSON.stringify(api) : '').body,
        stderr: new Response(ok ? '' : 'not found').body,
        exited: Promise.resolve(ok || api ? 0 : 1),
        exitCode: ok || api ? 0 : 1,
        kill: () => {},
      };
    };
    expect(await readGithubPrs([pr.url], spawn as never)).toEqual([
      { ...pr, checks: 'none', head },
    ]);
    expect(
      await readGithubPrs([pr.url, 'https://github.com/lsm/HyperNeo/pull/7'], spawn as never)
    ).toEqual([{ ...pr, checks: 'none', head }]);
    expect(await readGithubPrs(['https://github.com/lsm/HyperNeo/pull/7'], spawn as never)).toBe(
      null
    );
    expect(asked[0].slice(0, 4)).toEqual(['gh', 'pr', 'view', pr.url]);
  });
  test('reads branch rules and commits only for a github.com pull request', async () => {
    const asked: string[][] = [];
    const spawn = (args: string[]) => {
      asked.push(args);
      const body = args[1] === 'pr' ? ghPr({ url: args[3], baseRefName: 'dev' }) : [];
      return {
        stdout: new Response(JSON.stringify(body)).body,
        stderr: new Response('').body,
        exited: Promise.resolve(0),
        exitCode: 0,
        kill: () => {},
      };
    };
    await readGithubPrs(['https://ghe.example.com/lsm/HyperNeo/pull/42'], spawn as never);
    expect(asked.map((args) => args[1])).toEqual(['pr', 'api', 'api']);
    asked.length = 0;
    await readGithubPrs(['https://github.com/lsm/Rules/pull/42'], spawn as never);
    expect(asked.map((args) => args[1])).toEqual(['pr', 'api', 'api', 'api', 'api']);
  });
});

describe('readGithubPrs REST check rollup', () => {
  const url = 'https://github.com/lsm/HyperNeo/pull/42';
  const rollupSpawn = (
    viewBody: Record<string, unknown>,
    api: (path: string) => unknown = () => null
  ) => {
    const asked: string[][] = [];
    const spawn = (args: string[]) => {
      asked.push(args);
      const path = String(args.find((arg) => arg.startsWith('repos/')) ?? '');
      const body = args[2] === 'view' ? viewBody : args[1] === 'api' ? api(path) : [];
      return {
        stdout: new Response(JSON.stringify(body)).body,
        stderr: new Response('').body,
        exited: Promise.resolve(0),
        exitCode: 0,
        kill: () => {},
      };
    };
    return { spawn, asked };
  };

  test('asks for CI on REST check-runs and combined status, not GraphQL statusCheckRollup', async () => {
    const { spawn, asked } = rollupSpawn(ghPr(), (path) =>
      path.includes('check-runs')
        ? [
            {
              check_runs: [
                { status: 'completed', conclusion: 'success' },
                { status: 'completed', conclusion: 'skipped' },
              ],
            },
          ]
        : [{ statuses: [{ state: 'success' }] }]
    );
    const read = await readGithubPrs([url], spawn as never);
    expect(read?.[0]?.checks).toBe('passing');
    expect(asked[0].join(' ')).not.toContain('statusCheckRollup');
    expect(
      asked
        .map((args) => String(args.find((arg) => arg.startsWith('repos/')) ?? ''))
        .some((path) => path.startsWith('repos/lsm/HyperNeo/commits/abc123/check-runs'))
    ).toBe(true);
    expect(
      asked
        .map((args) => String(args.find((arg) => arg.startsWith('repos/')) ?? ''))
        .some((path) => path.startsWith('repos/lsm/HyperNeo/commits/abc123/status'))
    ).toBe(true);
  });

  test('maps a failed check run and an errored status to failing', async () => {
    const { spawn } = rollupSpawn(ghPr(), (path) =>
      path.includes('check-runs')
        ? [{ check_runs: [{ status: 'completed', conclusion: 'failure' }] }]
        : [{ statuses: [{ state: 'error' }] }]
    );
    expect((await readGithubPrs([url], spawn as never))?.[0]?.checks).toBe('failing');
  });

  test('skips the REST rollup for a settled pull request', async () => {
    const { spawn, asked } = rollupSpawn(
      ghPr({ state: 'MERGED', mergedAt: '2026-10-25T00:00:00Z' }),
      () => [{ statuses: [] }]
    );
    const read = await readGithubPrs([url], spawn as never);
    expect(read?.[0]?.state).toBe('MERGED');
    expect(read?.[0]?.checks).toBe('none');
    expect(
      asked.some((args) => args.some((arg) => typeof arg === 'string' && arg.includes('/commits/')))
    ).toBe(false);
  });

  test('fails the read when the REST rollup is unavailable, keeping the stored value', async () => {
    const { spawn } = rollupSpawn(ghPr(), () => null);
    const read = await readGithubPrs([url], spawn as never);
    expect(read).toBe(null);
  });

  test('follows check-runs pagination to a failure past the first page', async () => {
    const fullPage = Array.from({ length: 100 }, () => ({
      status: 'completed',
      conclusion: 'success',
    }));
    const { spawn, asked } = rollupSpawn(ghPr(), (path) => {
      if (path.includes('check-runs'))
        return [
          { check_runs: fullPage },
          { check_runs: [{ status: 'completed', conclusion: 'failure' }] },
        ];
      return [{ statuses: [] }];
    });
    const read = await readGithubPrs([url], spawn as never);
    expect(read?.[0]?.checks).toBe('failing');
    expect(asked.find((args) => args.includes('--paginate'))).toBeTruthy();
  });

  test('targets the pull request host for REST lookups', async () => {
    const ghe = 'https://ghe.example.com/lsm/HyperNeo/pull/42';
    const { spawn, asked } = rollupSpawn(ghPr({ url: ghe }), () => [{ statuses: [] }]);
    await readGithubPrs([ghe], spawn as never);
    const hostnames = asked
      .filter((args) => args.includes('--hostname'))
      .map((args) => args[args.indexOf('--hostname') + 1]);
    expect(hostnames.length).toBeGreaterThan(0);
    expect(new Set(hostnames)).toEqual(new Set(['ghe.example.com']));
  });
});

describe('mergeNeoWorkPrReads', () => {
  test("matches a report's URL to gh's canonical one whatever its case, once", () => {
    expect(mergeNeoWorkPrReads([pr.url.toUpperCase(), pr.url], [pr])).toEqual([pr]);
  });

  test('keeps the stored copy of a pull request this read missed, in URL order', () => {
    const other = {
      ...pr,
      url: 'https://github.com/lsm/HyperNeo/pull/43',
      state: 'MERGED' as const,
    };
    const fresh = { ...pr, checks: 'passing' as const };
    expect(
      mergeNeoWorkPrReads([other.url, pr.url, 'https://x/pull/1'], [fresh], [pr, other])
    ).toEqual([other, fresh]);
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
    [
      'unresolved threads on a pull request GitHub calls unstable',
      { ...base, mergeState: 'UNSTABLE', detail: { commits: [], unresolved: 1 } },
      ['1 unresolved review thread'],
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
    ['one with changes requested', { ...pr, review: 'changes_requested' }, 'dev', true],
    ['one with failing CI', { ...pr, checks: 'failing' }, 'dev', true],
    ['a merged one', { ...pr, state: 'MERGED' }, 'dev', false],
    ['one whose base is unknown', pr, undefined, false],
  ])('%s', (_label, at, base, wants) => {
    expect(wantsNeoWorkPrBlockers(at, base)).toBe(wants);
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
      const path = String(args.find((arg) => arg.startsWith('repos/')) ?? '');
      if (path.includes('/check-runs')) return [{ check_runs: [] }];
      if (path.endsWith('/status')) return [{ statuses: [] }];
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
        head: '1bad987',
        blockers: ['unsigned commits: dev requires signed commits (1bad987)'],
      },
    ]);
    await readGithubPrs([url], spawn as never);
    expect(asked.filter((args) => args[2]?.includes('/rules/'))).toHaveLength(1);

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
    expect(asked.find((args) => args[2]?.includes('/rules/'))?.[2]).toBe(
      'repos/lsm/blockers-release/rules/branches/release%2F1.x'
    );
  });
});
