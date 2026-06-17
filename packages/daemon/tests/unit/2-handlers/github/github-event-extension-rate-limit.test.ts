/**
 * Unit tests for rate-limit awareness in the GitHub event extension.
 *
 * Covers:
 *   - parseRateLimitHeaders parsing valid / missing / malformed headers
 *   - pollWatchedRepo deferring the cycle when remaining drops below threshold
 *   - pollWatchedRepo aborting on 403 with X-RateLimit-Reset
 *   - pollEnabledSpaces skipping entirely when rate-limited
 *   - next poll scheduled past resetAt when rate limited (via scheduleNextPollAfter)
 */
import { Database as BunDatabase } from 'bun:sqlite';
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
  body?: unknown;
}): Response {
  const headers = new Headers();
  if (opts.remaining !== null) headers.set('X-RateLimit-Remaining', opts.remaining ?? '5000');
  if (opts.reset !== null) headers.set('X-RateLimit-Reset', opts.reset ?? '');
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
    // 403 + remaining=0 → rate-limited
    const resLimiter = makeResponse({ status: 403, remaining: '0', reset: '1700000000' });
    expect(parseRateLimitHeaders(resLimiter).limited).toBe(true);
    // 403 + remaining>0 → permission error, NOT rate-limited
    const resPerms = makeResponse({ status: 403, remaining: '4999', reset: '1700000000' });
    expect(parseRateLimitHeaders(resPerms).limited).toBe(false);
    // 403 + missing remaining → cannot prove rate-limit, treat as not limited
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
        // X-RateLimit-Reset far in the future; Retry-After should win.
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
  test('pollWatchedRepo returns 0 and defers next cycle when remaining < threshold', async () => {
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

    // Remaining=5 — below threshold of 10. Should short-circuit without parsing rows.
    let fetchCalled = 0;
    const fetchImpl = (async () => {
      fetchCalled++;
      return rateLimitedResetResponse({
        status: 200,
        remaining: 5,
        resetEpochSeconds: Math.floor((Date.now() + 90_000) / 1000),
      });
    }) as typeof fetch;

    try {
      const count = await extension.pollWatchedRepo(
        extension.repo.listPollingRepos()[0],
        fetchImpl
      );
      expect(count).toBe(0);
      expect(fetchCalled).toBe(1); // stopped after first endpoint
      // Internal rate-limit window was set
      const until = (extension as unknown as { rateLimitedUntil: number }).rateLimitedUntil;
      expect(until).toBeGreaterThan(Date.now());
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

    // Simulate already-rate-limited state
    (extension as unknown as { rateLimitedUntil: number }).rateLimitedUntil = Date.now() + 300_000;

    let fetchCalled = 0;
    const fetchImpl = (async () => {
      fetchCalled++;
      return makeResponse({ status: 200, remaining: '5000', reset: '', body: [] });
    }) as typeof fetch;

    try {
      // Access private method via cast
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

    // Shared cooldown active — scoped poll must short-circuit.
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

    // Override scheduleNextPollAfter to capture the requested delay without arming a real timer.
    (extension as unknown as { scheduleNextPollAfter: (d: number) => void }).scheduleNextPollAfter =
      (delay: number) => {
        capturedDelay = delay;
      };

    try {
      await (extension as unknown as { runPollCycle: () => Promise<void> }).runPollCycle();
      expect(capturedDelay).not.toBeNull();
      // Deferral should be at least the minimum backoff (60s) and reflect the
      // 180s reset window (so somewhere between 60s and 180s).
      expect(capturedDelay!).toBeGreaterThanOrEqual(60_000);
      expect(capturedDelay!).toBeLessThanOrEqual(180_000);
    } finally {
      await extension.stop();
    }
  });
});
