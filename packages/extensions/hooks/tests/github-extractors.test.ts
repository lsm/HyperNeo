import { describe, expect, test } from 'bun:test';
import {
  extractCodexApproval,
  extractReviewEvidence,
  extractThreadsPageInfo,
  extractUnresolvedThreads,
  parsePrLink,
  parsePrView,
} from '../src/github';

describe('parsePrLink — injection guard', () => {
  test('accepts a well-formed PR link and parses owner/repo/number', () => {
    expect(parsePrLink('https://github.com/owner-org/repo.name/pull/123')).toEqual({
      host: 'github.com',
      owner: 'owner-org',
      repo: 'repo.name',
      number: 123,
    });
  });
  test('accepts an enterprise host', () => {
    expect(parsePrLink('https://ghe.internal.co/acme/widget/pull/7')?.host).toBe('ghe.internal.co');
  });
  test('rejects an owner containing a double-quote (GraphQL injection attempt)', () => {
    expect(parsePrLink('https://github.com/ev"il/repo/pull/1')).toBeUndefined();
  });
  test('rejects a repo containing a backslash', () => {
    expect(parsePrLink('https://github.com/owner/ev\\il/pull/1')).toBeUndefined();
  });
  test('rejects a non-PR path', () => {
    expect(parsePrLink('https://github.com/owner/repo/issues/1')).toBeUndefined();
  });
});

describe('parsePrView', () => {
  test('reads state/mergeable/mergeStateStatus and falls back safely', () => {
    expect(
      parsePrView({ state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' })
    ).toEqual({
      state: 'OPEN',
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
    });
    expect(parsePrView({})).toEqual({
      state: 'CLOSED',
      mergeable: 'UNKNOWN',
      mergeStateStatus: 'UNKNOWN',
    });
  });
});

describe('extractUnresolvedThreads', () => {
  const envelope = (threads: unknown) => ({
    data: { repository: { pullRequest: { reviewThreads: { nodes: threads } } } },
  });
  test('returns the first-comment URL of unresolved threads only', () => {
    const urls = extractUnresolvedThreads(
      envelope([
        { isResolved: false, comments: { nodes: [{ url: 'https://g.co/x/pull/1#discussion_a' }] } },
        { isResolved: true, comments: { nodes: [{ url: 'https://g.co/x/pull/1#discussion_b' }] } },
        { isResolved: false, comments: { nodes: [{ url: 'https://g.co/x/pull/1#discussion_c' }] } },
      ])
    );
    expect(urls).toEqual([
      'https://g.co/x/pull/1#discussion_a',
      'https://g.co/x/pull/1#discussion_c',
    ]);
  });
  test('returns [] when there are no threads (does not throw on arrays)', () => {
    expect(extractUnresolvedThreads(envelope([]))).toEqual([]);
    // An unresolved thread with no reachable comment URL still COUNTS (with a
    // placeholder) so the gate stays blocked.
    expect(
      extractUnresolvedThreads(envelope([{ isResolved: false, comments: { nodes: [] } }]))
    ).toEqual(['<unavailable thread url>']);
  });
  test('returns [] on a malformed envelope', () => {
    expect(extractUnresolvedThreads({ data: { repository: null } })).toEqual([]);
    expect(extractUnresolvedThreads({})).toEqual([]);
  });
});

describe('extractReviewEvidence', () => {
  const envelope = (pr: unknown) => ({
    data: { viewer: { login: 'reviewer-bot' }, repository: { pullRequest: pr } },
  });
  test('counts formal reviews (APPROVED/CHANGES_REQUESTED) since the window', () => {
    const since = '2026-01-01T00:00:00Z';
    const ev = extractReviewEvidence(
      envelope({
        author: { login: 'coder' },
        reviews: {
          nodes: [
            { state: 'APPROVED', publishedAt: '2026-02-01T00:00:00Z' },
            { state: 'CHANGES_REQUESTED', publishedAt: '2026-02-02T00:00:00Z' },
            { state: 'COMMENTED', publishedAt: '2026-02-03T00:00:00Z' }, // not a formal review
            { state: 'APPROVED', publishedAt: '2025-01-01T00:00:00Z' }, // before window
          ],
        },
        comments: { nodes: [{ createdAt: '2026-02-04T00:00:00Z' }] },
      }),
      since
    );
    expect(ev.formalReviewCount).toBe(2);
    // One conversation comment + one fresh COMMENTED review (own-PR evidence).
    expect(ev.commentEvidenceCount).toBe(2);
    expect(ev.ownPr).toBe(false);
  });
  test('ownPr is true when the viewer authored the PR (enables the comment fallback)', () => {
    const ev = extractReviewEvidence(
      envelope({
        author: { login: 'reviewer-bot' },
        reviews: { nodes: [] },
        comments: { nodes: [] },
      }),
      '2026-01-01T00:00:00Z'
    );
    expect(ev.ownPr).toBe(true);
  });
  test('returns zero counts on a malformed envelope', () => {
    const ev = extractReviewEvidence({ data: { repository: null } }, '2026-01-01T00:00:00Z');
    expect(ev.formalReviewCount).toBe(0);
    expect(ev.commentEvidenceCount).toBe(0);
    expect(ev.ownPr).toBe(false);
  });
});

describe('extractCodexApproval', () => {
  const HEAD = 'a'.repeat(40);
  const base = (overrides: Record<string, unknown>) => ({
    data: {
      repository: {
        pullRequest: {
          reviews: { nodes: [] },
          reactions: { nodes: [] },
          commits: { nodes: [{ commit: { oid: HEAD, pushedDate: '2026-02-01T00:00:00Z' } }] },
          ...overrides,
        },
      },
    },
  });
  const codexAuthor = (login: string) => ({ login, __typename: 'Bot' });

  test('approves on an APPROVED codex review bound to the head commit', () => {
    const r = extractCodexApproval(
      base({
        reviews: {
          nodes: [
            {
              state: 'APPROVED',
              author: codexAuthor('chatgpt-codex-connector'),
              commit: { oid: HEAD },
              submittedAt: '2026-02-02T00:00:00Z',
            },
          ],
        },
      }),
      'https://github.com/o/r/pull/1'
    );
    expect(r.approved).toBe(true);
  });
  test('a later CHANGES_REQUESTED overrides an earlier APPROVED on the same head', () => {
    const r = extractCodexApproval(
      base({
        reviews: {
          nodes: [
            {
              state: 'APPROVED',
              author: codexAuthor('chatgpt-codex-connector'),
              commit: { oid: HEAD },
              submittedAt: '2026-02-02T00:00:00Z',
            },
            {
              state: 'CHANGES_REQUESTED',
              author: codexAuthor('chatgpt-codex-connector'),
              commit: { oid: HEAD },
              submittedAt: '2026-02-03T00:00:00Z',
            },
          ],
        },
      }),
      'https://github.com/o/r/pull/1'
    );
    expect(r.approved).toBe(false);
  });
  test('ignores a codex APPROVED on a prior head (commit oid mismatch)', () => {
    const r = extractCodexApproval(
      base({
        reviews: {
          nodes: [
            {
              state: 'APPROVED',
              author: codexAuthor('chatgpt-codex-connector'),
              commit: { oid: 'b'.repeat(40) },
              submittedAt: '2026-02-02T00:00:00Z',
            },
          ],
        },
      }),
      'https://github.com/o/r/pull/1'
    );
    expect(r.approved).toBe(false);
  });
  test('approves on a fresh THUMBS_UP from the codex bot (User[bot] form) after the push', () => {
    const r = extractCodexApproval(
      base({
        reactions: {
          nodes: [
            {
              createdAt: '2026-02-05T00:00:00Z',
              user: { login: 'chatgpt-codex-connector[bot]', __typename: 'User' },
            },
          ],
        },
      }),
      'https://github.com/o/r/pull/1'
    );
    expect(r.approved).toBe(true);
  });
  test('a stale +1 before the push does not approve', () => {
    const r = extractCodexApproval(
      base({
        reactions: {
          nodes: [
            { createdAt: '2026-01-01T00:00:00Z', user: { login: 'chatgpt-codex-connector[bot]' } },
          ],
        },
      }),
      'https://github.com/o/r/pull/1'
    );
    expect(r.approved).toBe(false);
  });
  test('a human named "codex" does not approve', () => {
    const r = extractCodexApproval(
      base({
        reviews: {
          nodes: [
            {
              state: 'APPROVED',
              author: { login: 'codex-fan', __typename: 'User' },
              commit: { oid: HEAD },
              submittedAt: '2026-02-02T00:00:00Z',
            },
          ],
        },
      }),
      'https://github.com/o/r/pull/1'
    );
    expect(r.approved).toBe(false);
  });
});

describe('extractThreadsPageInfo', () => {
  test('reads hasNextPage/endCursor from a reviewThreads page', () => {
    expect(
      extractThreadsPageInfo({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: true, endCursor: 'Y3Vyc29yOnYyOpK0' },
                nodes: [],
              },
            },
          },
        },
      })
    ).toEqual({ hasNextPage: true, endCursor: 'Y3Vyc29yOnYyOpK0' });
  });
  test('returns undefined for a malformed envelope', () => {
    expect(extractThreadsPageInfo({ data: {} })).toBeUndefined();
  });
});

describe('extractReviewEvidence — COMMENTED own-PR evidence', () => {
  const envelope = (reviews: unknown[], comments: unknown[] = []) => ({
    data: {
      viewer: { login: 'me' },
      repository: {
        pullRequest: {
          author: { login: 'me' },
          reviews: { nodes: reviews },
          comments: { nodes: comments },
        },
      },
    },
  });

  test('a fresh COMMENTED review counts as comment evidence', () => {
    const evidence = extractReviewEvidence(
      envelope([{ state: 'COMMENTED', publishedAt: '2026-08-13T00:00:00Z' }]),
      '2026-08-12T00:00:00Z'
    );
    expect(evidence.commentEvidenceCount).toBe(1);
    expect(evidence.ownPr).toBe(true);
  });

  test('a stale COMMENTED review does not count', () => {
    const evidence = extractReviewEvidence(
      envelope([{ state: 'COMMENTED', publishedAt: '2026-08-01T00:00:00Z' }]),
      '2026-08-12T00:00:00Z'
    );
    expect(evidence.commentEvidenceCount).toBe(0);
  });

  test('COMMENTED does not inflate formalReviewCount', () => {
    const evidence = extractReviewEvidence(
      envelope([{ state: 'COMMENTED', publishedAt: '2026-08-13T00:00:00Z' }]),
      '2026-08-12T00:00:00Z'
    );
    expect(evidence.formalReviewCount).toBe(0);
  });
});

describe('extractCodexApproval — pushedDate on the head Commit', () => {
  const PR_LINK = 'https://github.com/org/repo/pull/42';
  const HEAD = 'a'.repeat(40);
  const base = (pr: Record<string, unknown>) => ({
    data: { repository: { pullRequest: pr } },
  });

  test('reads pushedDate from the head commit (not a PullRequest field)', () => {
    const value = base({
      commits: { nodes: [{ commit: { oid: HEAD, pushedDate: '2026-08-12T00:00:00Z' } }] },
      reviews: { nodes: [] },
      reactions: {
        nodes: [
          { createdAt: '2026-08-13T00:00:00Z', user: { login: 'chatgpt-codex-connector[bot]' } },
        ],
      },
    });
    expect(extractCodexApproval(value, PR_LINK).approved).toBe(true);
  });

  test('a stale +1 older than the head commit push does not pass', () => {
    const value = base({
      commits: { nodes: [{ commit: { oid: HEAD, pushedDate: '2026-08-13T00:00:00Z' } }] },
      reviews: { nodes: [] },
      reactions: {
        nodes: [
          { createdAt: '2026-08-12T00:00:00Z', user: { login: 'chatgpt-codex-connector[bot]' } },
        ],
      },
    });
    expect(extractCodexApproval(value, PR_LINK).approved).toBe(false);
  });
});

describe('extractCodexApproval — review dominance over reactions', () => {
  const PR_LINK = 'https://github.com/org/repo/pull/42';
  const HEAD = 'a'.repeat(40);
  const base = (pr: Record<string, unknown>) => ({ data: { repository: { pullRequest: pr } } });
  const codexReview = (state: string, submittedAt: string, oid = HEAD) => ({
    state,
    submittedAt,
    commit: { oid },
    author: { login: 'chatgpt-codex-connector' },
  });
  const freshReaction = {
    createdAt: '2026-08-13T12:00:00Z',
    user: { login: 'chatgpt-codex-connector[bot]' },
  };

  test('a head-bound CHANGES_REQUESTED dominates a later-looking fresh +1', () => {
    const value = base({
      commits: { nodes: [{ commit: { oid: HEAD, pushedDate: '2026-08-12T00:00:00Z' } }] },
      reviews: { nodes: [codexReview('CHANGES_REQUESTED', '2026-08-13T11:00:00Z')] },
      reactions: { nodes: [freshReaction] },
    });
    expect(extractCodexApproval(value, PR_LINK).approved).toBe(false);
  });

  test('a head-bound APPROVED review approves even alongside a stale +1', () => {
    const value = base({
      commits: { nodes: [{ commit: { oid: HEAD, pushedDate: '2026-08-13T00:00:00Z' } }] },
      reviews: { nodes: [codexReview('APPROVED', '2026-08-13T11:00:00Z')] },
      reactions: { nodes: [freshReaction] },
    });
    expect(extractCodexApproval(value, PR_LINK).approved).toBe(true);
  });

  test('a COMMENTED codex review (no verdict) does not block the fresh-+1 path', () => {
    const value = base({
      commits: { nodes: [{ commit: { oid: HEAD, pushedDate: '2026-08-12T00:00:00Z' } }] },
      reviews: { nodes: [codexReview('COMMENTED', '2026-08-13T11:00:00Z')] },
      reactions: { nodes: [freshReaction] },
    });
    expect(extractCodexApproval(value, PR_LINK).approved).toBe(true);
  });
});

describe('extractReviewEvidence — timestamp precision', () => {
  test('a second-precision timestamp from before the run does not count lexically', () => {
    // Run started 12:00:00.500Z; the review is stamped 12:00:00Z (before the
    // run). A raw lexical compare says '...00Z' >= '...00.500Z' (Z sorts after
    // '.') — the numeric compare must reject it.
    const evidence = extractReviewEvidence(
      {
        data: {
          viewer: { login: 'reviewer' },
          repository: {
            pullRequest: {
              author: { login: 'coder' },
              reviews: { nodes: [{ state: 'APPROVED', publishedAt: '2026-08-13T12:00:00Z' }] },
              comments: { nodes: [] },
            },
          },
        },
      },
      '2026-08-13T12:00:00.500Z'
    );
    expect(evidence.formalReviewCount).toBe(0);
  });

  test('a clearly fresh second-precision timestamp counts', () => {
    const evidence = extractReviewEvidence(
      {
        data: {
          viewer: { login: 'reviewer' },
          repository: {
            pullRequest: {
              author: { login: 'coder' },
              reviews: { nodes: [{ state: 'APPROVED', publishedAt: '2026-08-13T12:00:01Z' }] },
              comments: { nodes: [] },
            },
          },
        },
      },
      '2026-08-13T12:00:00.500Z'
    );
    expect(evidence.formalReviewCount).toBe(1);
  });
});
