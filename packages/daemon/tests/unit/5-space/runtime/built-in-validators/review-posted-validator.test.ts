/**
 * Unit tests for reviewPostedValidator.
 *
 * Covers: review evidence validation via message data and artifacts.
 */

import { describe, test, expect } from 'bun:test';
import { reviewPostedValidator } from '../../../../../src/lib/space/runtime/built-in-validators/review-posted-validator';
import type { HookExecutorContext } from '../../../../../src/lib/space/runtime/hook-executor';

function makeCtx(overrides: Partial<HookExecutorContext> = {}): HookExecutorContext {
  return {
    workspacePath: '/tmp',
    runId: 'run-1',
    hookId: 'hook-1',
    methodName: 'send_message',
    params: {},
    nodeId: 'node-review',
    nodeName: 'Review',
    sessionId: 'sess-1',
    taskId: 'task-1',
    hookLocalState: {},
    currentArtifacts: [],
    permittedExternalLookups: [],
    ...overrides,
  };
}

async function withMockEvidenceFetch<T>(fn: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = 'test-token';
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    const id = Number(path.split('/').pop());
    if (path.includes('/pulls/comments/')) {
      return {
        ok: true,
        json: async () => ({
          id,
          pull_request_url: 'https://api.github.com/repos/test/repo/pulls/1',
          created_at: '2999-01-01T00:00:00Z',
        }),
      } as Response;
    }
    if (path.includes('/issues/comments/')) {
      return {
        ok: true,
        json: async () => ({
          id,
          issue_url: 'https://api.github.com/repos/test/repo/issues/1',
          created_at: '2999-01-01T00:00:00Z',
          user: { login: 'test-author' },
        }),
      } as Response;
    }
    if (path.endsWith('/graphql')) {
      return {
        ok: true,
        json: async () => ({
          data: {
            viewer: { login: 'test-author' },
            repository: { pullRequest: { author: { login: 'test-author' } } },
          },
        }),
      } as Response;
    }
    return { ok: false, json: async () => ({}) } as Response;
  };
  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
    process.env.GITHUB_TOKEN = originalToken;
  }
}

describe('reviewPostedValidator', () => {
  test('blocks when no review evidence is provided', async () => {
    const ctx = makeCtx();
    const result = await reviewPostedValidator(ctx);

    expect(result.type).toBe('block');
    expect((result as { reason: string }).reason).toContain('No review evidence');
  });

  test('allows when review_url is in message data', async () => {
    await withMockEvidenceFetch(async () => {
      const ctx = makeCtx({
        params: { data: { review_url: 'https://github.com/test/repo/pull/1#discussion_r1' } },
      });
      const result = await reviewPostedValidator(ctx);

      expect(result.type).toBe('allow');
      expect((result as { message?: string }).message).toContain('Review evidence verified');
    });
  });

  test('allows when a review artifact exists', async () => {
    await withMockEvidenceFetch(async () => {
      const ctx = makeCtx({
        currentArtifacts: [
          {
            id: 'a1',
            nodeId: 'node-review',
            type: 'review',
            key: 'cycle-0',
            data: { review_url: 'https://github.com/test/repo/pull/1#discussion_r1' },
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        ],
      });
      const result = await reviewPostedValidator(ctx);

      expect(result.type).toBe('allow');
      expect((result as { message?: string }).message).toContain('artifact');
    });
  });

  test('prefers message data over artifacts', async () => {
    await withMockEvidenceFetch(async () => {
      const ctx = makeCtx({
        params: { data: { review_url: 'https://github.com/test/repo/pull/1#discussion_r2' } },
        currentArtifacts: [
          {
            id: 'a1',
            nodeId: 'node-review',
            type: 'review',
            key: 'cycle-0',
            data: { review_url: 'https://github.com/test/repo/pull/1#discussion_r1' },
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        ],
      });
      const result = await reviewPostedValidator(ctx);

      expect(result.type).toBe('allow');
      expect((result as { message?: string }).message).toContain('message_data');
    });
  });

  test('blocks when review_url is not a valid GitHub PR URL', async () => {
    const ctx = makeCtx({
      params: { data: { review_url: 'https://example.com/anything' } },
    });
    const result = await reviewPostedValidator(ctx);

    expect(result.type).toBe('block');
    expect((result as { reason: string }).reason).toContain('No review evidence');
  });

  test('blocks when artifact has no review_url', async () => {
    const ctx = makeCtx({
      currentArtifacts: [
        {
          id: 'a1',
          nodeId: 'node-review',
          type: 'review',
          key: 'cycle-0',
          data: { summary: 'looks good' },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
    });
    const result = await reviewPostedValidator(ctx);

    expect(result.type).toBe('block');
  });

  test('recognizes review_feedback artifact type', async () => {
    await withMockEvidenceFetch(async () => {
      const ctx = makeCtx({
        currentArtifacts: [
          {
            id: 'a1',
            nodeId: 'node-review',
            type: 'review_feedback',
            key: 'current',
            data: { review_url: 'https://github.com/test/repo/pull/1#discussion_r1' },
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        ],
      });
      const result = await reviewPostedValidator(ctx);

      expect(result.type).toBe('allow');
    });
  });

  test('rejects stale review artifact when newer non-review work exists', async () => {
    const now = Date.now();
    const ctx = makeCtx({
      currentArtifacts: [
        {
          id: 'a2',
          nodeId: 'node-coding',
          type: 'result',
          key: 'revision-2',
          data: { pr_url: 'https://github.com/test/repo/pull/1' },
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'a1',
          nodeId: 'node-review',
          type: 'review',
          key: 'cycle-0',
          data: { review_url: 'https://github.com/test/repo/pull/1#discussion_r1' },
          createdAt: now - 10_000,
          updatedAt: now - 10_000,
        },
      ],
    });
    const result = await reviewPostedValidator(ctx);

    expect(result.type).toBe('block');
    expect((result as { reason: string }).reason).toContain('No review evidence');
  });

  test('accepts enterprise GitHub host for review URL', async () => {
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.GH_ENTERPRISE_TOKEN;
    const originalGhHost = process.env.GH_HOST;
    process.env.GH_ENTERPRISE_TOKEN = 'test-token';
    process.env.GH_HOST = 'github.enterprise.com';
    globalThis.fetch = async () =>
      ({
        ok: true,
        json: async () => ({
          data: {
            repository: {
              pullRequest: {
                reviews: { nodes: [], pageInfo: { hasNextPage: false } },
                comments: { nodes: [], pageInfo: { hasNextPage: false } },
                reviewThreads: {
                  nodes: [
                    { comments: { nodes: [{ databaseId: 1, createdAt: '2999-01-01T00:00:00Z' }] } },
                  ],
                  pageInfo: { hasNextPage: false },
                },
              },
            },
          },
        }),
      }) as Response;

    const ctx = makeCtx({
      params: {
        data: { review_url: 'https://github.enterprise.com/org/repo/pull/42#discussion_r1' },
      },
      gateData: [
        {
          gateId: 'code-pr-gate',
          data: { pr_url: 'https://github.enterprise.com/org/repo/pull/42' },
          updatedAt: Date.now(),
        },
      ],
    });
    const result = await reviewPostedValidator(ctx);
    globalThis.fetch = originalFetch;
    process.env.GH_ENTERPRISE_TOKEN = originalToken;
    process.env.GH_HOST = originalGhHost;

    expect(result.type).toBe('allow');
    expect((result as { message?: string }).message).toContain('message_data');
  });

  test('blocks review URL from a different PR than the active one', async () => {
    const ctx = makeCtx({
      params: {
        data: { review_url: 'https://github.com/other/repo/pull/99#discussion_r1' },
      },
      gateData: [
        {
          gateId: 'code-pr-gate',
          data: { pr_url: 'https://github.com/test/repo/pull/1' },
          updatedAt: Date.now(),
        },
      ],
    });
    const result = await reviewPostedValidator(ctx);

    expect(result.type).toBe('block');
    expect((result as { reason: string }).reason).toContain('No review evidence');
  });

  test('allows review URL matching the active PR', async () => {
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'test-token';
    globalThis.fetch = async () =>
      ({
        ok: true,
        json: async () => ({
          data: {
            repository: {
              pullRequest: {
                reviews: { nodes: [], pageInfo: { hasNextPage: false } },
                comments: { nodes: [], pageInfo: { hasNextPage: false } },
                reviewThreads: {
                  nodes: [
                    {
                      comments: {
                        nodes: [{ databaseId: 42, createdAt: '2999-01-01T00:00:00Z' }],
                      },
                    },
                  ],
                  pageInfo: { hasNextPage: false },
                },
              },
            },
          },
        }),
      }) as Response;

    const ctx = makeCtx({
      params: {
        data: { review_url: 'https://github.com/test/repo/pull/1#discussion_r42' },
      },
      gateData: [
        {
          gateId: 'code-pr-gate',
          data: { pr_url: 'https://github.com/test/repo/pull/1' },
          updatedAt: Date.now(),
        },
      ],
    });
    const result = await reviewPostedValidator(ctx);
    globalThis.fetch = originalFetch;
    process.env.GITHUB_TOKEN = originalToken;

    expect(result.type).toBe('allow');
  });

  test('allows PR issue comment URL when the comment author is the PR author', async () => {
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'test-token';
    globalThis.fetch = async (url) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/repos/test/repo/issues/comments/99')) {
        return {
          ok: true,
          json: async () => ({
            id: 99,
            issue_url: 'https://api.github.com/repos/test/repo/issues/1',
            created_at: '2999-01-01T00:00:00Z',
            user: { login: 'pr-author' },
          }),
        } as Response;
      }
      return {
        ok: true,
        json: async () => ({
          data: {
            viewer: { login: 'pr-author' },
            repository: { pullRequest: { author: { login: 'pr-author' } } },
          },
        }),
      } as Response;
    };

    const ctx = makeCtx({
      params: {
        data: { review_url: 'https://github.com/test/repo/pull/1#issuecomment-99' },
      },
      gateData: [
        {
          gateId: 'code-pr-gate',
          data: { pr_url: 'https://github.com/test/repo/pull/1' },
          updatedAt: Date.now(),
        },
      ],
    });
    const result = await reviewPostedValidator(ctx);
    globalThis.fetch = originalFetch;
    process.env.GITHUB_TOKEN = originalToken;

    expect(result.type).toBe('allow');
  });

  test('blocks PR review URL when the formal review was only commented', async () => {
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'test-token';
    globalThis.fetch = async (url) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/repos/test/repo/pulls/1/reviews/77')) {
        return {
          ok: true,
          json: async () => ({
            id: 77,
            submitted_at: '2999-01-01T00:00:00Z',
            state: 'COMMENTED',
          }),
        } as Response;
      }
      return {
        ok: true,
        json: async () => ({
          data: {
            repository: {
              pullRequest: {
                author: { login: 'pr-author' },
                reviews: { nodes: [], pageInfo: { hasNextPage: false } },
                comments: { nodes: [], pageInfo: { hasNextPage: false } },
                reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } },
              },
            },
          },
        }),
      } as Response;
    };

    const ctx = makeCtx({
      params: {
        data: { review_url: 'https://github.com/test/repo/pull/1#pullrequestreview-77' },
      },
      gateData: [
        {
          gateId: 'code-pr-gate',
          data: { pr_url: 'https://github.com/test/repo/pull/1' },
          updatedAt: Date.now(),
        },
      ],
    });
    const result = await reviewPostedValidator(ctx);
    globalThis.fetch = originalFetch;
    process.env.GITHUB_TOKEN = originalToken;

    expect(result.type).toBe('block');
  });

  test('allows PR review URL when the formal review approved', async () => {
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'test-token';
    globalThis.fetch = async (url) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/repos/test/repo/pulls/1/reviews/77')) {
        return {
          ok: true,
          json: async () => ({
            id: 77,
            submitted_at: '2999-01-01T00:00:00Z',
            state: 'APPROVED',
          }),
        } as Response;
      }
      return {
        ok: true,
        json: async () => ({
          data: {
            viewer: { login: 'pr-author' },
            repository: { pullRequest: { author: { login: 'pr-author' } } },
          },
        }),
      } as Response;
    };

    const ctx = makeCtx({
      params: {
        data: { review_url: 'https://github.com/test/repo/pull/1#pullrequestreview-77' },
      },
      gateData: [
        {
          gateId: 'code-pr-gate',
          data: { pr_url: 'https://github.com/test/repo/pull/1' },
          updatedAt: Date.now(),
        },
      ],
    });
    const result = await reviewPostedValidator(ctx);
    globalThis.fetch = originalFetch;
    process.env.GITHUB_TOKEN = originalToken;

    expect(result.type).toBe('allow');
  });

  test('blocks PR issue comment URL when viewer is not the PR author', async () => {
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'test-token';
    globalThis.fetch = async (url) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/repos/test/repo/issues/comments/99')) {
        return {
          ok: true,
          json: async () => ({
            id: 99,
            issue_url: 'https://api.github.com/repos/test/repo/issues/1',
            created_at: '2999-01-01T00:00:00Z',
            user: { login: 'pr-author' },
          }),
        } as Response;
      }
      return {
        ok: true,
        json: async () => ({
          data: {
            viewer: { login: 'reviewer' },
            repository: { pullRequest: { author: { login: 'pr-author' } } },
          },
        }),
      } as Response;
    };

    const ctx = makeCtx({
      params: {
        data: { review_url: 'https://github.com/test/repo/pull/1#issuecomment-99' },
      },
      gateData: [
        {
          gateId: 'code-pr-gate',
          data: { pr_url: 'https://github.com/test/repo/pull/1' },
          updatedAt: Date.now(),
        },
      ],
    });
    const result = await reviewPostedValidator(ctx);
    globalThis.fetch = originalFetch;
    process.env.GITHUB_TOKEN = originalToken;

    expect(result.type).toBe('block');
  });

  test('blocks PR issue comment URL when the comment author is not the PR author', async () => {
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'test-token';
    globalThis.fetch = async (url) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/repos/test/repo/issues/comments/99')) {
        return {
          ok: true,
          json: async () => ({
            id: 99,
            issue_url: 'https://api.github.com/repos/test/repo/issues/1',
            created_at: '2999-01-01T00:00:00Z',
            user: { login: 'reviewer' },
          }),
        } as Response;
      }
      return {
        ok: true,
        json: async () => ({
          data: {
            viewer: { login: 'pr-author' },
            repository: { pullRequest: { author: { login: 'pr-author' } } },
          },
        }),
      } as Response;
    };

    const ctx = makeCtx({
      params: {
        data: { review_url: 'https://github.com/test/repo/pull/1#issuecomment-99' },
      },
      gateData: [
        {
          gateId: 'code-pr-gate',
          data: { pr_url: 'https://github.com/test/repo/pull/1' },
          updatedAt: Date.now(),
        },
      ],
    });
    const result = await reviewPostedValidator(ctx);
    globalThis.fetch = originalFetch;
    process.env.GITHUB_TOKEN = originalToken;

    expect(result.type).toBe('block');
  });

  test('rejects PR comment GraphQL fallback when author is not the PR author', async () => {
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'test-token';
    let callCount = 0;
    globalThis.fetch = async (url) => {
      callCount += 1;
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/repos/test/repo/issues/comments/99')) {
        return { ok: false, json: async () => ({}) } as Response;
      }
      if (callCount === 2) {
        return {
          ok: true,
          json: async () => ({
            data: {
              repository: {
                pullRequest: {
                  reviews: { nodes: [], pageInfo: { hasNextPage: false } },
                  comments: {
                    nodes: [
                      {
                        databaseId: 99,
                        createdAt: '2999-01-01T00:00:00Z',
                        author: { login: 'reviewer' },
                      },
                    ],
                    pageInfo: { hasNextPage: false },
                  },
                  reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } },
                },
              },
            },
          }),
        } as Response;
      }
      return {
        ok: true,
        json: async () => ({
          data: {
            viewer: { login: 'pr-author' },
            repository: { pullRequest: { author: { login: 'pr-author' } } },
          },
        }),
      } as Response;
    };

    const ctx = makeCtx({
      params: {
        data: { review_url: 'https://github.com/test/repo/pull/1#issuecomment-99' },
      },
      gateData: [
        {
          gateId: 'code-pr-gate',
          data: { pr_url: 'https://github.com/test/repo/pull/1' },
          updatedAt: Date.now(),
        },
      ],
    });
    const result = await reviewPostedValidator(ctx);
    globalThis.fetch = originalFetch;
    process.env.GITHUB_TOKEN = originalToken;

    expect(result.type).toBe('block');
  });

  test('returns missing when paginated evidence cursors exhaust at different times', async () => {
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'test-token';
    let evidenceCalls = 0;
    globalThis.fetch = async (url) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/repos/test/repo/pulls/comments/404')) {
        return { ok: false, json: async () => ({}) } as Response;
      }
      if (path.endsWith('/graphql')) {
        evidenceCalls += 1;
        if (evidenceCalls === 1) {
          return {
            ok: true,
            json: async () => ({
              data: {
                viewer: { login: 'pr-author' },
                repository: { pullRequest: { author: { login: 'pr-author' } } },
              },
            }),
          } as Response;
        }
        return {
          ok: true,
          json: async () => ({
            data: {
              repository: {
                pullRequest: {
                  reviews: { nodes: [], pageInfo: { hasNextPage: false } },
                  comments: {
                    nodes: [],
                    pageInfo: { hasNextPage: evidenceCalls === 2, endCursor: 'comment-cursor' },
                  },
                  reviewThreads: {
                    nodes: [],
                    pageInfo: {
                      hasNextPage: evidenceCalls === 2 || evidenceCalls === 3,
                      endCursor: `thread-cursor-${evidenceCalls}`,
                    },
                  },
                },
              },
            },
          }),
        } as Response;
      }
      return { ok: false, json: async () => ({}) } as Response;
    };

    const ctx = makeCtx({
      params: {
        data: { review_url: 'https://github.com/test/repo/pull/1#discussion_r404' },
      },
      gateData: [
        {
          gateId: 'code-pr-gate',
          data: { pr_url: 'https://github.com/test/repo/pull/1' },
          updatedAt: Date.now(),
        },
      ],
    });
    const result = await reviewPostedValidator(ctx);
    globalThis.fetch = originalFetch;
    process.env.GITHUB_TOKEN = originalToken;

    expect(result.type).toBe('block');
    expect(evidenceCalls).toBe(4);
  });

  test('uses submittedAt for formal review freshness in GraphQL fallback', async () => {
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'test-token';
    let graphqlCalls = 0;
    globalThis.fetch = async (url) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/repos/test/repo/pulls/1/reviews/77')) {
        return { ok: false, json: async () => ({}) } as Response;
      }
      if (path.endsWith('/graphql')) {
        graphqlCalls += 1;
        if (graphqlCalls === 1) {
          return {
            ok: true,
            json: async () => ({
              data: {
                viewer: { login: 'reviewer' },
                repository: { pullRequest: { author: { login: 'pr-author' } } },
              },
            }),
          } as Response;
        }
        return {
          ok: true,
          json: async () => ({
            data: {
              repository: {
                pullRequest: {
                  reviews: {
                    nodes: [
                      {
                        databaseId: 77,
                        createdAt: '2026-01-01T00:00:00Z',
                        submittedAt: '2999-01-01T00:00:00Z',
                        state: 'APPROVED',
                      },
                    ],
                    pageInfo: { hasNextPage: false },
                  },
                  comments: { nodes: [], pageInfo: { hasNextPage: false } },
                  reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } },
                },
              },
            },
          }),
        } as Response;
      }
      return { ok: false, json: async () => ({}) } as Response;
    };

    const ctx = makeCtx({
      params: {
        data: { review_url: 'https://github.com/test/repo/pull/1#pullrequestreview-77' },
      },
      currentArtifacts: [
        {
          id: 'a2',
          nodeId: 'node-coding',
          type: 'result',
          key: 'revision-2',
          data: { pr_url: 'https://github.com/test/repo/pull/1' },
          createdAt: Date.parse('2026-01-02T00:00:00Z'),
          updatedAt: Date.parse('2026-01-02T00:00:00Z'),
        },
      ],
      gateData: [
        {
          gateId: 'code-pr-gate',
          data: { pr_url: 'https://github.com/test/repo/pull/1' },
          updatedAt: Date.now(),
        },
      ],
    });
    const result = await reviewPostedValidator(ctx);
    globalThis.fetch = originalFetch;
    process.env.GITHUB_TOKEN = originalToken;

    expect(result.type).toBe('allow');
  });

  test('finds review evidence on later pages', async () => {
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'test-token';
    let callCount = 0;
    globalThis.fetch = async () => {
      callCount += 1;
      return {
        ok: true,
        json: async () => ({
          data: {
            repository: {
              pullRequest: {
                reviews: { nodes: [], pageInfo: { hasNextPage: false } },
                comments: { nodes: [], pageInfo: { hasNextPage: false } },
                reviewThreads:
                  callCount === 1
                    ? {
                        nodes: [],
                        pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
                      }
                    : {
                        nodes: [
                          {
                            comments: {
                              nodes: [{ databaseId: 123, createdAt: '2999-01-01T00:00:00Z' }],
                            },
                          },
                        ],
                        pageInfo: { hasNextPage: false },
                      },
              },
            },
          },
        }),
      } as Response;
    };

    const ctx = makeCtx({
      params: {
        data: { review_url: 'https://github.com/test/repo/pull/1#discussion_r123' },
      },
      gateData: [
        {
          gateId: 'code-pr-gate',
          data: { pr_url: 'https://github.com/test/repo/pull/1' },
          updatedAt: Date.now(),
        },
      ],
    });
    const result = await reviewPostedValidator(ctx);
    globalThis.fetch = originalFetch;
    process.env.GITHUB_TOKEN = originalToken;

    expect(result.type).toBe('allow');
    expect(callCount).toBe(3);
  });

  test('finds review-thread comment on a later thread comment page', async () => {
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'test-token';
    let graphqlCalls = 0;
    globalThis.fetch = async (url) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/repos/test/repo/pulls/comments/123')) {
        return { ok: false, json: async () => ({}) } as Response;
      }
      if (path.endsWith('/graphql')) {
        graphqlCalls += 1;
        if (graphqlCalls === 1) {
          return {
            ok: true,
            json: async () => ({
              data: {
                viewer: { login: 'reviewer' },
                repository: { pullRequest: { author: { login: 'pr-author' } } },
              },
            }),
          } as Response;
        }
        if (graphqlCalls === 2) {
          return {
            ok: true,
            json: async () => ({
              data: {
                repository: {
                  pullRequest: {
                    reviews: { nodes: [], pageInfo: { hasNextPage: false } },
                    comments: { nodes: [], pageInfo: { hasNextPage: false } },
                    reviewThreads: {
                      nodes: [
                        {
                          id: 'thread-1',
                          comments: {
                            nodes: [],
                            pageInfo: { hasNextPage: true, endCursor: 'comments-1' },
                          },
                        },
                      ],
                      pageInfo: { hasNextPage: false },
                    },
                  },
                },
              },
            }),
          } as Response;
        }
        return {
          ok: true,
          json: async () => ({
            data: {
              node: {
                comments: {
                  nodes: [{ databaseId: 123, createdAt: '2999-01-01T00:00:00Z' }],
                  pageInfo: { hasNextPage: false },
                },
              },
            },
          }),
        } as Response;
      }
      return { ok: false, json: async () => ({}) } as Response;
    };

    const ctx = makeCtx({
      params: {
        data: { review_url: 'https://github.com/test/repo/pull/1#discussion_r123' },
      },
      gateData: [
        {
          gateId: 'code-pr-gate',
          data: { pr_url: 'https://github.com/test/repo/pull/1' },
          updatedAt: Date.now(),
        },
      ],
    });
    const result = await reviewPostedValidator(ctx);
    globalThis.fetch = originalFetch;
    process.env.GITHUB_TOKEN = originalToken;

    expect(result.type).toBe('allow');
    expect(graphqlCalls).toBe(3);
  });

  test('blocks review evidence older than the active PR gate update', async () => {
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'test-token';
    const now = Date.parse('2026-01-01T12:00:00Z');
    globalThis.fetch = async (url) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/repos/test/repo/pulls/comments/42')) {
        return {
          ok: true,
          json: async () => ({
            id: 42,
            pull_request_url: 'https://api.github.com/repos/test/repo/pulls/1',
            created_at: new Date(now - 10_000).toISOString(),
          }),
        } as Response;
      }
      if (path.endsWith('/graphql')) {
        return {
          ok: true,
          json: async () => ({
            data: {
              viewer: { login: 'reviewer' },
              repository: { pullRequest: { author: { login: 'pr-author' } } },
            },
          }),
        } as Response;
      }
      return { ok: false, json: async () => ({}) } as Response;
    };

    const ctx = makeCtx({
      params: {
        data: { review_url: 'https://github.com/test/repo/pull/1#discussion_r42' },
      },
      gateData: [
        {
          gateId: 'code-pr-gate',
          data: { pr_url: 'https://github.com/test/repo/pull/1' },
          updatedAt: now,
        },
      ],
    });
    const result = await reviewPostedValidator(ctx);
    globalThis.fetch = originalFetch;
    process.env.GITHUB_TOKEN = originalToken;

    expect(result.type).toBe('block');
  });

  test('floors review evidence freshness cutoff to GitHub timestamp precision', async () => {
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'test-token';
    const now = Date.parse('2026-01-01T12:00:00.800Z');
    globalThis.fetch = async (url) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/repos/test/repo/pulls/comments/42')) {
        return {
          ok: true,
          json: async () => ({
            id: 42,
            pull_request_url: 'https://api.github.com/repos/test/repo/pulls/1',
            created_at: '2026-01-01T12:00:00Z',
          }),
        } as Response;
      }
      return { ok: false, json: async () => ({}) } as Response;
    };

    const ctx = makeCtx({
      params: {
        data: { review_url: 'https://github.com/test/repo/pull/1#discussion_r42' },
      },
      currentArtifacts: [
        {
          id: 'a2',
          nodeId: 'node-coding',
          type: 'result',
          key: 'revision-2',
          data: { pr_url: 'https://github.com/test/repo/pull/1' },
          createdAt: now,
          updatedAt: now,
        },
      ],
      gateData: [
        {
          gateId: 'code-pr-gate',
          data: { pr_url: 'https://github.com/test/repo/pull/1' },
          updatedAt: now - 10_000,
        },
      ],
    });
    const result = await reviewPostedValidator(ctx);
    globalThis.fetch = originalFetch;
    process.env.GITHUB_TOKEN = originalToken;

    expect(result.type).toBe('allow');
  });

  test('blocks direct message review URL older than latest coding revision', async () => {
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'test-token';
    const now = Date.now();
    globalThis.fetch = async () =>
      ({
        ok: true,
        json: async () => ({
          data: {
            repository: {
              pullRequest: {
                reviews: { nodes: [], pageInfo: { hasNextPage: false } },
                comments: { nodes: [], pageInfo: { hasNextPage: false } },
                reviewThreads: {
                  nodes: [
                    {
                      comments: {
                        nodes: [
                          {
                            databaseId: 42,
                            createdAt: new Date(now - 10_000).toISOString(),
                          },
                        ],
                      },
                    },
                  ],
                  pageInfo: { hasNextPage: false },
                },
              },
            },
          },
        }),
      }) as Response;

    const ctx = makeCtx({
      params: {
        data: { review_url: 'https://github.com/test/repo/pull/1#discussion_r42' },
      },
      currentArtifacts: [
        {
          id: 'a2',
          nodeId: 'node-coding',
          type: 'result',
          key: 'revision-2',
          data: { pr_url: 'https://github.com/test/repo/pull/1' },
          createdAt: now,
          updatedAt: now,
        },
      ],
      gateData: [
        {
          gateId: 'code-pr-gate',
          data: { pr_url: 'https://github.com/test/repo/pull/1' },
          updatedAt: now,
        },
      ],
    });
    const result = await reviewPostedValidator(ctx);
    globalThis.fetch = originalFetch;
    process.env.GITHUB_TOKEN = originalToken;

    expect(result.type).toBe('block');
  });

  test('verifies review-thread comment by database ID when no page contains it', async () => {
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'test-token';
    const requestedPaths: string[] = [];
    globalThis.fetch = async (url) => {
      const path = new URL(String(url)).pathname;
      requestedPaths.push(path);
      if (path.endsWith('/repos/test/repo/pulls/comments/555')) {
        return {
          ok: true,
          json: async () => ({
            id: 555,
            pull_request_url: 'https://api.github.com/repos/test/repo/pulls/1',
            created_at: '2999-01-01T00:00:00Z',
          }),
        } as Response;
      }
      return { ok: false, json: async () => ({}) } as Response;
    };

    const ctx = makeCtx({
      params: {
        data: { review_url: 'https://github.com/test/repo/pull/1#discussion_r555' },
      },
      gateData: [
        {
          gateId: 'code-pr-gate',
          data: { pr_url: 'https://github.com/test/repo/pull/1' },
          updatedAt: Date.now(),
        },
      ],
    });
    const result = await reviewPostedValidator(ctx);
    globalThis.fetch = originalFetch;
    process.env.GITHUB_TOKEN = originalToken;

    expect(result.type).toBe('allow');
    expect(requestedPaths).toContain('/repos/test/repo/pulls/comments/555');
  });

  test('ignores reviewer audit artifacts when computing evidence freshness', async () => {
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'test-token';
    const now = Date.now();
    globalThis.fetch = async (url) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/repos/test/repo/pulls/comments/42')) {
        return {
          ok: true,
          json: async () => ({
            id: 42,
            pull_request_url: 'https://api.github.com/repos/test/repo/pulls/1',
            created_at: new Date(now - 5_000).toISOString(),
          }),
        } as Response;
      }
      return { ok: false, json: async () => ({}) } as Response;
    };

    const ctx = makeCtx({
      params: {
        data: { review_url: 'https://github.com/test/repo/pull/1#discussion_r42' },
      },
      currentArtifacts: [
        {
          id: 'reviewer-progress',
          nodeId: 'node-review',
          type: 'progress',
          key: 'audit',
          data: { summary: 'review posted' },
          createdAt: now,
          updatedAt: now,
        },
      ],
      gateData: [
        {
          gateId: 'code-pr-gate',
          data: { pr_url: 'https://github.com/test/repo/pull/1' },
          updatedAt: now - 10_000,
        },
      ],
    });
    const result = await reviewPostedValidator(ctx);
    globalThis.fetch = originalFetch;
    process.env.GITHUB_TOKEN = originalToken;

    expect(result.type).toBe('allow');
  });

  test('finds review artifact behind same-node audit artifact fallback', async () => {
    await withMockEvidenceFetch(async () => {
      const now = Date.now();
      const ctx = makeCtx({
        currentArtifacts: [
          {
            id: 'reviewer-progress',
            nodeId: 'node-review',
            type: 'progress',
            key: 'audit',
            data: { summary: 'review posted' },
            createdAt: now,
            updatedAt: now,
          },
          {
            id: 'review-artifact',
            nodeId: 'node-review',
            type: 'review',
            key: 'current',
            data: { review_url: 'https://github.com/test/repo/pull/1#discussion_r42' },
            createdAt: now - 1_000,
            updatedAt: now - 1_000,
          },
        ],
        gateData: [
          {
            gateId: 'code-pr-gate',
            data: { pr_url: 'https://github.com/test/repo/pull/1' },
            updatedAt: now,
          },
        ],
      });
      const result = await reviewPostedValidator(ctx);

      expect(result.type).toBe('allow');
    });
  });

  test('fails closed for nonexistent review URL when active PR data is unavailable', async () => {
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'test-token';
    globalThis.fetch = async () => ({ ok: false, json: async () => ({}) }) as Response;

    const ctx = makeCtx({
      params: {
        data: { review_url: 'https://github.com/test/repo/pull/1#discussion_r404' },
      },
    });
    const result = await reviewPostedValidator(ctx);
    globalThis.fetch = originalFetch;
    process.env.GITHUB_TOKEN = originalToken;

    expect(result.type).toBe('block');
  });

  test('does not send credentials to untrusted review URL host', async () => {
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'test-token';
    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return { ok: true, json: async () => ({}) } as Response;
    };

    const ctx = makeCtx({
      params: {
        data: { review_url: 'https://attacker.example/org/repo/pull/1#discussion_r42' },
      },
      gateData: [
        {
          gateId: 'code-pr-gate',
          data: { pr_url: 'https://attacker.example/org/repo/pull/1' },
          updatedAt: Date.now(),
        },
      ],
    });
    const result = await reviewPostedValidator(ctx);
    globalThis.fetch = originalFetch;
    process.env.GITHUB_TOKEN = originalToken;

    expect(fetchCalled).toBe(false);
    expect(result.type).toBe('block');
  });
});
