import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { MessageHub } from '@hyperneo/shared';
import type { NeoAsk } from '@hyperneo/shared/types/neo-snapshot';
import {
  extractNeoAskRefs,
  extractNeoCardRefs,
  readGithubRefStates,
  type NeoRef,
  type NeoRefState,
} from '../../../../src/lib/neo/packs/coding/ask-prs.ts';
import { NeoService } from '../../../../src/lib/neo/service.ts';
import {
  InternalEventBus,
  type DaemonInternalEventMap,
} from '../../../../src/lib/internal-event-bus.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';

const url = (n: number, repo = 'lsm/HyperNeo') => `https://github.com/${repo}/pull/${n}`;
const ask: NeoAsk = {
  id: 'a1',
  requestKey: 'k1',
  projectId: null,
  originSessionId: 'neo:root',
  originMessageId: 'm0',
  title: 'Voice composer decisions',
  ask: 'Decide the choices in the design (PR lsm/HyperNeo#6159, unmerged); see #21 iOS.',
  doneWhen: 'The human picks a direction.',
  doneSource: 'human',
  status: 'waiting',
  outcome: 'Waiting on you: 5 decisions.',
  evidence: `Design in ${url(6159)}; context ${url(32, 'lsm/neo-ios')}.`,
  createdAt: 100,
  updatedAt: 100,
  settledAt: 100,
  workIds: [],
  doneItems: [
    {
      id: 'i1',
      text: 'Bar position chosen',
      state: 'needs_you',
      evidence: 'See lsm/HyperNeo#6205',
      check: null,
      metBy: null,
      removed: false,
      addedAt: null,
    },
  ],
};
const ref = (number: number, repo = 'HyperNeo', owner = 'lsm'): NeoRef => ({ owner, repo, number });
const merged = (n: number, at: number): NeoRefState => ({
  url: url(n),
  kind: 'pr',
  state: 'MERGED',
  at,
  done: true,
  closedBy: null,
});

describe('extractNeoAskRefs', () => {
  test('takes URLs and owner/repo#N, and leaves bare #N alone when the ask names two repos', () => {
    expect(extractNeoAskRefs(ask, [])).toEqual([ref(6159), ref(32, 'neo-ios'), ref(6205)]);
  });

  test('leaves out pull requests the ask cards already track', () => {
    expect(extractNeoAskRefs(ask, [url(6159)])).toEqual([ref(32, 'neo-ios'), ref(6205)]);
  });

  test('resolves bare #N against the one repo the ask and its cards point at', () => {
    const plain = { ...ask, ask: 'Fix HyperNeo #5546', evidence: null, doneItems: [] };
    expect(extractNeoAskRefs(plain, [url(6300)])).toEqual([ref(5546)]);
    expect(extractNeoAskRefs(plain, [])).toEqual([]);
    expect(
      extractNeoAskRefs(
        { ...plain, outcome: 'See https://github.com/lsm/HyperNeo/issues/5546' },
        []
      )
    ).toEqual([ref(5546)]);
  });
});

describe('extractNeoCardRefs', () => {
  const repo = { owner: 'lsm', repo: 'HyperNeo' };
  test.each<[string, string, typeof repo | null, string[]]>([
    ['reads owner/repo#N', 'See lsm/HyperNeo#6403.', null, ['lsm/HyperNeo#6403']],
    [
      'reads bare #N against the card repo',
      'CI on #6403 and #6440.',
      repo,
      ['lsm/HyperNeo#6403', 'lsm/HyperNeo#6440'],
    ],
    ['skips bare #N without a repo', 'CI on #6403.', null, []],
    ['lists each ref once', 'lsm/HyperNeo#6403 then #6403', repo, ['lsm/HyperNeo#6403']],
  ])('%s', (_label, text, known, refs) => {
    expect(
      extractNeoCardRefs(text, known).map((ref) => `${ref.owner}/${ref.repo}#${ref.number}`)
    ).toEqual(refs);
  });
});

describe('readGithubRefStates', () => {
  test('reads when an open issue was created and linked under its parent', async () => {
    const issue = {
      __typename: 'Issue',
      url: 'https://github.com/lsm/HyperNeo/issues/9106',
      state: 'OPEN',
      stateReason: null,
      createdAt: '2026-10-10T15:00:00Z',
      closedAt: null,
      parent: { url: 'https://github.com/lsm/HyperNeo/issues/6002' },
      timelineItems: { nodes: [{ createdAt: '2026-10-10T15:05:00Z' }] },
      closedByPullRequestsReferences: { nodes: [] },
    };
    const spawn = () => ({
      stdout: new Response(JSON.stringify({ data: { repository: { issueOrPullRequest: issue } } }))
        .body,
      stderr: new Response('').body,
      exited: Promise.resolve(0),
      exitCode: 0,
      kill: () => {},
    });
    expect(await readGithubRefStates([ref(9106)], spawn as never)).toEqual([
      {
        url: issue.url,
        kind: 'issue',
        stateReason: null,
        closingPrs: [],
        state: 'OPEN',
        at: null,
        done: false,
        closedBy: null,
        base: null,
        merges: [],
        defaultBase: null,
        createdAt: Date.parse(issue.createdAt),
        parent: { url: issue.parent.url, at: Date.parse('2026-10-10T15:05:00Z') },
      },
    ]);
  });

  test('reads an issue closed as a duplicate as not done', async () => {
    const issue = {
      __typename: 'Issue',
      url: 'https://github.com/lsm/HyperNeo/issues/9105',
      state: 'CLOSED',
      stateReason: 'DUPLICATE',
      closedAt: '2026-10-10T15:00:00Z',
      closedByPullRequestsReferences: { nodes: [] },
    };
    const spawn = () => ({
      stdout: new Response(JSON.stringify({ data: { repository: { issueOrPullRequest: issue } } }))
        .body,
      stderr: new Response('').body,
      exited: Promise.resolve(0),
      exitCode: 0,
      kill: () => {},
    });
    expect(await readGithubRefStates([ref(9105)], spawn as never)).toEqual([
      {
        url: issue.url,
        kind: 'issue',
        state: 'CLOSED',
        at: Date.parse(issue.closedAt),
        done: false,
        closedBy: null,
        base: null,
        merges: [],
        defaultBase: null,
        duplicate: true,
        stateReason: 'DUPLICATE',
        closingPrs: [],
        createdAt: null,
        parent: null,
      },
    ]);
  });

  test('reads pull requests and issues, keeps a merge, skips non-refs for an hour, retries the rest', async () => {
    const asked: number[] = [];
    const node = (number: number) =>
      number === 9001
        ? {
            __typename: 'PullRequest',
            url: url(9001),
            state: 'MERGED',
            mergedAt: '2026-10-10T14:31:00Z',
            closedAt: '2026-10-10T14:31:00Z',
            baseRefName: 'dev',
          }
        : number === 9002
          ? {
              __typename: 'Issue',
              url: 'https://github.com/lsm/HyperNeo/issues/9002',
              state: 'CLOSED',
              stateReason: 'COMPLETED',
              closedAt: '2026-10-10T15:00:00Z',
              closedByPullRequestsReferences: {
                nodes: [{ url: url(9001), merged: true, baseRefName: 'dev' }],
              },
            }
          : null;
    const spawn = (args: string[]) => {
      const number = Number(args.find((arg) => /^p=\d+$/.test(arg))?.slice(2));
      asked.push(number);
      const found = node(number);
      return {
        stdout: new Response(
          found
            ? JSON.stringify({
                data: {
                  repository: { defaultBranchRef: { name: 'dev' }, issueOrPullRequest: found },
                },
              })
            : ''
        ).body,
        stderr: new Response(
          found
            ? ''
            : number === 9003
              ? 'GraphQL: Could not resolve to an issue or pull request with the number of 9003.'
              : 'gh: To get started with GitHub CLI, please run: gh auth login'
        ).body,
        exited: Promise.resolve(found ? 0 : 1),
        exitCode: found ? 0 : 1,
        kill: () => {},
      };
    };
    const refs = [ref(9001), ref(9002), ref(9003), ref(9004)];
    expect(await readGithubRefStates(refs, spawn as never)).toEqual([
      { ...merged(9001, Date.parse('2026-10-10T14:31:00Z')), base: 'dev', defaultBase: 'dev' },
      {
        url: 'https://github.com/lsm/HyperNeo/issues/9002',
        kind: 'issue',
        state: 'CLOSED',
        at: Date.parse('2026-10-10T15:00:00Z'),
        done: true,
        stateReason: 'COMPLETED',
        closingPrs: [url(9001)],
        closedBy: url(9001),
        base: 'dev',
        merges: [{ url: url(9001), base: 'dev', at: null }],
        defaultBase: 'dev',
        createdAt: null,
        parent: null,
      },
    ]);
    await readGithubRefStates(refs, spawn as never);
    expect([9001, 9002, 9003, 9004].map((n) => asked.filter((m) => m === n).length)).toEqual([
      1, 2, 1, 2,
    ]);
    const later = Date.now() + 60 * 60_000;
    const clock = spyOn(Date, 'now').mockImplementation(() => later);
    try {
      await readGithubRefStates([ref(9003)], spawn as never);
    } finally {
      clock.mockRestore();
    }
    expect(asked.filter((m) => m === 9003)).toHaveLength(2);
  });
});
