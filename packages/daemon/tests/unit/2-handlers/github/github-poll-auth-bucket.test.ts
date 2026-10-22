import { afterEach, describe, expect, test } from 'bun:test';
import { vi } from 'vitest';
import { fetchGitHubViaCli } from '../../../../src/lib/github/gh-api-fetch';
import { runGhJson } from '../../../../src/lib/github/gh-lookup-helpers';
import { parseRateLimitHeaders } from '../../../../src/lib/external-events/github/github-event-extension';
import type { SpawnFn } from '../../../../src/lib/runtime-spawn';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from '../../../../src/storage/sqlite-compat';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import { ExternalEventExtensionConfigStore } from '../../../../src/lib/external-events';
import { GitHubEventExtension } from '../../../../src/lib/external-events/github/github-event-extension';

const owned: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const path of owned.splice(0)) rmSync(path, { recursive: true, force: true });
});

for (const status of [404, 403]) {
  describe(`GitHub polling with a CLI login and anonymous HTTP ${status}`, () => {
    test('private watched repos use the authenticated CLI bucket without an anonymous cooldown', async () => {
      const run = mkdtempSync(join(tmpdir(), 'github-bucket-'));
      owned.push(run);
      mkdirSync(join(run, 'bin'));
      vi.stubEnv('HOME', run);
      vi.stubEnv('GH_TOKEN', undefined);
      vi.stubEnv('GITHUB_TOKEN', undefined);
      vi.stubEnv('GH_CONFIG_DIR', run);
      vi.stubEnv('PATH', `${join(run, 'bin')}:${process.env.PATH}`);
      writeFileSync(
        join(run, 'bin/gh'),
        `#!${process.execPath}\nconst fs = require('node:fs');\nconst args = process.argv.slice(2);\nif (args[0] !== 'api' || !args.includes('--include')) process.exit(2);\nfs.appendFileSync(${JSON.stringify(join(run, 'calls'))}, JSON.stringify(args)+'\\n');\nprocess.stdout.write('HTTP/2.0 200 OK\\r\\nX-RateLimit-Limit: 5000\\r\\nX-RateLimit-Remaining: 4999\\r\\nX-RateLimit-Resource: core\\r\\nX-RateLimit-Reset: 9999999999\\r\\nContent-Type: application/json\\r\\n\\r\\n[]');\n`,
        { mode: 0o700 }
      );
      const anonymous = vi.fn(async () =>
        Response.json(
          { message: status === 403 ? 'API rate limit exceeded' : 'Not Found' },
          {
            status,
            headers: {
              'X-RateLimit-Limit': '60',
              'X-RateLimit-Remaining': status === 403 ? '0' : '59',
              'X-RateLimit-Reset': String(Math.ceil(Date.now() / 1000) + 3600),
              'X-RateLimit-Resource': 'core',
            },
          }
        )
      );
      vi.stubGlobal('fetch', anonymous);
      const db = new Database(':memory:');
      createTables(db);
      runMigrations(db, () => {});
      const config = new ExternalEventExtensionConfigStore(db);
      await config.setGlobalConfig('github', {
        source: 'github',
        globallyEnabled: true,
        capabilities: { polling: true },
      });
      const extension = new GitHubEventExtension(db, undefined, { pollIntervalMs: 60_000 });
      for (const repo of ['phone', 'ops', 'research'])
        extension.repo.upsertWatchedRepo({
          spaceId: 'test-space',
          owner: 'synthetic',
          repo,
          pollingEnabled: true,
        });
      await extension.start({
        config,
        publisher: { publish: async () => {} },
        onSourceConfigChanged() {},
      });
      try {
        await extension.pollOnce();
        await extension.pollOnce();
        expect(extension.repo.listPollingRepos().every((repo) => repo.lastPollAt !== null)).toBe(
          true
        );
        expect(anonymous).not.toHaveBeenCalled();
        const calls = readFileSync(join(run, 'calls'), 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as string[]);
        expect(calls.some((args) => args.some((arg) => arg.includes('/phone/')))).toBe(true);
        expect(calls.some((args) => args.some((arg) => arg.includes('/research/')))).toBe(true);
        expect(calls.every((args) => !args.includes('graphql') && !args.includes('auth'))).toBe(
          true
        );
      } finally {
        await extension.stop();
        db.close();
      }
    });
  });
}

describe('GitHub rate-limit bucket evidence', () => {
  for (const remaining of [4866, 0]) {
    test(`a GraphQL refusal with ${remaining} remaining uses the appropriate retry window`, async () => {
      let calls = 0;
      const spawn: SpawnFn = () => {
        const probe = calls++ > 0;
        const text = probe
          ? JSON.stringify({
              resources: { graphql: { remaining, reset: Math.ceil(Date.now() / 1000) + 3600 } },
            })
          : '';
        const stream = (value: string) =>
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(value));
              controller.close();
            },
          });
        return {
          stdout: stream(text),
          stderr: stream(
            probe ? '' : 'GraphQL: API rate limit already exceeded for user ID synthetic'
          ),
          exited: Promise.resolve(probe ? 0 : 1),
          exitCode: probe ? 0 : 1,
          kill() {},
        };
      };
      const outcome = await runGhJson(['gh', 'api', 'graphql'], '/tmp', spawn, {
        resourceHint: 'graphql',
      });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error('expected refusal');
      expect(outcome.retryable).toBe(true);
      if (remaining > 0) expect(outcome.retryAfterMs).toBe(60_000);
      else expect(outcome.retryAfterMs).toBeGreaterThan(3_500_000);
    });
  }

  test('a secondary Retry-After is authoritative despite a healthy hourly bucket', () => {
    const now = Date.now();
    const rate = parseRateLimitHeaders(
      new Response('', {
        status: 403,
        headers: {
          'X-RateLimit-Remaining': '4866',
          'X-RateLimit-Reset': String(Math.ceil(now / 1000) + 3600),
          'Retry-After': '120',
        },
      })
    );
    expect(rate.limited).toBe(true);
    expect(rate.retryAfter).toBe(true);
    expect(rate.resetAt).toBeGreaterThanOrEqual(now + 120_000);
    expect(rate.resetAt).toBeLessThan(now + 121_000);
  });
});

describe('GitHub CLI response metadata', () => {
  for (const status of [200, 403]) {
    test(`HTTP ${status} preserves JSON or the server Retry-After`, async () => {
      const calls: string[][] = [];
      const spawn: SpawnFn = (args) => {
        calls.push(args);
        const stream = (text: string) =>
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(text));
              controller.close();
            },
          });
        return {
          stdout: stream(
            `HTTP/2.0 ${status} Synthetic\r\nRetry-After: 120\r\nX-RateLimit-Remaining: 4866\r\n\r\n{"synthetic":true}`
          ),
          stderr: stream(status === 403 ? 'secondary rate limit' : ''),
          exited: Promise.resolve(status === 403 ? 1 : 0),
          exitCode: status === 403 ? 1 : 0,
          kill() {},
        };
      };
      const result = await runGhJson(['gh', 'api', 'graphql'], '/tmp', spawn, {
        resourceHint: 'graphql',
      });
      if (status === 200) expect(result).toEqual({ ok: true, data: { synthetic: true } });
      else {
        expect(result.ok).toBe(false);
        expect(result.retryAfterMs).toBe(120_000);
      }
      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain('--include');
    });
  }
});

describe('authenticated GitHub polling transport', () => {
  for (const status of [304, 403]) {
    test(`preserves HTTP ${status} metadata and conditional headers`, async () => {
      const calls: string[][] = [];
      const spawn: SpawnFn = (args) => {
        calls.push(args);
        const stream = (text: string) =>
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(text));
              controller.close();
            },
          });
        return {
          stdout: stream(
            `HTTP/2.0 ${status} Synthetic\r\nRetry-After: 120\r\nX-RateLimit-Limit: 5000\r\nX-RateLimit-Resource: core\r\n\r\n${status === 304 ? '' : '{"message":"secondary rate limit"}'}`
          ),
          stderr: stream(''),
          exited: Promise.resolve(1),
          exitCode: 1,
          kill() {},
        };
      };
      const response = await fetchGitHubViaCli(
        'https://api.github.com/repos/synthetic/private/pulls',
        { headers: { 'If-None-Match': 'synthetic-etag' } },
        spawn
      );
      expect(response.status).toBe(status);
      expect(response.headers.get('retry-after')).toBe('120');
      expect(response.headers.get('x-ratelimit-limit')).toBe('5000');
      expect(calls[0]).toContain('If-None-Match: synthetic-etag');
      expect(calls[0]).not.toContain('auth');
      if (status === 304) expect(await response.text()).toBe('');
    });
  }

  function response(status: number, body: string, code = 0): SpawnFn {
    return () => ({
      stdout: new Response(`HTTP/2.0 ${status} Synthetic\r\n\r\n${body}`).body!,
      stderr: new Response('').body!,
      exited: Promise.resolve(code),
      exitCode: code,
      kill() {},
    });
  }

  test('a complete 100-comment page larger than the script buffer keeps every body byte', async () => {
    const rows = Array.from({ length: 100 }, (_, id) => ({ id, body: 'x'.repeat(16_384) }));
    const result = await fetchGitHubViaCli(
      'https://api.github.com/repos/synthetic/private/pulls/comments?per_page=100',
      {},
      response(200, JSON.stringify(rows))
    );
    expect(await result.json()).toEqual(rows);
  });

  test('an oversized GitHub response still refuses instead of parsing truncated data', async () => {
    await expect(
      fetchGitHubViaCli(
        'https://api.github.com/repos/synthetic/private/pulls/comments?per_page=100',
        {},
        response(200, 'x'.repeat(16 * 1_048_576 + 1))
      )
    ).rejects.toThrow('size limit');
  });

  test.each([200, 302])(
    'nonzero exit with HTTP %s remains an incomplete response',
    async (status) => {
      await expect(
        fetchGitHubViaCli(
          'https://api.github.com/repos/synthetic/private/pulls',
          {},
          response(status, '[]', 1)
        )
      ).rejects.toThrow('failed before a complete response');
    }
  );

  test('an already-aborted request starts no credential helper', async () => {
    const controller = new AbortController();
    controller.abort();
    const spawn = vi.fn<SpawnFn>();
    await expect(
      fetchGitHubViaCli(
        'https://api.github.com/repos/synthetic/private',
        { signal: controller.signal },
        spawn
      )
    ).rejects.toThrow();
    expect(spawn).not.toHaveBeenCalled();
  });

  test('GH_TOKEN is honored by the daemon path without printing or extracting it', async () => {
    vi.stubEnv('GH_TOKEN', 'synthetic-gh-token');
    vi.stubEnv('GITHUB_TOKEN', undefined);
    const seen: string[] = [];
    const fetchImpl = (async (_input, init) => {
      seen.push(new Headers(init?.headers).get('authorization') ?? '');
      return Response.json([], { headers: { 'X-RateLimit-Remaining': '5000' } });
    }) as typeof fetch;
    const db = new Database(':memory:');
    createTables(db);
    runMigrations(db, () => {});
    const config = new ExternalEventExtensionConfigStore(db);
    await config.setGlobalConfig('github', {
      source: 'github',
      globallyEnabled: true,
      capabilities: { polling: true },
    });
    const extension = new GitHubEventExtension(db, undefined, {
      fetchImpl,
      pollIntervalMs: 60_000,
    });
    extension.repo.upsertWatchedRepo({
      spaceId: 'test-space',
      owner: 'synthetic',
      repo: 'private',
      pollingEnabled: true,
    });
    await extension.start({
      config,
      publisher: { publish: async () => {} },
      onSourceConfigChanged() {},
    });
    try {
      await extension.pollOnce();
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((value) => value === 'Bearer synthetic-gh-token')).toBe(true);
    } finally {
      await extension.stop();
      db.close();
    }
  });
});

test('a failed configured credential read does not switch to anonymous or another account', async () => {
  const run = mkdtempSync(join(tmpdir(), 'github-credential-fault-'));
  owned.push(run);
  mkdirSync(join(run, 'bin'));
  vi.stubEnv('HOME', run);
  vi.stubEnv('GH_TOKEN', undefined);
  vi.stubEnv('GITHUB_TOKEN', undefined);
  vi.stubEnv('PATH', `${join(run, 'bin')}:${process.env.PATH}`);
  writeFileSync(
    join(run, 'bin/gh'),
    `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(join(run, 'unexpected-cli'))}, 'called');\nprocess.exit(1);\n`,
    { mode: 0o700 }
  );
  const network = vi.fn(async () => Response.json([]));
  vi.stubGlobal('fetch', network);
  const db = new Database(':memory:');
  createTables(db);
  runMigrations(db, () => {});
  const config = new ExternalEventExtensionConfigStore(db);
  await config.setGlobalConfig('github', {
    source: 'github',
    globallyEnabled: true,
    capabilities: { polling: true },
  });
  const extension = new GitHubEventExtension(db, undefined, {
    pollIntervalMs: 60_000,
    credentialStore: {
      get: async () => {
        throw new Error('synthetic credential store locked');
      },
      set: async () => {},
      delete: async () => {},
      listServices: async () => [],
    },
  });
  extension.repo.upsertWatchedRepo({
    spaceId: 'test-space',
    owner: 'synthetic',
    repo: 'private',
    pollingEnabled: true,
  });
  await extension.start({
    config,
    publisher: { publish: async () => {} },
    onSourceConfigChanged() {},
  });
  try {
    await extension.pollOnce();
    expect(network).not.toHaveBeenCalled();
    expect(existsSync(join(run, 'unexpected-cli'))).toBe(false);
    expect(extension.repo.listPollingRepos()[0].lastPollAt).toBeNull();
  } finally {
    await extension.stop();
    db.close();
  }
});
