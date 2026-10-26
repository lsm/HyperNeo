import { describe, expect, test } from 'bun:test';
import { runGhJson } from '../../../../src/lib/github/gh-lookup-helpers.ts';
import type { SpawnFn } from '../../../../src/lib/runtime-spawn/index.ts';
import { createCodingQuotaReader, type LedgerQuotaRun } from '../../../../src/lib/neo/packs/coding/ledger-quota.ts';

describe('credential quota acquisition', () => {
  for (const remaining of [0, 1200]) test(`uses the failing response headers with remaining ${remaining}, not the quota overview`, async () => {
    const now = Date.now(), reset = Math.floor((now + 10000) / 1000), calls: string[][] = [];
    const spawn: SpawnFn = (args) => {
      const argv = args.map(String); calls.push(argv);
      const overview = argv.includes('/rate_limit');
      const stdout = overview ? JSON.stringify({resources:{graphql:{remaining:remaining ? 0 : 4000,reset:reset+3500}}})
        : `HTTP/2.0 403 Forbidden\r\nx-ratelimit-resource: graphql\r\nx-ratelimit-remaining: ${remaining}\r\nx-ratelimit-reset: ${reset}\r\n\r\n{}`;
      return { stdout: new Response(stdout).body!, stderr: new Response('API rate limit exceeded').body!, exited: Promise.resolve(overview ? 0 : 1), pid: 1, kill() {} } as ReturnType<SpawnFn>;
    };
    const result = await runGhJson(['gh','api','graphql'], '.', spawn, { resourceHint: 'graphql' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected refusal');
    expect(calls).toHaveLength(1);
    expect(result.retryAfterMs).toBeGreaterThan(0);
    expect(result.retryAfterMs!).toBeLessThanOrEqual(60000);
    if (!remaining) expect(result.retryAfterMs!).toBeLessThanOrEqual(10000);
  });
  function setup(actor: number | null = 1) {
    const calls: string[] = [];
    const run: LedgerQuotaRun = async (args, resource) => {
      calls.push(args[2]);
      if (args[2] === 'user') return { ok: true, data: actor ? { id: actor, url: `https://api.github.com/users/actor${actor}` } : {} };
      if (resource === 'core') return { ok: true, data: [] };
      return { ok: false, error: 'API rate limit exceeded', retryAfterMs: 60000, quota: {
        status: 403, resource: 'graphql', remaining: 0, resetAt: Date.now()+60000,
        retryAfterMs: null, requestId: 'synthetic',
      } };
    };
    return { read: createCodingQuotaReader(run), run, calls };
  }
  test('a known-account cooldown survives reader recreation without blocking core reads or another account', async () => {
    const first = setup();
    const refused = await first.read(['gh','api','graphql'],'graphql');
    expect(refused.ok).toBe(false);
    const restarted = createCodingQuotaReader(first.run);
    const blocked = await restarted(['gh','api','graphql'],'graphql',refused.quota);
    expect(blocked.quota?.deferred).toBe(true);
    expect(first.calls.filter(call=>call==='graphql')).toHaveLength(1);
    expect((await restarted(['gh','api','repos/synthetic/repo/pulls'],'core',refused.quota)).ok).toBe(true);
    const second = setup(2);
    const independent = await second.read(['gh','api','graphql'],'graphql',refused.quota);
    expect(independent.quota?.deferred).not.toBe(true);
    expect(second.calls.filter(call=>call==='graphql')).toHaveLength(1);
  });
  test('unknown identity cannot create a shared cooldown', async () => {
    const f = setup(null);
    const first = await f.read(['gh','api','graphql'],'graphql');
    const second = await f.read(['gh','api','graphql'],'graphql',first.quota);
    expect(second.quota?.deferred).not.toBe(true);
    expect(f.calls.filter(call=>call==='graphql')).toHaveLength(2);
  });
  test('older target evidence cannot shorten a more recent bucket cooldown', async () => {
    const f = setup();
    const first = await f.read(['gh','api','graphql'],'graphql');
    const shorter = { ...first.quota!, retryAt: Date.now()+1000 };
    const next = await f.read(['gh','api','graphql'],'graphql',shorter);
    expect(next.quota?.retryAt).toBe(first.quota?.retryAt);
  });
});
