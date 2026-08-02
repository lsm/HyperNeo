/**
 * Coding-pack presets end-to-end tests (THROWAWAY spike, #2300).
 *
 * THE HONESTY TEST: all three capabilities — pr_ready, pr_merged, codex —
 * re-expressed over the github connector + the generic external_state
 * validator + a domain-agnostic predicate, with ZERO engine special-casing.
 * Covers merged / open / conflict / UNKNOWN / rate-limit + the codex +1 path.
 *
 * Each preset is exercised through a mocked `gh` spawn; no production engine
 * code is on the stack.
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import {
  clearConnectorRegistry,
  createCodexReviewBotValidator,
  createPrMergedValidator,
  createPrReadyValidatorV2,
  pollUntilAllow,
} from '../../../../../src/lib/space/runtime/connectors';
import type { HookExecutorContext } from '../../../../../src/lib/space/runtime/hook-executor';
import { RATE_LIMIT_MIN_BACKOFF_MS } from '../../../../../src/lib/space/runtime/rate-limit-detector';

const PR_URL = 'https://github.com/acme/corp/pull/42';

function streamFromString(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

function mockSpawn(
  results: Array<{ stdout: string; stderr: string; exitCode: number }>
): typeof Bun.spawn {
  let i = 0;
  return (() => {
    const result = results[i++] ?? { stdout: '', stderr: '', exitCode: 1 };
    return {
      stdout: streamFromString(result.stdout),
      stderr: streamFromString(result.stderr),
      exited: Promise.resolve(result.exitCode),
      pid: 12345,
      kill() {},
    } as unknown as ReturnType<typeof Bun.spawn>;
  }) as unknown as typeof Bun.spawn;
}

function ctx(opts: {
  prUrl?: string;
  methodName?: string;
  hookLocalState?: Record<string, unknown>;
}): HookExecutorContext {
  return {
    workspacePath: '/tmp',
    runId: 'run-1',
    hookId: 'hook-1',
    methodName: opts.methodName ?? 'send_message',
    params: { target: 'Review', message: 'hi', data: { pr_url: opts.prUrl ?? PR_URL } },
    nodeId: 'node-1',
    nodeName: 'Coding',
    sessionId: 'sess-1',
    taskId: 'task-1',
    hookLocalState: opts.hookLocalState ?? {},
    currentArtifacts: [],
    permittedExternalLookups: ['github'],
  };
}

const PR_VIEW = (overrides: Record<string, unknown> = {}) => ({
  url: PR_URL,
  state: 'OPEN',
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  ...overrides,
});

const EMPTY_THREADS = {
  data: {
    repository: {
      pullRequest: {
        reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
      },
    },
  },
};

const RATE_LIMIT_PROBE_OK = {
  stdout: JSON.stringify({ resources: { graphql: { reset: 0 }, core: { reset: 0 } } }),
  stderr: '',
  exitCode: 0,
};

describe('pr_ready preset (coder→reviewer handoff gate)', () => {
  beforeEach(() => clearConnectorRegistry());

  test('open + mergeable + clean + no unresolved threads → allow', async () => {
    const validate = createPrReadyValidatorV2(
      mockSpawn([
        { stdout: JSON.stringify(PR_VIEW()), stderr: '', exitCode: 0 },
        { stdout: JSON.stringify(EMPTY_THREADS), stderr: '', exitCode: 0 },
      ])
    );
    const result = await validate(ctx({}));
    expect(result.type).toBe('allow');
    expect((result as { data?: Record<string, unknown> }).data?.pr_url).toBe(PR_URL);
  });

  test('UNKNOWN mergeability → retryable_block (pending)', async () => {
    const validate = createPrReadyValidatorV2(
      mockSpawn([
        { stdout: JSON.stringify(PR_VIEW({ mergeable: 'UNKNOWN' })), stderr: '', exitCode: 0 },
        { stdout: JSON.stringify(EMPTY_THREADS), stderr: '', exitCode: 0 },
      ])
    );
    const result = await validate(ctx({}));
    expect(result.type).toBe('retryable_block');
    expect((result as { reason: string }).reason).toContain('pending external state');
  });

  test('conflict (mergeStateStatus DIRTY) → terminal block', async () => {
    const validate = createPrReadyValidatorV2(
      mockSpawn([
        { stdout: JSON.stringify(PR_VIEW({ mergeStateStatus: 'DIRTY' })), stderr: '', exitCode: 0 },
        { stdout: JSON.stringify(EMPTY_THREADS), stderr: '', exitCode: 0 },
      ])
    );
    const result = await validate(ctx({}));
    expect(result.type).toBe('block');
  });

  test('unresolved review threads → terminal block', async () => {
    const threads = {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [
                { id: 't1', isResolved: false, comments: { nodes: [{ url: 'https://g/c/1' }] } },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    };
    const validate = createPrReadyValidatorV2(
      mockSpawn([
        { stdout: JSON.stringify(PR_VIEW()), stderr: '', exitCode: 0 },
        { stdout: JSON.stringify(threads), stderr: '', exitCode: 0 },
      ])
    );
    const result = await validate(ctx({}));
    expect(result.type).toBe('block');
  });

  test('rate-limited gh → retryable_block (not terminal)', async () => {
    const validate = createPrReadyValidatorV2(
      mockSpawn([{ stdout: '', stderr: 'HTTP 429: secondary rate limit', exitCode: 1 }])
    );
    const result = await validate(ctx({}));
    expect(result.type).toBe('retryable_block');
    expect((result as { retryAfterMs?: number }).retryAfterMs).toBe(RATE_LIMIT_MIN_BACKOFF_MS);
  });
});

describe('pr_merged preset (mark_complete merge gate)', () => {
  beforeEach(() => clearConnectorRegistry());

  test('state MERGED → allow', async () => {
    const validate = createPrMergedValidator(
      mockSpawn([{ stdout: JSON.stringify(PR_VIEW({ state: 'MERGED' })), stderr: '', exitCode: 0 }])
    );
    const result = await validate(ctx({ methodName: 'mark_complete' }));
    expect(result.type).toBe('allow');
  });

  test('state OPEN → retryable_block (merge in flight)', async () => {
    const validate = createPrMergedValidator(
      mockSpawn([{ stdout: JSON.stringify(PR_VIEW({ state: 'OPEN' })), stderr: '', exitCode: 0 }])
    );
    const result = await validate(ctx({ methodName: 'mark_complete' }));
    expect(result.type).toBe('retryable_block');
  });

  test('state CLOSED → terminal block', async () => {
    const validate = createPrMergedValidator(
      mockSpawn([{ stdout: JSON.stringify(PR_VIEW({ state: 'CLOSED' })), stderr: '', exitCode: 0 }])
    );
    const result = await validate(ctx({ methodName: 'mark_complete' }));
    expect(result.type).toBe('block');
  });

  test('rate-limited gh → retryable_block', async () => {
    const validate = createPrMergedValidator(
      mockSpawn([
        { stdout: '', stderr: 'HTTP 403: rate limit exceeded', exitCode: 1 },
        RATE_LIMIT_PROBE_OK,
      ])
    );
    const result = await validate(ctx({ methodName: 'mark_complete' }));
    expect(result.type).toBe('retryable_block');
  });
});

describe('codex_review_bot preset (codex +1 reaction gate)', () => {
  beforeEach(() => clearConnectorRegistry());

  const FRESH = '2026-08-02T12:00:00Z';

  function reactions(...rxns: Array<{ login: string; content: string; at: string }>) {
    return rxns.map((r) => ({
      user: { login: r.login },
      content: r.content,
      created_at: r.at,
    }));
  }

  test('fresh codex-bot +1 → allow', async () => {
    const validate = createCodexReviewBotValidator(
      mockSpawn([
        {
          stdout: JSON.stringify(
            reactions({ login: 'codex[bot]', content: '+1', at: '2026-08-02T12:00:05Z' })
          ),
          stderr: '',
          exitCode: 0,
        },
      ])
    );
    const result = await validate(ctx({ hookLocalState: { freshnessIso: FRESH } }));
    expect(result.type).toBe('allow');
  });

  test('stale codex-bot +1 (before freshness) → retryable_block (filtered out)', async () => {
    const validate = createCodexReviewBotValidator(
      mockSpawn([
        {
          stdout: JSON.stringify(
            reactions({ login: 'codex[bot]', content: '+1', at: '2026-08-02T11:00:00Z' })
          ),
          stderr: '',
          exitCode: 0,
        },
      ])
    );
    const result = await validate(ctx({ hookLocalState: { freshnessIso: FRESH } }));
    expect(result.type).toBe('retryable_block');
  });

  test('eyes only (no +1) → retryable_block (poll)', async () => {
    const validate = createCodexReviewBotValidator(
      mockSpawn([
        {
          stdout: JSON.stringify(
            reactions({ login: 'codex[bot]', content: 'eyes', at: '2026-08-02T12:00:05Z' })
          ),
          stderr: '',
          exitCode: 0,
        },
      ])
    );
    const result = await validate(ctx({ hookLocalState: { freshnessIso: FRESH } }));
    expect(result.type).toBe('retryable_block');
  });

  test('non-codex +1 does not satisfy the predicate', async () => {
    const validate = createCodexReviewBotValidator(
      mockSpawn([
        {
          stdout: JSON.stringify(
            reactions({ login: 'dependabot[bot]', content: '+1', at: '2026-08-02T12:00:05Z' })
          ),
          stderr: '',
          exitCode: 0,
        },
      ])
    );
    const result = await validate(ctx({ hookLocalState: { freshnessIso: FRESH } }));
    expect(result.type).toBe('retryable_block');
  });

  test('rate-limited gh → retryable_block', async () => {
    const validate = createCodexReviewBotValidator(
      mockSpawn([
        { stdout: '', stderr: 'HTTP 403: rate limit exceeded', exitCode: 1 },
        RATE_LIMIT_PROBE_OK,
      ])
    );
    const result = await validate(ctx({ hookLocalState: { freshnessIso: FRESH } }));
    expect(result.type).toBe('retryable_block');
  });

  test('pollUntilAllow converts a pending result to allow once expired (timeout semantics)', async () => {
    const inner = createCodexReviewBotValidator(
      mockSpawn([
        {
          stdout: JSON.stringify(
            reactions({ login: 'codex[bot]', content: 'eyes', at: '2026-08-02T12:00:05Z' })
          ),
          stderr: '',
          exitCode: 0,
        },
      ])
    );
    const validate = pollUntilAllow(inner, (c) => c.hookLocalState?.expired === true, {
      codex_bot_reaction: 'timeout',
      codex_bot_warning: '+1 missing after timeout; allowing',
    });
    const result = await validate(ctx({ hookLocalState: { freshnessIso: FRESH, expired: true } }));
    expect(result.type).toBe('allow');
    expect((result as { data?: Record<string, unknown> }).data?.codex_bot_reaction).toBe('timeout');
  });

  test('pollUntilAllow does NOT open the gate on a connector failure (rate limit)', async () => {
    // Inner validator hits a rate limit → retryable_block that is NOT a
    // predicate-pending result. Even past the deadline, an outage must not
    // open the approval gate — it stays retryable_block.
    const inner = createCodexReviewBotValidator(
      mockSpawn([{ stdout: '', stderr: 'HTTP 429: secondary rate limit', exitCode: 1 }])
    );
    const validate = pollUntilAllow(inner, () => true, {
      codex_bot_reaction: 'timeout',
      codex_bot_warning: 'should not happen',
    });
    const result = await validate(ctx({ hookLocalState: { freshnessIso: FRESH } }));
    expect(result.type).toBe('retryable_block');
    expect((result as { data?: Record<string, unknown> }).data?.codex_bot_reaction).toBeUndefined();
  });
});
