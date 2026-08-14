/**
 * Tests for fetchPrView's response-validation boundary (round 36). A
 * successful `gh pr view` exit with a malformed envelope must surface as a
 * terminal GH_INFRA_ERROR (override-ineligible at the hook layer) rather than
 * fabricating CLOSED/UNKNOWN fields — a fabricated policy stop off invented
 * state would be human-overridable. The `gh` CLI transport is substituted via
 * the test seam so no `gh` process or network is involved.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  fetchPrView,
  GH_INFRA_ERROR_PREFIX,
  type GithubResult,
  setGhRunnerForTests,
  rateLimitRetryAfterMs,
} from '../src/github';

const PR_LINK = 'https://github.com/org/repo/pull/42';

afterEach(() => setGhRunnerForTests(null));

/** Serve a raw stdout string from the stubbed `gh pr view` invocation. */
function serveRaw(stdout: string) {
  setGhRunnerForTests(async () => ({ ok: true, data: stdout }));
}

async function expectTerminalInfraFailure(promise: Promise<GithubResult<unknown>>) {
  const result = await promise;
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.retryable).toBe(false);
    expect(result.error.startsWith(GH_INFRA_ERROR_PREFIX)).toBe(true);
  }
}

describe('fetchPrView — structural validation', () => {
  test('an empty {} body is a terminal infra failure, not fabricated state', async () => {
    serveRaw('{}');
    await expectTerminalInfraFailure(fetchPrView('/tmp/ws', PR_LINK));
  });

  test('a body with an unknown mergeable value is a terminal infra failure', async () => {
    serveRaw(JSON.stringify({ state: 'OPEN', mergeable: 'BOGUS', mergeStateStatus: 'CLEAN' }));
    await expectTerminalInfraFailure(fetchPrView('/tmp/ws', PR_LINK));
  });

  test('a body with a non-string state is a terminal infra failure', async () => {
    serveRaw(JSON.stringify({ state: 42, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }));
    await expectTerminalInfraFailure(fetchPrView('/tmp/ws', PR_LINK));
  });

  test('a body missing mergeStateStatus is a terminal infra failure', async () => {
    // parsePrView would fabricate 'UNKNOWN', which pr_ready maps to a
    // retryable "GitHub still computing" — an envelope missing the field
    // must surface as an override-ineligible infrastructure failure instead
    // of queueing an otherwise valid handoff indefinitely.
    serveRaw(JSON.stringify({ state: 'OPEN', mergeable: 'MERGEABLE' }));
    await expectTerminalInfraFailure(fetchPrView('/tmp/ws', PR_LINK));
  });

  test('a body missing mergeable is a terminal infra failure', async () => {
    // parsePrView fabricates 'UNKNOWN' for a missing mergeable — which the
    // enum guard accepts, so pr_ready would retry the handoff forever on an
    // incomplete lookup instead of surfacing an infrastructure failure.
    serveRaw(JSON.stringify({ state: 'OPEN', mergeStateStatus: 'CLEAN' }));
    await expectTerminalInfraFailure(fetchPrView('/tmp/ws', PR_LINK));
  });

  test('non-JSON output self-stamps the infra prefix (every terminal path ineligible)', async () => {
    serveRaw('<html>gateway error</html>');
    await expectTerminalInfraFailure(fetchPrView('/tmp/ws', PR_LINK));
  });

  test('a well-formed body parses through cleanly (guard must not over-reject)', async () => {
    serveRaw(JSON.stringify({ state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }));
    const result = await fetchPrView('/tmp/ws', PR_LINK);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({
        state: 'OPEN',
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
      });
    }
  });
});

// Rate-limit reset-delay parsing (round 72): a retryable rate-limit result
// must carry a reset-derived retryAfterMs so the engine's retry queue does
// not poll at its 30s default while the limit is active.
describe('rateLimitRetryAfterMs', () => {
  test('parses an absolute reset timestamp and clamps the wait', () => {
    const future = new Date(Date.now() + 5 * 60_000).toISOString().replace('.000Z', 'Z');
    const ms = rateLimitRetryAfterMs(`API rate limit exceeded until ${future}.`);
    expect(ms).toBeDefined();
    expect(ms as number).toBeGreaterThan(4 * 60_000);
    expect(ms as number).toBeLessThanOrEqual(3_600_000);
  });

  test('parses an explicit seconds hint', () => {
    const ms = rateLimitRetryAfterMs('secondary rate limit: try again in 42 seconds');
    expect(ms).toBe(42_000);
  });

  test('falls back to the conventional secondary-limit floor', () => {
    expect(rateLimitRetryAfterMs('You have exceeded a secondary rate limit')).toBe(60_000);
  });

  test('a reset timestamp already in the past falls back (no negative delay)', () => {
    const past = new Date(Date.now() - 60_000).toISOString().replace('.000Z', 'Z');
    expect(rateLimitRetryAfterMs(`rate limit until ${past}`)).toBe(60_000);
  });
});
