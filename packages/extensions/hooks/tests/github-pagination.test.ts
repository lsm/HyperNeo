/**
 * Integration tests for the gh* helpers' pagination loops — the exact code
 * round-9 hardened (multi-page verdict accumulation and the fail-closed page
 * caps). The GraphQL transport is substituted via the test seam so no `gh`
 * process or network is involved.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { HookContext } from '@hyperneo/shared/types/workflow-hooks';
import {
  type GithubResult,
  ghGetCodexApproval,
  ghGetReviewEvidence,
  ghGetUnresolvedReviewThreads,
  isTrustedGitHubHost,
  setGraphqlRunnerForTests,
} from '../src/github';

const PR_LINK = 'https://github.com/org/repo/pull/42';
const HEAD = 'a'.repeat(40);

const CTX: HookContext = {
  runId: 'run-1',
  workspacePath: '/tmp/ws',
  taskId: 'task-1',
  sourceNode: 'Coding',
  readState: () => undefined,
  recordState: () => {},
  queueFollowUp: () => {},
  writeArtifact: () => {},
  readArtifacts: () => [],
};

type Runner = (ctx: HookContext, query: string, host?: string) => Promise<GithubResult<unknown>>;

/** A mock transport serving canned pages in order (keyed by `after:` cursor). */
function pagedRunner(pages: unknown[], onQuery?: (query: string) => void): Runner {
  let call = 0;
  return async (_ctx, query) => {
    onQuery?.(query);
    const page = pages[Math.min(call, pages.length - 1)];
    call += 1;
    return { ok: true, data: page };
  };
}

const codexReview = (state: string, submittedAt: string, oid = HEAD) => ({
  state,
  submittedAt,
  commit: { oid },
  author: { login: 'chatgpt-codex-connector' },
});

const codexPage = (
  reviews: unknown[],
  opts: { hasNext: boolean; cursor?: string; reactions?: unknown[]; pushedDate?: string } = {
    hasNext: false,
  }
) => ({
  data: {
    repository: {
      pullRequest: {
        reviews: {
          nodes: reviews,
          pageInfo: { hasNextPage: opts.hasNext, endCursor: opts.cursor ?? 'cur' },
        },
        reactions: { nodes: opts.reactions ?? [] },
        commits: {
          nodes: [{ commit: { oid: HEAD, pushedDate: opts.pushedDate ?? '2026-08-12T00:00:00Z' } }],
        },
      },
    },
  },
});

const threadPage = (threads: unknown[], hasNext: boolean) => ({
  data: {
    repository: {
      pullRequest: {
        reviewThreads: {
          nodes: threads,
          pageInfo: { hasNextPage: hasNext, endCursor: 'cur' },
        },
      },
    },
  },
});

afterEach(() => setGraphqlRunnerForTests(null));

describe('ghGetCodexApproval — pagination loop', () => {
  test('a CHANGES_REQUESTED beyond page 1 flips the accumulated verdict', async () => {
    // Page 1: an older APPROVED on the head. Page 2: a NEWER
    // CHANGES_REQUESTED on the same head. The first-page prefix would approve;
    // the accumulated history must decline.
    setGraphqlRunnerForTests(
      pagedRunner([
        codexPage([codexReview('APPROVED', '2026-08-13T10:00:00Z')], {
          hasNext: true,
          cursor: 'cDFlbmQ',
        }),
        codexPage([codexReview('CHANGES_REQUESTED', '2026-08-13T11:00:00Z')]),
      ])
    );
    const result = await ghGetCodexApproval(CTX, PR_LINK);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.approved).toBe(false);
  });

  test('follows endCursor across pages', async () => {
    const seenAfters: Array<string | null> = [];
    setGraphqlRunnerForTests(
      pagedRunner(
        [
          codexPage([], { hasNext: true, cursor: 'Y3Vyc29yXzE' }),
          codexPage([], { hasNext: true, cursor: 'Y3Vyc29yXzI' }),
          codexPage([codexReview('APPROVED', '2026-08-13T10:00:00Z')]),
        ],
        (query) => {
          const match = /after:"([^"]*)"/.exec(query);
          seenAfters.push(match ? (match[1] as string) : null);
        }
      )
    );
    const result = await ghGetCodexApproval(CTX, PR_LINK);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.approved).toBe(true);
    // Page 1 has no after; pages 2+ carry the previous page's endCursor; the
    // final entry is the post-scan HEAD RECHECK query (no reviews cursor).
    expect(seenAfters).toEqual([null, 'Y3Vyc29yXzE', 'Y3Vyc29yXzI', null]);
  });

  test('cap exhaustion fails closed with a retryable error', async () => {
    setGraphqlRunnerForTests(pagedRunner([codexPage([], { hasNext: true, cursor: 'eA' })]));
    const result = await ghGetCodexApproval(CTX, PR_LINK);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryable).toBe(true);
      expect(result.error).toContain('fail closed');
    }
  });
});

describe('ghGetUnresolvedReviewThreads — pagination loop', () => {
  test('an unresolved thread beyond page 1 is found', async () => {
    setGraphqlRunnerForTests(
      pagedRunner([
        threadPage([{ isResolved: true, comments: { nodes: [{ url: 'u1' }] } }], true),
        threadPage(
          [{ isResolved: false, comments: { nodes: [{ url: 'https://gb/threads/9' }] } }],
          false
        ),
      ])
    );
    const result = await ghGetUnresolvedReviewThreads(CTX, PR_LINK);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual(['https://gb/threads/9']);
  });

  test('cap exhaustion fails closed with a retryable error', async () => {
    setGraphqlRunnerForTests(pagedRunner([threadPage([], true)]));
    const result = await ghGetUnresolvedReviewThreads(CTX, PR_LINK);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.retryable).toBe(true);
  });
});

describe('isTrustedGitHubHost — GHE Cloud tenants', () => {
  test('accepts *.ghe.com data-residency tenants and exact known hosts', () => {
    expect(isTrustedGitHubHost('mycompany.ghe.com')).toBe(true);
    expect(isTrustedGitHubHost('ghe.com')).toBe(true);
    expect(isTrustedGitHubHost('github.com')).toBe(true);
    expect(isTrustedGitHubHost('GitHub.com')).toBe(true);
  });
  test('rejects lookalikes and arbitrary hosts', () => {
    expect(isTrustedGitHubHost('ghe.com.evil.example')).toBe(false);
    expect(isTrustedGitHubHost('mycompany.ghe.com.evil.example')).toBe(false);
    expect(isTrustedGitHubHost('evil.example')).toBe(false);
    expect(isTrustedGitHubHost('notghe.com')).toBe(false);
  });
});

describe('ghGetUnresolvedReviewThreads — structural fail-closed', () => {
  test('a thread node missing boolean isResolved fails closed', async () => {
    // A node without a boolean isResolved would be SKIPPED as though
    // resolved — pr_ready could deliver without proving the conversation
    // was checked. Both {} and { isResolved: null } must fail the lookup.
    for (const node of [{}, { isResolved: null }]) {
      setGraphqlRunnerForTests(pagedRunner([threadPage([node], false)]));
      const result = await ghGetUnresolvedReviewThreads(CTX, PR_LINK);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.retryable).toBe(true);
        expect(result.error).toContain('isResolved');
      }
    }
  });

  test('a successful envelope missing the threads connection fails closed', async () => {
    setGraphqlRunnerForTests(async () => ({
      ok: true,
      data: { data: { repository: { pullRequest: {} } } },
    }));
    const result = await ghGetUnresolvedReviewThreads(CTX, PR_LINK);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryable).toBe(true);
      expect(result.error).toContain('failing closed');
    }
  });

  test('a connection missing pageInfo fails closed', async () => {
    setGraphqlRunnerForTests(async () => ({
      ok: true,
      data: {
        data: {
          repository: {
            pullRequest: { reviewThreads: { nodes: [] } },
          },
        },
      },
    }));
    const result = await ghGetUnresolvedReviewThreads(CTX, PR_LINK);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('pageInfo');
  });
});

describe('ghGetReviewEvidence — back-pagination past the fresh window', () => {
  const reviewPage = (reviews: unknown[], hasPrevious: boolean, startCursor?: string) => ({
    data: {
      viewer: { login: 'reviewer' },
      repository: {
        pullRequest: {
          author: { login: 'coder' },
          reviews: {
            nodes: reviews,
            pageInfo: { hasPreviousPage: hasPrevious, startCursor: startCursor ?? 'Y3Vy' },
          },
          comments: { nodes: [] },
        },
      },
    },
  });

  test('a formal review under >50 newer COMMENTED reviews is found', async () => {
    const commented = Array.from({ length: 50 }, (_, i) => ({
      state: 'COMMENTED',
      publishedAt: `2026-08-13T12:${String(i).padStart(2, '0')}:00Z`,
    }));
    setGraphqlRunnerForTests(
      pagedRunner([
        reviewPage(commented, true, 'cGFnZTE'),
        reviewPage(
          [
            { state: 'APPROVED', publishedAt: '2026-08-13T11:00:00Z' },
            { state: 'CHANGES_REQUESTED', publishedAt: '2026-08-01T00:00:00Z' }, // before window
          ],
          false
        ),
      ])
    );
    const result = await ghGetReviewEvidence(CTX, PR_LINK, '2026-08-12T00:00:00Z');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.formalReviewCount).toBe(1);
      expect(result.data.ownPr).toBe(false);
    }
  });

  test('fractional-second timestamps do not stop pagination early', async () => {
    // The page boundary must compare EPOCHS, not lexical strings: GitHub may
    // return '...12:00:00.500Z' while sinceIso is whole-second '...12:00:00Z'.
    // Lexically '.500Z' sorts BEFORE 'Z', so the actually-newer review would
    // read as older and pagination would stop on page 1 — dropping the
    // qualifying APPROVED on page 2 and incorrectly blocking review_posted.
    const freshFractional = Array.from({ length: 50 }, (_, i) => ({
      state: 'COMMENTED',
      publishedAt: `2026-08-13T12:00:${String(i).padStart(2, '0')}.500Z`,
    }));
    setGraphqlRunnerForTests(
      pagedRunner([
        reviewPage(freshFractional, true, 'cGFnZTE'),
        reviewPage([{ state: 'APPROVED', publishedAt: '2026-08-13T12:00:00.250Z' }], false),
      ])
    );
    const result = await ghGetReviewEvidence(CTX, PR_LINK, '2026-08-13T12:00:00Z');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.formalReviewCount).toBe(1);
  });

  test('cap exhaustion inside the fresh window fails closed', async () => {
    const fresh = Array.from({ length: 50 }, (_, i) => ({
      state: 'COMMENTED',
      publishedAt: `2026-08-13T12:${String(i).padStart(2, '0')}:00Z`,
    }));
    setGraphqlRunnerForTests(pagedRunner([reviewPage(fresh, true, 'cGFnZTE')]));
    const result = await ghGetReviewEvidence(CTX, PR_LINK, '2026-08-12T00:00:00Z');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.retryable).toBe(true);
  });

  test('an own-PR comment buried under >50 newer comments is found', async () => {
    // The reviews walk re-fetches the same comments TAIL every page; without
    // comments back-pagination the qualifying comment never enters the
    // window and review_posted blocks a valid handoff.
    const tail = Array.from({ length: 50 }, (_, i) => ({
      createdAt: `2026-08-13T12:${String(i).padStart(2, '0')}:00Z`,
    }));
    const page1 = {
      data: {
        viewer: { login: 'reviewer' },
        repository: {
          pullRequest: {
            author: { login: 'reviewer' },
            reviews: { nodes: [], pageInfo: { hasPreviousPage: false } },
            comments: {
              nodes: tail,
              pageInfo: { hasPreviousPage: true, startCursor: 'cGFnZTE' },
            },
          },
        },
      },
    };
    const page2 = {
      data: {
        repository: {
          pullRequest: {
            comments: {
              // The qualifying comment (after since) plus an older one that
              // closes the run-start boundary.
              nodes: [{ createdAt: '2026-08-13T11:30:00Z' }, { createdAt: '2026-08-13T10:00:00Z' }],
              pageInfo: { hasPreviousPage: false },
            },
          },
        },
      },
    };
    setGraphqlRunnerForTests(pagedRunner([page1, page2]));
    const result = await ghGetReviewEvidence(CTX, PR_LINK, '2026-08-13T11:00:00Z');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.commentEvidenceCount).toBe(51);
  });

  test('an own-PR comments connection without a boolean hasPreviousPage fails closed', async () => {
    // The page carries comment nodes but a missing/non-boolean flag — older
    // pages may hold the qualifying comment, so the scan must fail closed
    // rather than declare itself complete.
    const page1 = {
      data: {
        viewer: { login: 'reviewer' },
        repository: {
          pullRequest: {
            author: { login: 'reviewer' }, // own PR
            reviews: { nodes: [], pageInfo: { hasPreviousPage: false } },
            comments: {
              nodes: [{ createdAt: '2026-08-13T12:00:00Z' }],
              pageInfo: { hasPreviousPage: true }, // no startCursor below → would break; but the flag check fires first only if non-boolean
            },
          },
        },
      },
    };
    // Make the flag non-boolean to exercise the guard.
    (
      page1.data.repository.pullRequest.comments.pageInfo as { hasPreviousPage?: unknown }
    ).hasPreviousPage = undefined;
    setGraphqlRunnerForTests(pagedRunner([page1]));
    const result = await ghGetReviewEvidence(CTX, PR_LINK, '2026-08-12T00:00:00Z');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryable).toBe(true);
      expect(result.error).toContain('hasPreviousPage');
    }
  });

  test('decisive formal evidence skips the comments scan entirely', async () => {
    // A qualifying formal review decides the gate regardless of comments
    // (and comments are only eligible on an own PR) — a malformed or absent
    // comments connection must NOT block an already-decisive review.
    const page1 = {
      data: {
        viewer: { login: 'reviewer' },
        repository: {
          pullRequest: {
            author: { login: 'coder' },
            reviews: {
              nodes: [{ state: 'APPROVED', publishedAt: '2026-08-13T12:00:00Z' }],
              pageInfo: { hasPreviousPage: false },
            },
            // comments connection omitted entirely
          },
        },
      },
    };
    setGraphqlRunnerForTests(pagedRunner([page1]));
    const result = await ghGetReviewEvidence(CTX, PR_LINK, '2026-08-13T00:00:00Z');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.formalReviewCount).toBe(1);
  });

  test('a final page without a comments connection fails closed', async () => {
    // An absent connection must not read as "no comments to scan": that
    // would report zero own-PR evidence and block a valid handoff instead
    // of surfacing the malformed response.
    const page1 = {
      data: {
        viewer: { login: 'reviewer' },
        repository: {
          pullRequest: {
            // Own PR: comment evidence is eligible, so the comments path
            // runs and the absent connection must fail it closed.
            author: { login: 'reviewer' },
            reviews: { nodes: [], pageInfo: { hasPreviousPage: false } },
            // comments connection omitted entirely
          },
        },
      },
    };
    setGraphqlRunnerForTests(pagedRunner([page1]));
    const result = await ghGetReviewEvidence(CTX, PR_LINK, '2026-08-12T00:00:00Z');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryable).toBe(true);
      expect(result.error).toContain('comments connection');
    }
  });

  test('comments cap exhaustion inside the fresh window fails closed', async () => {
    const tail = Array.from({ length: 50 }, (_, i) => ({
      createdAt: `2026-08-13T12:${String(i).padStart(2, '0')}:00Z`,
    }));
    // Every comments page claims more history — the scan cannot prove the
    // window complete, so it must fail closed rather than under-count.
    const commentsConn = {
      nodes: tail,
      pageInfo: { hasPreviousPage: true, startCursor: 'cGFnZTE' },
    };
    const page1 = {
      data: {
        viewer: { login: 'reviewer' },
        repository: {
          pullRequest: {
            // Own PR: comment evidence is eligible, so the comments walk
            // runs and its cap exhaustion fails closed.
            author: { login: 'reviewer' },
            reviews: { nodes: [], pageInfo: { hasPreviousPage: false } },
            comments: commentsConn,
          },
        },
      },
    };
    const endless = {
      data: {
        repository: {
          pullRequest: { comments: commentsConn },
        },
      },
    };
    setGraphqlRunnerForTests(pagedRunner([page1, endless]));
    const result = await ghGetReviewEvidence(CTX, PR_LINK, '2026-08-13T00:00:00Z');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryable).toBe(true);
      expect(result.error).toContain('comments since the run started');
    }
  });
});

describe('ghGetCodexApproval — reaction back-pagination', () => {
  const reactionsPage = (
    reactions: unknown[],
    hasPrevious: boolean,
    startCursor: string,
    pushedDate = '2026-08-12T00:00:00Z'
  ) => ({
    data: {
      repository: {
        pullRequest: {
          reviews: { nodes: [], pageInfo: { hasNextPage: false, endCursor: 'cGFnZQ' } },
          reactions: {
            nodes: reactions,
            pageInfo: { hasPreviousPage: hasPrevious, startCursor },
          },
          commits: { nodes: [{ commit: { oid: HEAD, pushedDate } }] },
        },
      },
    },
  });
  const freshReaction = (minuteOfHour: number, login = 'chatgpt-codex-connector[bot]') => ({
    createdAt: `2026-08-13T12:${String(minuteOfHour).padStart(2, '0')}:00Z`,
    user: { login },
  });

  test('a codex +1 under >50 newer reactions is found via before-cursor walk', async () => {
    // Tail page: 50 newer non-codex thumbs; previous page holds the codex +1
    // (12:00 vs the pushedDate of 2026-08-12 — both fresh, but the walk must
    // reach it).
    const newer = Array.from({ length: 50 }, (_, i) => freshReaction(i, 'someone-else'));
    setGraphqlRunnerForTests(
      pagedRunner([
        reactionsPage(newer, true, 'cmVhY3Rpb24tMQ'),
        reactionsPage([freshReaction(0)], false, 'cGFnZTI'),
      ])
    );
    const result = await ghGetCodexApproval(CTX, PR_LINK);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.approved).toBe(true);
  });

  test('a fresh codex +1 in the INITIAL tail page approves without any walk', async () => {
    // <=50 reactions: no back-pagination happens, so the initial page must
    // be the one evaluated (an asRecord-on-array bug once dropped it).
    setGraphqlRunnerForTests(
      pagedRunner([
        reactionsPage(
          [
            {
              createdAt: '2026-08-13T12:00:00Z',
              user: { login: 'chatgpt-codex-connector[bot]' },
            },
          ],
          false,
          'cGFnZQ'
        ),
      ])
    );
    const result = await ghGetCodexApproval(CTX, PR_LINK);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.approved).toBe(true);
  });

  test('reaction cap exhaustion inside the fresh window fails closed', async () => {
    const newer = Array.from({ length: 50 }, (_, i) => freshReaction(i, 'someone-else'));
    setGraphqlRunnerForTests(pagedRunner([reactionsPage(newer, true, 'cmVhY3Rpb24tMQ')]));
    const result = await ghGetCodexApproval(CTX, PR_LINK);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.retryable).toBe(true);
  });
});

describe('reviewThreads pageInfo completeness', () => {
  test('a pageInfo object missing hasNextPage fails closed', async () => {
    setGraphqlRunnerForTests(async () => ({
      ok: true,
      data: {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: { nodes: [], pageInfo: { endCursor: 'Y3Vy' } },
            },
          },
        },
      },
    }));
    const result = await ghGetUnresolvedReviewThreads(CTX, PR_LINK);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('hasNextPage');
  });
});

describe('ghGetCodexApproval — final head recheck', () => {
  const approvalPage = (headOid: string) => ({
    data: {
      repository: {
        pullRequest: {
          reviews: {
            nodes: [
              {
                state: 'APPROVED',
                submittedAt: '2026-08-13T10:00:00Z',
                commit: { oid: headOid },
                author: { login: 'chatgpt-codex-connector' },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: 'cGFnZQ' },
          },
          reactions: { nodes: [], pageInfo: { hasPreviousPage: false, startCursor: 'Y3Vy' } },
          commits: { nodes: [{ commit: { oid: headOid, pushedDate: '2026-08-12T00:00:00Z' } }] },
        },
      },
    },
  });

  test('an approval against a head that moved during the scan retries (fail closed)', async () => {
    let call = 0;
    setGraphqlRunnerForTests(async () => {
      call += 1;
      // Page 1 approves against HEAD; the head-recheck query (call 2) sees a
      // NEW head — the push landed mid-scan.
      return call === 1
        ? { ok: true, data: approvalPage(HEAD) }
        : { ok: true, data: approvalPage(`${'b'.repeat(40)}`) };
    });
    const result = await ghGetCodexApproval(CTX, PR_LINK);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryable).toBe(true);
      expect(result.error).toContain('head changed');
    }
  });

  test('an approval against the still-current head is returned', async () => {
    setGraphqlRunnerForTests(async () => ({ ok: true, data: approvalPage(HEAD) }));
    const result = await ghGetCodexApproval(CTX, PR_LINK);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.approved).toBe(true);
  });
});

// ─── deadline budget ────────────────────────────────────────────────────────
//
// ghGetCodexApproval shares ONE deadline across reviews + reactions + the
// final head recheck, checking remainingBudget() before each request. These
// tests drive that boundary by faking the clock: without the budget checks an
// off-by-one (or a silently ignored timeoutMs) would let the multi-request
// scan page on unbounded with nothing catching it.

describe('ghGetCodexApproval — malformed codex evidence', () => {
  test('a malformed head-bound codex review fails the lookup closed (retryable)', async () => {
    // A fresh reaction sits alongside the unreadable verdict: the gate must
    // NOT approve through the reaction path.
    setGraphqlRunnerForTests(async () => ({
      ok: true,
      data: {
        data: {
          repository: {
            pullRequest: {
              reviews: {
                nodes: [
                  {
                    // state omitted; submittedAt present
                    author: { login: 'chatgpt-codex-connector' },
                    commit: { oid: HEAD },
                    submittedAt: '2026-08-13T10:00:00Z',
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: 'cGFnZQ' },
              },
              reactions: {
                nodes: [
                  {
                    createdAt: '2026-08-13T12:00:00Z',
                    user: { login: 'chatgpt-codex-connector[bot]' },
                  },
                ],
              },
              commits: {
                nodes: [{ commit: { oid: HEAD, pushedDate: '2026-08-12T00:00:00Z' } }],
              },
            },
          },
        },
      },
    }));
    const result = await ghGetCodexApproval(CTX, PR_LINK);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryable).toBe(true);
      expect(result.error).toContain('failing closed');
    }
  });
});

describe('ghGetCodexApproval — decisive review skips the reaction walk', () => {
  test('a head-bound APPROVED is returned without back-paginating reactions', async () => {
    // The reactions connection claims more history but carries no usable
    // startCursor — walking it would fail closed. A decisive APPROVED must
    // be evaluated first and returned without the walk.
    setGraphqlRunnerForTests(async () => ({
      ok: true,
      data: {
        data: {
          repository: {
            pullRequest: {
              reviews: {
                nodes: [
                  {
                    state: 'APPROVED',
                    submittedAt: '2026-08-13T10:00:00Z',
                    commit: { oid: HEAD },
                    author: { login: 'chatgpt-codex-connector' },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: 'cGFnZQ' },
              },
              reactions: {
                nodes: [],
                pageInfo: { hasPreviousPage: true }, // no startCursor
              },
              commits: {
                nodes: [{ commit: { oid: HEAD, pushedDate: '2026-08-12T00:00:00Z' } }],
              },
            },
          },
        },
      },
    }));
    const result = await ghGetCodexApproval(CTX, PR_LINK);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.approved).toBe(true);
  });
});

test('a non-decisive response missing reactions hasPreviousPage fails closed', async () => {
  // No decisive review → reaction path runs → a malformed reactions
  // connection must fail closed rather than read as 'no reactions'.
  setGraphqlRunnerForTests(async () => ({
    ok: true,
    data: {
      data: {
        repository: {
          pullRequest: {
            reviews: { nodes: [], pageInfo: { hasNextPage: false } },
            reactions: { nodes: [] }, // pageInfo omitted
            commits: {
              nodes: [{ commit: { oid: HEAD, pushedDate: '2026-08-12T00:00:00Z' } }],
            },
          },
        },
      },
    },
  }));
  const result = await ghGetCodexApproval(CTX, PR_LINK);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.retryable).toBe(true);
    expect(result.error).toContain('reactions connection');
  }
});

test('an unparseable reaction boundary timestamp fails closed', async () => {
  setGraphqlRunnerForTests(async () => ({
    ok: true,
    data: {
      data: {
        repository: {
          pullRequest: {
            reviews: { nodes: [], pageInfo: { hasNextPage: false } },
            reactions: {
              nodes: [{ createdAt: 'not-a-date', user: { login: 'chatgpt-codex-connector' } }],
              pageInfo: { hasPreviousPage: true, startCursor: 'Y3Vyc29y' },
            },
            commits: {
              nodes: [{ commit: { oid: HEAD, pushedDate: '2026-08-12T00:00:00Z' } }],
            },
          },
        },
      },
    },
  }));
  const result = await ghGetCodexApproval(CTX, PR_LINK);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.retryable).toBe(true);
    expect(result.error).toContain('timestamp boundary');
  }
});

describe('ghGetCodexApproval — overall deadline budget', () => {
  const realNow = Date.now;

  afterEach(() => {
    Date.now = realNow;
    setGraphqlRunnerForTests(null);
  });

  test('budget exhausted mid-pagination fails closed with a retryable deadline error', async () => {
    let now = realNow();
    Date.now = () => now;
    setGraphqlRunnerForTests(async () => {
      // Serve page 1, then advance the clock past the 30s overall budget: the
      // pagination loop must observe the exhausted budget before requesting
      // page 2 rather than paging on.
      now += 31_000;
      return { ok: true, data: codexPage([], { hasNext: true, cursor: 'Y3Vyc29yXzE' }) };
    });
    const result = await ghGetCodexApproval(CTX, PR_LINK);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryable).toBe(true);
      expect(result.error).toContain('deadline');
    }
  });

  test('budget exhausted before the final head recheck fails closed', async () => {
    let now = realNow();
    Date.now = () => now;
    setGraphqlRunnerForTests(async () => {
      // Serve the approving page, then burn the clock past the budget: the
      // scan extracts an approval, and the head-recheck budget guard fires
      // BEFORE the recheck request — the gate must retry (fail closed)
      // instead of approving against a possibly-stale head.
      now += 31_000;
      return { ok: true, data: codexPage([codexReview('APPROVED', '2026-08-13T10:00:00Z')]) };
    });
    const result = await ghGetCodexApproval(CTX, PR_LINK);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryable).toBe(true);
      expect(result.error).toContain('deadline');
    }
  });
});
