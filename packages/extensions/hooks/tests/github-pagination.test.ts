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
          pageInfo: { hasPreviousPage: opts.hasNext, startCursor: opts.cursor ?? 'Y3Vy' },
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
  test('an OLDER APPROVED beyond page 1 does not flip the newest CHANGES_REQUESTED', async () => {
    // Backward pagination: page 1 is the NEWEST — a CHANGES_REQUESTED on the
    // head. Page 2 holds an OLDER APPROVED on the same head. The newest page
    // already decides (the early exit fires), and the accumulated verdict
    // must decline regardless of the older approval.
    let calls = 0;
    setGraphqlRunnerForTests(async (ctx: unknown, query: string) => {
      calls += 1;
      const page =
        calls === 1
          ? codexPage([codexReview('CHANGES_REQUESTED', '2026-08-13T11:00:00Z')], {
              hasNext: true,
              cursor: 'cDFlbmQ',
            })
          : codexPage([codexReview('APPROVED', '2026-08-13T10:00:00Z')]);
      return { ok: true as const, data: page };
    });
    const result = await ghGetCodexApproval(CTX, PR_LINK);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.approved).toBe(false);
    // PIN the early exit: the decisive verdict on page 1 must stop the scan —
    // fetching page 2 (plus a head recheck) means the exit did not fire.
    // The decisive CHANGES_REQUESTED returns at the not-approved early return
    // (before the head recheck): page 1 = exactly 1 call.
    expect(calls).toBe(1);
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
          const match = /before:"([^"]*)"/.exec(query);
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

// ─── normal-path reaction walk early stop ───────────────────────────────────
//
// The normal (non-boundary) reaction back-walk evaluates the accumulated
// window after every page too: a fresh codex +1 already collected is a
// proven approval, and paging on would let a later error/cap convert it
// into a retryable error.

describe('ghGetCodexApproval — reaction walk early stop', () => {
  test('stops normal-path reaction paging once approval is proven', async () => {
    // No decisive review (COMMENTED only) and an empty seed reaction tail
    // with more history: the walk pages back; page 2 carries the fresh
    // codex +1 but claims MORE history; page 3 errors. The approval must
    // be established at page 2 — page 3 is never requested; only the head
    // recheck follows.
    let calls = 0;
    setGraphqlRunnerForTests(async () => {
      calls += 1;
      if (calls === 1) {
        return {
          ok: true,
          data: {
            data: {
              repository: {
                pullRequest: {
                  reviews: {
                    nodes: [codexReview('COMMENTED', '2026-08-13T11:00:00Z')],
                    pageInfo: { hasPreviousPage: false },
                  },
                  // Empty tail but more history behind it — the walk starts.
                  reactions: {
                    nodes: [],
                    pageInfo: { hasPreviousPage: true, startCursor: 'Y3Vyc29yXzE' },
                  },
                  commits: {
                    nodes: [{ commit: { oid: HEAD, pushedDate: '2026-08-12T00:00:00Z' } }],
                  },
                },
              },
            },
          },
        };
      }
      if (calls === 2) {
        return {
          ok: true,
          data: {
            data: {
              repository: {
                pullRequest: {
                  reactions: {
                    nodes: [
                      {
                        createdAt: '2026-08-13T12:00:00Z',
                        user: { login: 'chatgpt-codex-connector[bot]' },
                      },
                    ],
                    pageInfo: { hasPreviousPage: true, startCursor: 'Y3Vyc29yXzI' },
                  },
                  commits: {
                    nodes: [{ commit: { oid: HEAD, pushedDate: '2026-08-12T00:00:00Z' } }],
                  },
                },
              },
            },
          },
        };
      }
      if (calls === 3) {
        // The post-approval head recheck — serve the unmoved head.
        return {
          ok: true,
          data: {
            data: {
              repository: {
                pullRequest: { commits: { nodes: [{ commit: { oid: HEAD } }] } },
              },
            },
          },
        };
      }
      return { ok: false, retryable: true, error: 'unexpected extra page request' };
    });
    const result = await ghGetCodexApproval(CTX, PR_LINK);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.approved).toBe(true);
    // Page 1 (reviews+seed) + page 2 (walk, proven) + head recheck = 3.
    expect(calls).toBe(3);
  });
});

// ─── boundary path ──────────────────────────────────────────────────────────
//
// The reviews loop can break at the HEAD-PUSH WINDOW (a page whose oldest
// review predates the head push) instead of at history exhaustion or a
// decisive verdict. That lands in the boundary block: the last page's
// reactions are walked backward with the same window stop + cap fail-closed
// as the normal path, and the merged document is re-evaluated. These tests
// pin that block's three outcomes.

describe('ghGetCodexApproval — boundary path', () => {
  /** A page whose oldest review predates the head push: the loop breaks at
   * the head-push window with no decisive verdict → boundary block. */
  const breakPage = (reactions: unknown, reactionPageInfo: unknown) => ({
    data: {
      repository: {
        pullRequest: {
          reviews: {
            // APPROVED but on a STALE commit (not head-bound) and dated
            // before the head push — not decisive, and the boundary break
            // fires on the pre-push date.
            nodes: [codexReview('APPROVED', '2026-08-11T10:00:00Z', 'b'.repeat(40))],
            pageInfo: { hasPreviousPage: true, startCursor: 'Y3Vyc29yXzA' },
          },
          reactions: { nodes: reactions, pageInfo: reactionPageInfo },
          commits: {
            nodes: [{ commit: { oid: HEAD, pushedDate: '2026-08-12T00:00:00Z' } }],
          },
        },
      },
    },
  });

  test('a not-approved boundary result returns settled (no false head-changed retry)', async () => {
    // The not-approved fall-through carries no evaluatedHeadOid — the early
    // return before the head recheck is what keeps every settled negative
    // from being misread as "PR head changed" and retried forever.
    setGraphqlRunnerForTests(pagedRunner([breakPage([], { hasPreviousPage: false })]));
    const result = await ghGetCodexApproval(CTX, PR_LINK);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.approved).toBe(false);
  });

  test('walks boundary reactions backward and approves on a fresh codex +1', async () => {
    // The break page's reaction tail holds only a non-codex fresh +1 with
    // more history behind it; page 2 of the reaction walk carries the fresh
    // codex +1; the post-approval head recheck confirms the head is unmoved.
    setGraphqlRunnerForTests(
      pagedRunner([
        breakPage([{ createdAt: '2026-08-13T12:00:00Z', user: { login: 'someone' } }], {
          hasPreviousPage: true,
          startCursor: 'Y3Vyc29yXzE',
        }),
        {
          data: {
            repository: {
              pullRequest: {
                reactions: {
                  nodes: [
                    {
                      createdAt: '2026-08-13T11:00:00Z',
                      user: { login: 'chatgpt-codex-connector[bot]' },
                    },
                  ],
                  pageInfo: { hasPreviousPage: false },
                },
                commits: {
                  nodes: [{ commit: { oid: HEAD, pushedDate: '2026-08-12T00:00:00Z' } }],
                },
              },
            },
          },
        },
        {
          data: {
            repository: {
              pullRequest: {
                commits: { nodes: [{ commit: { oid: HEAD } }] },
              },
            },
          },
        },
      ])
    );
    const result = await ghGetCodexApproval(CTX, PR_LINK);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.approved).toBe(true);
  });

  test('stops boundary reaction paging once approval is proven', async () => {
    // Page 2 carries the fresh codex +1 but claims MORE history behind it.
    // The accumulated window is evaluated after every page, so the proven
    // approval must stop the walk immediately — page 3 (which errors here)
    // must never be requested; only the post-approval head recheck runs.
    let calls = 0;
    setGraphqlRunnerForTests(async () => {
      calls += 1;
      if (calls === 1) {
        return {
          ok: true,
          data: breakPage([{ createdAt: '2026-08-13T12:00:00Z', user: { login: 'someone' } }], {
            hasPreviousPage: true,
            startCursor: 'Y3Vyc29yXzE',
          }),
        };
      }
      if (calls === 2) {
        return {
          ok: true,
          data: {
            data: {
              repository: {
                pullRequest: {
                  reactions: {
                    nodes: [
                      {
                        createdAt: '2026-08-13T11:00:00Z',
                        user: { login: 'chatgpt-codex-connector[bot]' },
                      },
                    ],
                    // More history claimed behind a valid cursor.
                    pageInfo: { hasPreviousPage: true, startCursor: 'Y3Vyc29yXzI' },
                  },
                  commits: {
                    nodes: [{ commit: { oid: HEAD, pushedDate: '2026-08-12T00:00:00Z' } }],
                  },
                },
              },
            },
          },
        };
      }
      if (calls === 3) {
        // The head recheck (expected) — serve the unmoved head.
        return {
          ok: true,
          data: {
            data: {
              repository: {
                pullRequest: { commits: { nodes: [{ commit: { oid: HEAD } }] } },
              },
            },
          },
        };
      }
      return { ok: false, retryable: true, error: 'unexpected extra page request' };
    });
    const result = await ghGetCodexApproval(CTX, PR_LINK);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.approved).toBe(true);
    // Page 1 (reviews) + page 2 (reaction walk, proven) + head recheck = 3.
    expect(calls).toBe(3);
  });

  test('a boundary approval against a moved head fails closed as retryable', async () => {
    setGraphqlRunnerForTests(
      pagedRunner([
        breakPage(
          [
            {
              createdAt: '2026-08-13T12:00:00Z',
              user: { login: 'chatgpt-codex-connector[bot]' },
            },
          ],
          { hasPreviousPage: false }
        ),
        {
          data: {
            repository: {
              pullRequest: {
                commits: { nodes: [{ commit: { oid: 'c'.repeat(40) } }] },
              },
            },
          },
        },
      ])
    );
    const result = await ghGetCodexApproval(CTX, PR_LINK);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryable).toBe(true);
      expect(result.error).toContain('PR head changed');
    }
  });

  test('a boundary page missing the reactions connection fails closed', async () => {
    // The break page's reactions connection is ABSENT — previously read as
    // "no reactions to scan" and reported a settled negative that could hide
    // a fresh codex +1 on an unread page.
    const page = breakPage([], { hasPreviousPage: false }) as {
      data?: { repository?: { pullRequest?: Record<string, unknown> } };
    };
    delete page.data?.repository?.pullRequest?.reactions;
    setGraphqlRunnerForTests(pagedRunner([page]));
    const result = await ghGetCodexApproval(CTX, PR_LINK);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryable).toBe(true);
      expect(result.error).toContain('reactions connection');
    }
  });

  test('a boundary page with non-boolean reactions hasPreviousPage fails closed', async () => {
    const page = breakPage([{ createdAt: '2026-08-13T12:00:00Z', user: { login: 'x' } }], {
      hasPreviousPage: 'yes',
    } as never);
    setGraphqlRunnerForTests(pagedRunner([page]));
    const result = await ghGetCodexApproval(CTX, PR_LINK);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryable).toBe(true);
      expect(result.error).toContain('hasPreviousPage');
    }
  });

  test('a boundary codex seed reaction with a malformed timestamp fails closed', async () => {
    const page = breakPage(
      [{ createdAt: 'not-a-date', user: { login: 'chatgpt-codex-connector' } }],
      { hasPreviousPage: false }
    );
    setGraphqlRunnerForTests(pagedRunner([page]));
    const result = await ghGetCodexApproval(CTX, PR_LINK);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryable).toBe(true);
      expect(result.error).toContain('codex reaction timestamp');
    }
  });

  test('boundary reaction-walk cap exhaustion fails closed', async () => {
    // Every walk page stays newer than the head push and claims more
    // history: the walk hits MAX_CODEX_REVIEW_PAGES and must fail closed
    // with the same cap error as the normal path — a partial window is an
    // unprovable scan, not a settled negative.
    setGraphqlRunnerForTests(
      pagedRunner([
        breakPage([{ createdAt: '2026-08-13T12:00:00Z', user: { login: 'someone' } }], {
          hasPreviousPage: true,
          startCursor: 'Y3Vyc29yXzE',
        }),
        {
          data: {
            repository: {
              pullRequest: {
                reactions: {
                  nodes: [{ createdAt: '2026-08-13T11:00:00Z', user: { login: 'someone' } }],
                  pageInfo: { hasPreviousPage: true, startCursor: 'Y3Vyc29yXzI' },
                },
                commits: {
                  nodes: [{ commit: { oid: HEAD, pushedDate: '2026-08-12T00:00:00Z' } }],
                },
              },
            },
          },
        },
      ])
    );
    const result = await ghGetCodexApproval(CTX, PR_LINK);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryable).toBe(true);
      expect(result.error).toContain('fresh reactions');
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
    // The tail's fresh comments already prove the gate — the walk is SKIPPED
    // (its outcome cannot change a positive result), so the count is the
    // tail's 50, not 50 + the buried one.
    if (result.ok) expect(result.data.commentEvidenceCount).toBe(50);
  });

  test('stops comment paging once positive evidence is fetched', async () => {
    // Page 2 carries the first fresh qualifying comment but claims MORE
    // history behind it; page 3 errors. The accumulated comments are
    // re-evaluated after every page, so the proven positive must stop the
    // walk before page 3 can convert it into a retryable error.
    let calls = 0;
    setGraphqlRunnerForTests(async () => {
      calls += 1;
      if (calls === 1) {
        return {
          ok: true,
          data: {
            data: {
              viewer: { login: 'reviewer' },
              repository: {
                pullRequest: {
                  author: { login: 'reviewer' },
                  reviews: { nodes: [], pageInfo: { hasPreviousPage: false } },
                  comments: {
                    nodes: [],
                    pageInfo: { hasPreviousPage: true, startCursor: 'cGFnZTE' },
                  },
                },
              },
            },
          },
        };
      }
      if (calls === 2) {
        return {
          ok: true,
          data: {
            data: {
              repository: {
                pullRequest: {
                  comments: {
                    // Fresh (after since 2026-08-13T11:00) and still more
                    // history claimed behind a valid cursor.
                    nodes: [{ createdAt: '2026-08-13T11:30:00Z' }],
                    pageInfo: { hasPreviousPage: true, startCursor: 'cGFnZTI' },
                  },
                },
              },
            },
          },
        };
      }
      return { ok: false, retryable: true, error: 'unexpected extra page request' };
    });
    const result = await ghGetReviewEvidence(CTX, PR_LINK, '2026-08-13T11:00:00Z');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.commentEvidenceCount).toBe(1);
    // Page 1 (reviews+comments seed) + page 2 (positive found) = 2 calls.
    expect(calls).toBe(2);
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
              // OLD comment (before the window): no tail evidence is proven,
              // so the walk must run and hit the non-boolean flag guard.
              nodes: [{ createdAt: '2026-08-11T00:00:00Z' }],
              pageInfo: { hasPreviousPage: true },
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

  test('a fresh tail comment proves the gate and skips the walk entirely', async () => {
    // Round 62: positive own-PR comment evidence in the tail short-circuits
    // the comments walk — an un-walkable older connection (hasPreviousPage
    // true, no usable cursor) cannot turn proven evidence into an error.
    const page1 = {
      data: {
        viewer: { login: 'reviewer' },
        repository: {
          pullRequest: {
            author: { login: 'reviewer' }, // own PR
            reviews: { nodes: [], pageInfo: { hasPreviousPage: false } },
            comments: {
              nodes: [{ createdAt: '2026-08-13T12:00:00Z' }], // fresh
              pageInfo: { hasPreviousPage: true, startCursor: 'garbage' },
            },
          },
        },
      },
    };
    setGraphqlRunnerForTests(pagedRunner([page1]));
    const result = await ghGetReviewEvidence(CTX, PR_LINK, '2026-08-13T00:00:00Z');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.commentEvidenceCount).toBeGreaterThanOrEqual(1);
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
          reviews: { nodes: [], pageInfo: { hasPreviousPage: false } },
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
            pageInfo: { hasPreviousPage: false },
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
                pageInfo: { hasPreviousPage: false },
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
                pageInfo: { hasPreviousPage: false },
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
            reviews: { nodes: [], pageInfo: { hasPreviousPage: false } },
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
            reviews: { nodes: [], pageInfo: { hasPreviousPage: false } },
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
    // Either the seed validation (codex reaction timestamp) or the walk's
    // boundary check fires — both are the fail-closed malformed-timestamp path.
    expect(result.error).toMatch(/timestamp/);
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
