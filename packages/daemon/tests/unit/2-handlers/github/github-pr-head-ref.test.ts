import { describe, expect, it } from 'bun:test';
import type { GitHubWatchedRepo } from '../../../../src/lib/external-events/github/github-repository';
import {
  gitHubRepoPath,
  headRefKey,
  headRepoFromPullRequest,
  headShaFromPullRequest,
  parseHeadRefKey,
  pickPrNumbersByHeadSha,
  pullRequestNumberFrom,
} from '../../../../src/lib/external-events/github/github-pr-head-ref';

function makeWatched(owner = 'watched-owner', repo = 'watched-repo'): GitHubWatchedRepo {
  return {
    id: 'wh-1',
    spaceId: 'sp-1',
    owner,
    repo,
    enabled: true,
    webhookEnabled: false,
    pollingEnabled: true,
    webhookSecret: null,
    webhookRemoteId: null,
    webhookUrl: null,
    webhookAutoRegistered: false,
    webhookActive: null,
    webhookLastCheckedAt: null,
    webhookLastError: null,
    webhookConfiguredAt: null,
    lastWebhookAt: null,
    lastPollAt: null,
    pollCursor: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

describe('gitHubRepoPath', () => {
  it('joins owner and repo with a single slash', () => {
    expect(gitHubRepoPath('octocat', 'Hello-World')).toBe('octocat/Hello-World');
  });

  it('URL-encodes each segment so special characters round-trip safely', () => {
    expect(gitHubRepoPath('own ers', 're/po')).toBe('own%20ers/re%2Fpo');
    expect(gitHubRepoPath('a/b', 'c/d')).toBe('a%2Fb/c%2Fd');
  });
});

describe('pullRequestNumberFrom', () => {
  it('returns 0 for non-object rows', () => {
    expect(pullRequestNumberFrom(null)).toBe(0);
    expect(pullRequestNumberFrom(undefined)).toBe(0);
    expect(pullRequestNumberFrom('not-an-object')).toBe(0);
    expect(pullRequestNumberFrom(42)).toBe(0);
  });

  it('returns 0 when the row has no numeric number', () => {
    expect(pullRequestNumberFrom({})).toBe(0);
    expect(pullRequestNumberFrom({ number: null })).toBe(0);
    expect(pullRequestNumberFrom({ number: '123' })).toBe(0);
    expect(pullRequestNumberFrom({ number: true })).toBe(0);
  });

  it('returns the numeric PR number verbatim', () => {
    expect(pullRequestNumberFrom({ number: 42 })).toBe(42);
    expect(pullRequestNumberFrom({ number: 0 })).toBe(0);
  });
});

describe('headShaFromPullRequest', () => {
  it('returns "" for non-object rows', () => {
    expect(headShaFromPullRequest(null)).toBe('');
    expect(headShaFromPullRequest(undefined)).toBe('');
    expect(headShaFromPullRequest('x')).toBe('');
  });

  it('returns "" when the row has no head object', () => {
    expect(headShaFromPullRequest({})).toBe('');
    expect(headShaFromPullRequest({ head: null })).toBe('');
    expect(headShaFromPullRequest({ head: 'not-an-object' })).toBe('');
  });

  it('returns "" when head.sha is absent or not a string', () => {
    expect(headShaFromPullRequest({ head: {} })).toBe('');
    expect(headShaFromPullRequest({ head: { sha: null } })).toBe('');
    expect(headShaFromPullRequest({ head: { sha: 123 } })).toBe('');
  });

  it('returns the head SHA verbatim', () => {
    expect(headShaFromPullRequest({ head: { sha: 'abc123' } })).toBe('abc123');
    expect(headShaFromPullRequest({ head: { sha: '' } })).toBe('');
  });
});

describe('headRepoFromPullRequest', () => {
  it('falls back to the watched repo path for non-object rows', () => {
    expect(headRepoFromPullRequest(null, makeWatched())).toBe('watched-owner/watched-repo');
    expect(headRepoFromPullRequest(undefined, makeWatched())).toBe('watched-owner/watched-repo');
    expect(headRepoFromPullRequest('x', makeWatched())).toBe('watched-owner/watched-repo');
  });

  it('falls back to the watched repo path when head is missing or non-object', () => {
    expect(headRepoFromPullRequest({}, makeWatched())).toBe('watched-owner/watched-repo');
    expect(headRepoFromPullRequest({ head: null }, makeWatched())).toBe(
      'watched-owner/watched-repo'
    );
    expect(headRepoFromPullRequest({ head: 'nope' }, makeWatched())).toBe(
      'watched-owner/watched-repo'
    );
  });

  it('falls back to the watched repo path when head.repo is missing or non-object', () => {
    expect(headRepoFromPullRequest({ head: {} }, makeWatched())).toBe('watched-owner/watched-repo');
    expect(headRepoFromPullRequest({ head: { repo: null } }, makeWatched())).toBe(
      'watched-owner/watched-repo'
    );
    expect(headRepoFromPullRequest({ head: { repo: 'nope' } }, makeWatched())).toBe(
      'watched-owner/watched-repo'
    );
  });

  it('falls back to the watched repo path when owner login or repo name is missing/empty', () => {
    expect(headRepoFromPullRequest({ head: { repo: { name: 'fork-repo' } } }, makeWatched())).toBe(
      'watched-owner/watched-repo'
    );
    expect(
      headRepoFromPullRequest({ head: { repo: { owner: {}, name: 'fork-repo' } } }, makeWatched())
    ).toBe('watched-owner/watched-repo');
    expect(
      headRepoFromPullRequest(
        { head: { repo: { owner: { login: 123 }, name: 'fork-repo' } } },
        makeWatched()
      )
    ).toBe('watched-owner/watched-repo');
    expect(
      headRepoFromPullRequest({ head: { repo: { owner: { login: 'fork-owner' } } } }, makeWatched())
    ).toBe('watched-owner/watched-repo');
    expect(
      headRepoFromPullRequest(
        { head: { repo: { owner: { login: 'fork-owner' }, name: 7 } } },
        makeWatched()
      )
    ).toBe('watched-owner/watched-repo');
    expect(
      headRepoFromPullRequest(
        { head: { repo: { owner: { login: '' }, name: 'fork-repo' } } },
        makeWatched()
      )
    ).toBe('watched-owner/watched-repo');
    expect(
      headRepoFromPullRequest(
        { head: { repo: { owner: { login: 'fork-owner' }, name: '' } } },
        makeWatched()
      )
    ).toBe('watched-owner/watched-repo');
  });

  it('resolves a fork PR to its head-fork repo path', () => {
    const row = {
      head: { repo: { owner: { login: 'fork-owner' }, name: 'fork-repo' } },
    };
    expect(headRepoFromPullRequest(row, makeWatched())).toBe('fork-owner/fork-repo');
  });

  it('URL-encodes the resolved fork owner and name', () => {
    const row = {
      head: { repo: { owner: { login: 'fork owner' }, name: 'fork/repo' } },
    };
    expect(headRepoFromPullRequest(row, makeWatched())).toBe('fork%20owner/fork%2Frepo');
  });
});

describe('headRefKey', () => {
  it('composes the repoPath@headSha identity key', () => {
    expect(headRefKey('octocat/Hello-World', 'abc123')).toBe('octocat/Hello-World@abc123');
    expect(headRefKey('fork%20owner/fork-repo', '')).toBe('fork%20owner/fork-repo@');
  });
});

describe('parseHeadRefKey', () => {
  it('splits a normal key on the @ separator', () => {
    expect(parseHeadRefKey('octocat/Hello-World@abc123')).toEqual({
      repoPath: 'octocat/Hello-World',
      headSha: 'abc123',
    });
  });

  it('returns the whole key as headSha when there is no @', () => {
    expect(parseHeadRefKey('abc123')).toEqual({ repoPath: '', headSha: 'abc123' });
  });

  it('returns the whole key as headSha for a leading @ (separator index 0 is not > 0)', () => {
    expect(parseHeadRefKey('@abc123')).toEqual({ repoPath: '', headSha: '@abc123' });
  });

  it('produces an empty headSha for a trailing @', () => {
    expect(parseHeadRefKey('octocat/Hello-World@')).toEqual({
      repoPath: 'octocat/Hello-World',
      headSha: '',
    });
  });

  it('splits on the LAST @ so a repoPath with an embedded @ still wins', () => {
    expect(parseHeadRefKey('a@b@c')).toEqual({ repoPath: 'a@b', headSha: 'c' });
  });

  it('handles the empty string', () => {
    expect(parseHeadRefKey('')).toEqual({ repoPath: '', headSha: '' });
  });

  it('round-trips headRefKey when the SHA contains no @', () => {
    const repoPath = 'octocat/Hello-World';
    const headSha = 'abc123';
    expect(parseHeadRefKey(headRefKey(repoPath, headSha))).toEqual({ repoPath, headSha });
    const atRepoPath = 'a@b';
    expect(parseHeadRefKey(headRefKey(atRepoPath, headSha))).toEqual({
      repoPath: atRepoPath,
      headSha,
    });
  });

  it('does NOT round-trip when the SHA contains an @ (documented design constraint)', () => {
    expect(parseHeadRefKey(headRefKey('a', 'b@c'))).toEqual({ repoPath: 'a@b', headSha: 'c' });
  });
});

describe('pickPrNumbersByHeadSha', () => {
  it('returns [] for non-array pulls', () => {
    expect(pickPrNumbersByHeadSha(null, 'abc')).toEqual([]);
    expect(pickPrNumbersByHeadSha(undefined, 'abc')).toEqual([]);
    expect(pickPrNumbersByHeadSha({}, 'abc')).toEqual([]);
    expect(pickPrNumbersByHeadSha('not-an-array', 'abc')).toEqual([]);
    expect(pickPrNumbersByHeadSha(42, 'abc')).toEqual([]);
  });

  it('returns [] for an empty array', () => {
    expect(pickPrNumbersByHeadSha([], 'abc')).toEqual([]);
  });

  it('skips non-object entries (null / undefined / primitives)', () => {
    expect(pickPrNumbersByHeadSha([null, undefined, 42, 'str', true], 'abc')).toEqual([]);
  });

  it('skips entries whose head.sha does not equal the queried SHA', () => {
    expect(
      pickPrNumbersByHeadSha([{ state: 'open', number: 7, head: { sha: 'other' } }], 'abc')
    ).toEqual([]);
    expect(pickPrNumbersByHeadSha([{ state: 'open', number: 7 }], 'abc')).toEqual([]);
    expect(
      pickPrNumbersByHeadSha([{ state: 'open', number: 7, head: { sha: 123 } }], 'abc')
    ).toEqual([]);
  });

  it('skips entries that are not in the open state (case-sensitive)', () => {
    const row = (state: unknown) => [{ state, number: 7, head: { sha: 'abc' } }];
    expect(pickPrNumbersByHeadSha(row('closed'), 'abc')).toEqual([]);
    expect(pickPrNumbersByHeadSha(row('merged'), 'abc')).toEqual([]);
    expect(pickPrNumbersByHeadSha(row(''), 'abc')).toEqual([]);
    expect(pickPrNumbersByHeadSha(row('OPEN'), 'abc')).toEqual([]);
    expect(pickPrNumbersByHeadSha(row(undefined), 'abc')).toEqual([]);
    expect(pickPrNumbersByHeadSha(row(123), 'abc')).toEqual([]);
  });

  it('skips entries with a non-positive or non-numeric number', () => {
    expect(pickPrNumbersByHeadSha([{ state: 'open', head: { sha: 'abc' } }], 'abc')).toEqual([]);
    expect(
      pickPrNumbersByHeadSha([{ state: 'open', number: '7', head: { sha: 'abc' } }], 'abc')
    ).toEqual([]);
    expect(
      pickPrNumbersByHeadSha([{ state: 'open', number: 0, head: { sha: 'abc' } }], 'abc')
    ).toEqual([]);
    expect(
      pickPrNumbersByHeadSha([{ state: 'open', number: -1, head: { sha: 'abc' } }], 'abc')
    ).toEqual([]);
  });

  it('returns the number of a single matching open PR', () => {
    expect(
      pickPrNumbersByHeadSha([{ state: 'open', number: 7, head: { sha: 'abc' } }], 'abc')
    ).toEqual([7]);
  });

  it('returns every open PR sharing the head SHA (a commit can be head of several PRs)', () => {
    const pulls = [
      { state: 'open', number: 7, head: { sha: 'abc' } },
      { state: 'open', number: 8, head: { sha: 'abc' } },
    ];
    expect(pickPrNumbersByHeadSha(pulls, 'abc')).toEqual([7, 8]);
  });

  it('dedupes by PR number when the same number appears more than once', () => {
    const pulls = [
      { state: 'open', number: 7, head: { sha: 'abc' } },
      { state: 'open', number: 7, head: { sha: 'abc' } },
    ];
    expect(pickPrNumbersByHeadSha(pulls, 'abc')).toEqual([7]);
  });

  it('excludes a closed/merged PR whose head SHA still matches (stale-topic guard)', () => {
    const pulls = [
      { state: 'closed', number: 9, head: { sha: 'abc' } },
      { state: 'open', number: 7, head: { sha: 'abc' } },
    ];
    expect(pickPrNumbersByHeadSha(pulls, 'abc')).toEqual([7]);
  });

  it('matches a headless open PR when the queried SHA is empty (boundary)', () => {
    expect(pickPrNumbersByHeadSha([{ state: 'open', number: 5 }], '')).toEqual([5]);
    expect(pickPrNumbersByHeadSha([{ state: 'open', number: 5, head: { sha: 123 } }], '')).toEqual([
      5,
    ]);
  });
});
