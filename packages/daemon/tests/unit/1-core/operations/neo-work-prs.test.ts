import { describe, expect, test } from 'bun:test';
import {
  extractNeoWorkPrUrls,
  isNeoWorkPrWaiting,
  neoWorkPrSignature,
  planNeoWorkPrRefresh,
  readGithubPrs,
  shouldReadNeoWorkPrs,
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
