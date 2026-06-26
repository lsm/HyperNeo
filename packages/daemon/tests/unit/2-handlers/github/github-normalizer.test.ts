import { describe, expect, it } from 'bun:test';
import {
  normalizeGitHubPollingRow,
  type GitHubPollingRepo,
} from '../../../../src/lib/external-events/github/github-normalizer';

// ============================================================================
// Factory for GitHub `/repos/{owner}/{repo}/pulls` rows.
// ============================================================================

const watched: GitHubPollingRepo = { owner: 'Acme', repo: 'Widgets' };
const HEAD_SHA_INITIAL = 'aaa111bbb222ccc333';
const HEAD_SHA_PUSHED = 'ddd444eee555fff666';

function makePullRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1001,
    number: 42,
    url: 'https://api.github.com/repos/Acme/Widgets/pulls/42',
    html_url: 'https://github.com/Acme/Widgets/pull/42',
    title: 'Add polling support',
    body: 'Adds polling support for GitHub PRs',
    user: { login: 'lsm', type: 'User' },
    head: { sha: HEAD_SHA_INITIAL, ref: 'feature/polling' },
    created_at: '2026-06-24T10:00:00Z',
    updated_at: '2026-06-24T14:24:20Z',
    ...overrides,
  };
}

describe('normalizeGitHubPollingRow — pulls dedupe key', () => {
  it('keys the dedupe suffix on the head sha, not the volatile updated_at', () => {
    const event = normalizeGitHubPollingRow(watched, makePullRow(), 'pulls')!;
    expect(event).not.toBeNull();
    // eventType for the pulls endpoint is `pull_request`; owner/repo lowercased.
    expect(event.dedupeKey).toBe(`acme/widgets:pull_request:1001:${HEAD_SHA_INITIAL}`);
    expect(event.deliveryId).toBe(`poll:pull_request:1001:${HEAD_SHA_INITIAL}`);
    expect(event.externalId).toBe(`pull_request:1001:${HEAD_SHA_INITIAL}`);
  });

  it('keeps the same dedupeKey when only updated_at advanced (e.g. a comment/check)', () => {
    const first = normalizeGitHubPollingRow(watched, makePullRow(), 'pulls');
    // A comment or check_run bumped updated_at but did NOT push a new commit.
    const second = normalizeGitHubPollingRow(
      watched,
      makePullRow({ updated_at: '2026-06-24T15:10:00Z' }),
      'pulls'
    );

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    // Same dedupe key → the store collapses both rows, no duplicate delivery.
    expect(second!.dedupeKey).toBe(first!.dedupeKey);
    expect(second!.deliveryId).toBe(first!.deliveryId);
    expect(second!.externalId).toBe(first!.externalId);
    // occurredAt still reflects the (advanced) updated_at.
    expect(second!.occurredAt).toBeGreaterThan(first!.occurredAt);
  });

  it('changes the dedupeKey when the head sha changes (a real push)', () => {
    const first = normalizeGitHubPollingRow(watched, makePullRow(), 'pulls');
    const second = normalizeGitHubPollingRow(
      watched,
      makePullRow({ head: { sha: HEAD_SHA_PUSHED, ref: 'feature/polling' } }),
      'pulls'
    );

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second!.dedupeKey).not.toBe(first!.dedupeKey);
    expect(second!.dedupeKey).toBe(`acme/widgets:pull_request:1001:${HEAD_SHA_PUSHED}`);
  });

  it('falls back to updatedAt when head.sha is missing (deleted-head PR)', () => {
    const row = makePullRow({ head: {} });
    const first = normalizeGitHubPollingRow(watched, row, 'pulls');
    // Within a single cycle the identical row dedupes against itself.
    const secondSame = normalizeGitHubPollingRow(watched, row, 'pulls');

    expect(first).not.toBeNull();
    expect(secondSame!.dedupeKey).toBe(first!.dedupeKey);
    // When updated_at advances, the fallback key advances (no stale head to pin).
    const advanced = normalizeGitHubPollingRow(
      watched,
      makePullRow({ head: {}, updated_at: '2026-06-24T15:10:00Z' }),
      'pulls'
    );
    expect(advanced!.dedupeKey).not.toBe(first!.dedupeKey);
  });
});
