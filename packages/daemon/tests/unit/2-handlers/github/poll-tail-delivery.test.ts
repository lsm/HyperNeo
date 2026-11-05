import { afterEach, describe, expect, test } from 'bun:test';
import { vi } from 'vitest';
import type { GitHubEvent } from '@hyperneo/shared';
import { GitHubPollingService } from '../../../../src/lib/github/polling-service';
import { Logger } from '../../../../src/lib/logger';

const issue = (id: number) => ({
  id,
  number: id,
  title: 'Synthetic issue',
  body: 'Synthetic short body',
  state: 'open',
  labels: [],
  user: { login: 'synthetic' },
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  html_url: `https://example.invalid/issues/${id}`,
});
const comment = (id: number) => ({
  id,
  body: 'Synthetic short comment',
  user: { login: 'synthetic' },
  issue_url: `https://api.github.com/repos/synthetic/tail/issues/${id}`,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  html_url: `https://example.invalid/comments/${id}`,
});
const identity = (event: GitHubEvent) => (event.rawPayload as { id: number }).id;
const services: GitHubPollingService[] = [];
function fixture(onEvent: (event: GitHubEvent) => Promise<void> | void) {
  const requests: { page: string; validator: string | null; hasSince: boolean }[] = [];
  const service = new GitHubPollingService(
    {
      token: 'synthetic-transport',
      collectPollPage: async (subject, _cycle, validator) => {
        const url = new URL(subject.url);
        const page = url.pathname.endsWith('/comments') ? 'comments' : 'issues';
        const etag = `"synthetic-${page}"`;
        requests.push({ page, validator, hasSince: url.searchParams.has('since') });
        return validator === etag
          ? new Response(null, { status: 304, headers: { ETag: etag } })
          : Response.json(page === 'issues' ? [1, 2, 3].map(issue) : [4, 5, 6].map(comment), {
              headers: { ETag: etag },
            });
      },
    },
    onEvent
  );
  services.push(service);
  service.addRepository('synthetic', 'tail');
  service.start();
  return { service, requests };
}
afterEach(() => {
  for (const service of services.splice(0)) service.stop();
  vi.restoreAllMocks();
});

describe('GitHub polling per-event failure isolation', () => {
  for (const failed of [1, 2, 4, 5])
    for (const asyncFailure of [false, true])
      test(`retains page tail after ${asyncFailure ? 'async' : 'sync'} failure at event ${failed}`, async () => {
        const attempted: number[] = [];
        const delivered: number[] = [];
        const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
        const { service, requests } = fixture((event) => {
          const id = identity(event);
          attempted.push(id);
          if (id === failed) {
            if (asyncFailure) return Promise.reject(new Error('synthetic delivery rejection'));
            throw new Error('synthetic delivery rejection');
          }
          delivered.push(id);
        });
        await service.triggerPoll();
        expect(attempted).toEqual([1, 2, 3, 4, 5, 6]);
        expect(delivered).toEqual([1, 2, 3, 4, 5, 6].filter((id) => id !== failed));
        expect(error).toHaveBeenCalledWith(
          'Failed to deliver polled event',
          expect.objectContaining({
            eventId: expect.any(String),
            eventType: failed < 4 ? 'issues' : 'issue_comment',
            error: 'synthetic delivery rejection',
          })
        );
        expect(requests).toEqual([
          { page: 'issues', validator: null, hasSince: false },
          { page: 'comments', validator: null, hasSince: false },
        ]);
        await service.triggerPoll();
        expect(attempted).toEqual([1, 2, 3, 4, 5, 6]);
        expect(delivered).toHaveLength(5);
        expect(requests.slice(2)).toEqual([
          { page: 'issues', validator: '"synthetic-issues"', hasSince: true },
          { page: 'comments', validator: '"synthetic-comments"', hasSince: true },
        ]);
      });
  test('awaits the callback once before delivering the next event', async () => {
    let entered!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((done) => {
      entered = done;
    });
    const blocked = new Promise<void>((done) => {
      release = done;
    });
    const attempted: number[] = [];
    const { service } = fixture(async (event) => {
      const id = identity(event);
      attempted.push(id);
      if (id === 1) {
        entered();
        await blocked;
        throw new Error('synthetic delivery rejection');
      }
    });
    const pending = service.triggerPoll();
    await reached;
    expect(attempted).toEqual([1]);
    release();
    await pending;
    expect(attempted).toEqual([1, 2, 3, 4, 5, 6]);
  });
});
