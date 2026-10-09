import { describe, expect, test } from 'bun:test';
import {
  extractNeoWorkPrUrls,
  isNeoWorkPrWaiting,
  neoWorkPrSignature,
  planNeoWorkPrRefresh,
  readGithubPrs,
  summarizeNeoWorkPr,
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
  test.each<[string, NeoWorkPr[], string | null, ReturnType<typeof planNeoWorkPrRefresh>]>([
    ['an open PR with running checks', [{ ...pr, checks: 'pending' as const }], null, 'wait'],
    [
      'a merged PR with leftover pending checks',
      [{ ...pr, state: 'MERGED' as const, checks: 'pending' as const }],
      null,
      'deliver',
    ],
    ['a state Neo has not seen', [pr], null, 'deliver'],
    ['the state Neo already saw', [pr], neoWorkPrSignature([pr]), 'unchanged'],
    ['a new review', [{ ...pr, review: 'approved' as const }], neoWorkPrSignature([pr]), 'deliver'],
  ])('%s', (_case, prs, delivered, plan) => {
    expect(planNeoWorkPrRefresh({ prs, delivered })).toBe(plan);
    expect(isNeoWorkPrWaiting(prs)).toBe(plan === 'wait');
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
