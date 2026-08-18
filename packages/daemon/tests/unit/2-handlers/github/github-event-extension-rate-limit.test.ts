import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { describe, expect, test } from 'bun:test';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import {
  GitHubEventExtension,
  parseRateLimitHeaders,
} from '../../../../src/lib/external-events/github/github-event-extension';
import type {
  ExternalEventExtensionConfigStore,
  SpaceExternalEventSourceConfig,
} from '../../../../src/lib/external-events/types';

function setupDb(): BunDatabase {
  const db = new BunDatabase(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  createTables(db);
  runMigrations(db, () => {});
  return db;
}

class EnabledConfigStore implements ExternalEventExtensionConfigStore {
  async getGlobalConfig(source: string) {
    return {
      source,
      globallyEnabled: true,
      capabilities: { webhooks: false, polling: true, rpcConfig: true },
      settings: {},
    };
  }
  async getSpaceConfig(spaceId: string, source: string): Promise<SpaceExternalEventSourceConfig> {
    return { spaceId, source, enabled: true, settings: {} };
  }
  async listEnabledSpaces(): Promise<SpaceExternalEventSourceConfig[]> {
    return [];
  }
  async setGlobalConfig(): Promise<void> {}
  async setSpaceConfig(): Promise<void> {}
}

function makeResponse(opts: {
  status?: number;
  remaining?: string | null;
  reset?: string | null;
  retryAfter?: string | null;
  body?: unknown;
}): Response {
  const headers = new Headers();
  if (opts.remaining !== null) headers.set('X-RateLimit-Remaining', opts.remaining ?? '5000');
  if (opts.reset !== null) headers.set('X-RateLimit-Reset', opts.reset ?? '');
  if (opts.retryAfter !== null) headers.set('Retry-After', opts.retryAfter ?? '');
  return new Response(JSON.stringify(opts.body ?? []), {
    status: opts.status ?? 200,
    headers,
  });
}

function rateLimitedResetResponse(opts: {
  status: number;
  remaining: number;
  resetEpochSeconds: number;
}): Response {
  return makeResponse({
    status: opts.status,
    remaining: String(opts.remaining),
    reset: String(opts.resetEpochSeconds),
    body: { message: 'rate limit exceeded' },
  });
}

describe('parseRateLimitHeaders', () => {
  test('parses remaining + reset headers into ms epoch', () => {
    const res = makeResponse({ status: 200, remaining: '42', reset: '1700000000' });
    const info = parseRateLimitHeaders(res);
    expect(info.remaining).toBe(42);
    expect(info.resetAt).toBe(1_700_000_000_000);
    expect(info.limited).toBe(false);
  });

  test('marks 403 as limited only when X-RateLimit-Remaining is 0', () => {
    const resLimiter = makeResponse({ status: 403, remaining: '0', reset: '1700000000' });
    expect(parseRateLimitHeaders(resLimiter).limited).toBe(true);
    const resPerms = makeResponse({ status: 403, remaining: '4999', reset: '1700000000' });
    expect(parseRateLimitHeaders(resPerms).limited).toBe(false);
    const resMissing = new Response('[]', { status: 403 });
    expect(parseRateLimitHeaders(resMissing).limited).toBe(false);
  });

  test('marks 429 as limited regardless of remaining', () => {
    const res429 = makeResponse({ status: 429, remaining: '0', reset: '1700000000' });
    expect(parseRateLimitHeaders(res429).limited).toBe(true);
    const res429Missing = new Response('[]', { status: 429 });
    expect(parseRateLimitHeaders(res429Missing).limited).toBe(true);
  });

  test('Retry-After overrides X-RateLimit-Reset when present', () => {
    const now = Date.now();
    const res = new Response('[]', {
      status: 429,
      headers: {
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Reset': String(Math.floor((now + 60 * 60_000) / 1000)),
        'Retry-After': '30',
      },
    });
    const info = parseRateLimitHeaders(res);
    expect(info.resetAt).toBeGreaterThan(now + 25_000);
    expect(info.resetAt).toBeLessThan(now + 35_000);
  });

  test('treats missing headers as Infinity remaining / 0 reset', () => {
    const res = new Response('[]', { status: 200 });
    const info = parseRateLimitHeaders(res);
    expect(info.remaining).toBe(Infinity);
    expect(info.resetAt).toBe(0);
    expect(info.limited).toBe(false);
  });

  test('treats malformed numeric headers as missing', () => {
    const res = new Response('[]', {
      status: 200,
      headers: {
        'X-RateLimit-Remaining': 'not-a-number',
        'X-RateLimit-Reset': 'oops',
      },
    });
    const info = parseRateLimitHeaders(res);
    expect(info.remaining).toBe(Infinity);
    expect(info.resetAt).toBe(0);
  });
});

describe('GitHubEventExtension rate-limit-aware polling', () => {
  test('pollWatchedRepo processes current endpoint then defers remaining endpoints when remaining < threshold', async () => {
    const db = setupDb();
    const extension = new GitHubEventExtension(db, 'token', { pollIntervalMs: 60_000 });
    await extension.start({
      publisher: { publish: async () => {} },
      config: new EnabledConfigStore(),
      onSourceConfigChanged() {},
    });
    extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      pollingEnabled: true,
    });

    let fetchCalled = 0;
    const row = {
      id: 101,
      html_url: 'https://github.com/acme/widgets/pull/7#issuecomment-101',
      body: 'looks good',
      user: { login: 'bot', type: 'Bot' },
      updated_at: '2026-01-01T00:00:00Z',
      issue: { number: 7, pull_request: { url: 'api' } },
    };
    const fetchImpl = (async () => {
      fetchCalled++;
      return makeResponse({
        status: 200,
        remaining: '5',
        reset: String(Math.floor((Date.now() + 90_000) / 1000)),
        body: [row],
      });
    }) as typeof fetch;

    try {
      const repo = extension.repo.listPollingRepos()[0];
      const count = await extension.pollWatchedRepo(repo, fetchImpl);
      expect(count).toBe(1);
      expect(fetchCalled).toBe(1);
      const until = (extension as unknown as { rateLimitedUntil: number }).rateLimitedUntil;
      expect(until).toBeGreaterThan(Date.now());
      const updated = extension.repo.getWatchedRepoById(repo.id);
      expect(updated?.pollCursor?.lastSeenAt).toBe(0);
      expect(updated?.pollCursor?.endpointLastSeenAt?.issue_comments).toBeGreaterThanOrEqual(
        Date.parse(row.updated_at)
      );
    } finally {
      await extension.stop();
    }
  });

  test('pollWatchedRepo aborts on HTTP 403 with X-RateLimit-Reset', async () => {
    const db = setupDb();
    const extension = new GitHubEventExtension(db, 'token');
    await extension.start({
      publisher: { publish: async () => {} },
      config: new EnabledConfigStore(),
      onSourceConfigChanged() {},
    });
    extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      pollingEnabled: true,
    });

    let fetchCalled = 0;
    const fetchImpl = (async () => {
      fetchCalled++;
      return rateLimitedResetResponse({
        status: 403,
        remaining: 0,
        resetEpochSeconds: Math.floor((Date.now() + 120_000) / 1000),
      });
    }) as typeof fetch;

    try {
      const count = await extension.pollWatchedRepo(
        extension.repo.listPollingRepos()[0],
        fetchImpl
      );
      expect(count).toBe(0);
      expect(fetchCalled).toBe(1);
      const until = (extension as unknown as { rateLimitedUntil: number }).rateLimitedUntil;
      expect(until).toBeGreaterThan(Date.now() + 60_000);
    } finally {
      await extension.stop();
    }
  });

  test('pollEnabledSpaces skips all repos when rate-limited flag is active', async () => {
    const db = setupDb();
    const extension = new GitHubEventExtension(db, 'token');
    await extension.start({
      publisher: { publish: async () => {} },
      config: new EnabledConfigStore(),
      onSourceConfigChanged() {},
    });
    extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      pollingEnabled: true,
    });
    extension.repo.upsertWatchedRepo({
      spaceId: 'space-2',
      owner: 'acme',
      repo: 'gadgets',
      pollingEnabled: true,
    });

    (extension as unknown as { rateLimitedUntil: number }).rateLimitedUntil = Date.now() + 300_000;

    let fetchCalled = 0;
    const fetchImpl = (async () => {
      fetchCalled++;
      return makeResponse({ status: 200, remaining: '5000', reset: '', body: [] });
    }) as typeof fetch;

    try {
      const count = await (
        extension as unknown as {
          pollEnabledSpaces: (f: typeof fetch) => Promise<number>;
        }
      ).pollEnabledSpaces(fetchImpl);
      expect(count).toBe(0);
      expect(fetchCalled).toBe(0);
    } finally {
      await extension.stop();
    }
  });

  test('pollSpace (scoped pollOnce) also honors the rate-limit cooldown', async () => {
    const db = setupDb();
    const extension = new GitHubEventExtension(db, 'token');
    await extension.start({
      publisher: { publish: async () => {} },
      config: new EnabledConfigStore(),
      onSourceConfigChanged() {},
    });
    extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      pollingEnabled: true,
    });

    (extension as unknown as { rateLimitedUntil: number }).rateLimitedUntil = Date.now() + 300_000;

    let fetchCalled = 0;
    const fetchImpl = (async () => {
      fetchCalled++;
      return makeResponse({ status: 200, remaining: '5000', reset: '', body: [] });
    }) as typeof fetch;

    try {
      const count = await (
        extension as unknown as {
          pollSpace: (spaceId: string, f: typeof fetch) => Promise<number>;
        }
      ).pollSpace('space-1', fetchImpl);
      expect(count).toBe(0);
      expect(fetchCalled).toBe(0);
    } finally {
      await extension.stop();
    }
  });

  test('runPollCycle schedules next poll past reset epoch when rate limited', async () => {
    const db = setupDb();
    let capturedDelay: number | null = null;
    const extension = new GitHubEventExtension(db, 'token', {
      pollIntervalMs: 60_000,
      fetchImpl: (async () => {
        return rateLimitedResetResponse({
          status: 403,
          remaining: 0,
          resetEpochSeconds: Math.floor((Date.now() + 180_000) / 1000),
        });
      }) as typeof fetch,
    });
    await extension.start({
      publisher: { publish: async () => {} },
      config: new EnabledConfigStore(),
      onSourceConfigChanged() {},
    });
    extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      pollingEnabled: true,
    });

    (extension as unknown as { scheduleNextPollAfter: (d: number) => void }).scheduleNextPollAfter =
      (delay: number) => {
        capturedDelay = delay;
      };

    try {
      await (extension as unknown as { runPollCycle: () => Promise<void> }).runPollCycle();
      expect(capturedDelay).not.toBeNull();
      expect(capturedDelay!).toBeGreaterThanOrEqual(60_000);
      expect(capturedDelay!).toBeLessThanOrEqual(180_000);
    } finally {
      await extension.stop();
    }
  });

  test('403 with Retry-After is treated as rate-limited even when remaining > 0', async () => {
    const db = setupDb();
    const extension = new GitHubEventExtension(db, 'token', { pollIntervalMs: 60_000 });
    await extension.start({
      publisher: { publish: async () => {} },
      config: new EnabledConfigStore(),
      onSourceConfigChanged() {},
    });
    extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      pollingEnabled: true,
    });

    let fetchCalled = 0;
    const fetchImpl = (async () => {
      fetchCalled++;
      return new Response('[]', {
        status: 403,
        headers: {
          'X-RateLimit-Remaining': '100',
          'Retry-After': '30',
        },
      });
    }) as typeof fetch;

    try {
      const count = await extension.pollWatchedRepo(
        extension.repo.listPollingRepos()[0],
        fetchImpl
      );
      expect(count).toBe(0);
      expect(fetchCalled).toBe(1);
      const until = (extension as unknown as { rateLimitedUntil: number }).rateLimitedUntil;
      expect(until).toBeGreaterThan(Date.now());
      const delayMs = until - Date.now();
      expect(delayMs).toBeLessThan(35_000);
      expect(delayMs).toBeGreaterThan(25_000);
    } finally {
      await extension.stop();
    }
  });

  test('403 secondary-rate-limit message without headers is treated as rate-limited', async () => {
    const db = setupDb();
    const extension = new GitHubEventExtension(db, 'token', { pollIntervalMs: 60_000 });
    await extension.start({
      publisher: { publish: async () => {} },
      config: new EnabledConfigStore(),
      onSourceConfigChanged() {},
    });
    extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      pollingEnabled: true,
    });

    let fetchCalled = 0;
    const fetchImpl = (async () => {
      fetchCalled++;
      return new Response(JSON.stringify({ message: 'You have exceeded a secondary rate limit' }), {
        status: 403,
        headers: { 'X-RateLimit-Remaining': '100' },
      });
    }) as typeof fetch;

    try {
      const count = await extension.pollWatchedRepo(
        extension.repo.listPollingRepos()[0],
        fetchImpl
      );
      expect(count).toBe(0);
      expect(fetchCalled).toBe(1);
      const until = (extension as unknown as { rateLimitedUntil: number }).rateLimitedUntil;
      expect(until).toBeGreaterThan(Date.now());
      const delayMs = until - Date.now();
      expect(delayMs).toBeGreaterThan(55_000);
      expect(delayMs).toBeLessThan(65_000);
    } finally {
      await extension.stop();
    }
  });

  test('pollWatchedRepo saves cursor after publishing events and then hitting primary rate limit', async () => {
    const db = setupDb();
    const extension = new GitHubEventExtension(db, 'token', { pollIntervalMs: 60_000 });
    await extension.start({
      publisher: { publish: async () => {} },
      config: new EnabledConfigStore(),
      onSourceConfigChanged() {},
    });
    extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      pollingEnabled: true,
    });

    let fetchCalled = 0;
    const row = {
      id: 101,
      html_url: 'https://github.com/acme/widgets/pull/7#issuecomment-101',
      body: 'looks good',
      user: { login: 'bot', type: 'Bot' },
      updated_at: '2026-01-01T00:00:00Z',
      issue: { number: 7, pull_request: { url: 'api' } },
    };
    const fetchImpl = (async () => {
      fetchCalled++;
      if (fetchCalled === 1) {
        return makeResponse({
          status: 200,
          remaining: '50',
          reset: String(Math.floor((Date.now() + 90_000) / 1000)),
          body: [row],
        });
      }
      return rateLimitedResetResponse({
        status: 403,
        remaining: 0,
        resetEpochSeconds: Math.floor((Date.now() + 120_000) / 1000),
      });
    }) as typeof fetch;

    try {
      const repo = extension.repo.listPollingRepos()[0];
      const count = await extension.pollWatchedRepo(repo, fetchImpl);
      expect(count).toBe(1);
      expect(fetchCalled).toBe(2);

      const updated = extension.repo.getWatchedRepoById(repo.id);
      expect(updated?.pollCursor?.lastSeenAt).toBe(0);
      expect(updated?.pollCursor?.endpointLastSeenAt?.issue_comments).toBeGreaterThanOrEqual(
        Date.parse(row.updated_at)
      );
    } finally {
      await extension.stop();
    }
  });

  test('pollSpace breaks loop when rate limit is hit mid-cycle', async () => {
    const db = setupDb();
    let callCount = 0;
    const fetchImpl = (async () => {
      callCount++;
      if (callCount === 1) {
        return rateLimitedResetResponse({
          status: 429,
          remaining: 0,
          resetEpochSeconds: Math.floor((Date.now() + 300_000) / 1000),
        });
      }
      throw new Error('Second repo should not be called due to rate-limit break');
    }) as typeof fetch;

    const extension = new GitHubEventExtension(db, 'token', { pollIntervalMs: 60_000, fetchImpl });
    await extension.start({
      publisher: { publish: async () => {} },
      config: new EnabledConfigStore(),
      onSourceConfigChanged() {},
    });
    extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'widgets',
      pollingEnabled: true,
    });
    extension.repo.upsertWatchedRepo({
      spaceId: 'space-1',
      owner: 'acme',
      repo: 'gadgets',
      pollingEnabled: true,
    });

    try {
      const count = await (
        extension as unknown as {
          pollSpace: (spaceId: string, f: typeof fetch) => Promise<number>;
        }
      ).pollSpace('space-1', fetchImpl);
      expect(count).toBe(0);
      expect(callCount).toBe(1);
    } finally {
      await extension.stop();
    }
  });
});
