import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Provider, ProviderUsageResult } from '@hyperneo/shared/provider';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { createModelRoutingPack } from '../../../../src/lib/neo/packs/model-routing/pack.ts';
import {
  type RankInput,
  rankLines,
  USAGE_STALE_MS,
} from '../../../../src/lib/neo/packs/model-routing/rank.ts';

const NOW = Date.parse('2026-11-16T12:00:00Z');
const A = { provider: 'anthropic', model: 'opus', harness: 'hyperneo' };
const B = { provider: 'anthropic-codex', model: 'gpt', harness: 'codex-desktop' };
const C = { provider: 'kimi', model: 'k2', harness: 'hyperneo' };
const usage = (used: number, readAt = NOW): RankInput['usage'][string] => ({
  result: {
    supported: true,
    provider: 'x',
    windows: [{ label: 'week', used, limit: 100, resetAt: null }],
  },
  readAt,
});
const input = (overrides: Partial<RankInput> = {}): RankInput => ({
  kind: 'coding.write',
  candidates: [A, B, C],
  scope: {},
  prefs: { routes: [], rules: [] },
  holds: [],
  usage: {},
  availability: { anthropic: 'ready', 'anthropic-codex': 'ready', kimi: 'ready' },
  now: NOW,
  ...overrides,
});

describe('rankLines', () => {
  test('keeps a configured line with no usage reader ranked, marked usage unknown', () => {
    const notSupported: ProviderUsageResult = {
      supported: false,
      provider: 'kimi',
      reason: 'not_supported',
    };
    expect(
      rankLines(input({ candidates: [C], usage: { kimi: { result: notSupported, readAt: NOW } } }))
    ).toEqual({ ranked: [{ line: C, reason: 'usage unknown' }], skipped: [], exhausted: false });
  });

  test.each<[string, Partial<RankInput>, string]>([
    [
      'a provider that is not configured',
      { availability: { 'anthropic-codex': 'ready', kimi: 'ready' } },
      'not configured',
    ],
    [
      'a provider that is not signed in',
      { availability: { anthropic: 'not signed in', 'anthropic-codex': 'ready', kimi: 'ready' } },
      'not signed in',
    ],
    [
      'a held line',
      { holds: [{ provider: 'anthropic', model: 'opus', reason: 'limit', retryAt: NOW + 60_000 }] },
      'held (limit) until 2026-11-16T12:01:00.000Z',
    ],
    ['an exhausted usage window', { usage: { anthropic: usage(100) } }, 'usage exhausted'],
    [
      'usage over the route’s stopAtPercent',
      {
        usage: { anthropic: usage(95) },
        prefs: {
          routes: [{ kind: 'coding.write', lines: [{ ...A, stopAtPercent: 90 }] }],
          rules: [],
        },
      },
      'over stopAtPercent 90',
    ],
    [
      'a line a rule excludes for this kind',
      { prefs: { routes: [], rules: [{ line: A, never: { kinds: ['coding.write'] } }] } },
      'excluded by a rule',
    ],
  ])('skips %s and says why', (_label, overrides, reason) => {
    const ranking = rankLines(input(overrides));
    expect(ranking.skipped).toEqual([{ line: A, reason }]);
    expect(ranking.ranked.map((entry) => entry.line)).toEqual([B, C]);
  });

  test('keeps a line at or under its stopAtPercent', () => {
    const routes = [{ kind: 'coding.write', lines: [{ ...A, stopAtPercent: 90 }] }];
    expect(
      rankLines(input({ usage: { anthropic: usage(90) }, prefs: { routes, rules: [] } })).ranked[0]
    ).toEqual({ line: A });
  });

  test('ranks a line whose hold has passed as usage unknown, and skips one still held', () => {
    const passed = rankLines(
      input({
        candidates: [A],
        holds: [{ provider: 'anthropic', model: 'opus', retryAt: NOW - 1 }],
      })
    );
    expect(passed.ranked).toEqual([{ line: A, reason: 'usage unknown' }]);
    const held = rankLines(
      input({
        candidates: [A],
        holds: [{ provider: 'anthropic', model: 'opus', retryAt: NOW + 1 }],
      })
    );
    expect(held.skipped.map((entry) => entry.line)).toEqual([A]);
  });

  test('treats a reading older than 15 minutes as usage unknown', () => {
    const stale = usage(100, NOW - USAGE_STALE_MS - 1);
    expect(rankLines(input({ candidates: [A], usage: { anthropic: stale } }))).toEqual({
      ranked: [{ line: A, reason: 'usage unknown' }],
      skipped: [],
      exhausted: false,
    });
  });

  test('is exhausted only when every candidate is skipped', () => {
    const ranking = rankLines(input({ availability: {} }));
    expect(ranking.ranked).toEqual([]);
    expect(ranking.skipped.map((entry) => entry.reason)).toEqual([
      'not configured',
      'not configured',
      'not configured',
    ]);
    expect(ranking.exhausted).toBe(true);
    expect(rankLines(input({ availability: { kimi: 'ready' } })).exhausted).toBe(false);
  });

  test('lists route lines first in route order, the rest in caller order, and a repo route wins', () => {
    const routes = [
      { kind: 'coding.write', lines: [C] },
      { kind: 'coding.write', repos: ['org/app'], lines: [B] },
    ];
    const order = (scope: RankInput['scope']) =>
      rankLines(input({ scope, prefs: { routes, rules: [] } })).ranked.map((entry) => entry.line);
    expect(order({})).toEqual([C, A, B]);
    expect(order({ repo: 'org/app' })).toEqual([B, A, C]);
  });

  test('applies two only entries for one line as either-or', () => {
    const rules = [
      { line: A, only: { kinds: ['coding.review'] } },
      { line: A, only: { kinds: ['coding.write'], repos: ['org/tools'] } },
    ];
    const usable = (kind: string, repo: string) =>
      rankLines(input({ kind, candidates: [A], scope: { repo }, prefs: { routes: [], rules } }))
        .ranked.length === 1;
    expect(usable('coding.review', 'org/app')).toBe(true);
    expect(usable('coding.write', 'org/tools')).toBe(true);
    expect(usable('coding.write', 'org/app')).toBe(false);
  });
});

describe('createModelRoutingPack', () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, () => {});
    createTables(db);
  });
  afterEach(() => db.close());

  const provider = (signedIn: boolean, used: number | null): Provider =>
    ({
      isAvailable: async () => signedIn,
      getAuthStatus: async () => ({ isAuthenticated: signedIn }),
      ...(used === null
        ? {}
        : {
            getUsage: async () => ({
              supported: true,
              provider: 'x',
              windows: [{ label: 'week', used, limit: 100, resetAt: null }],
            }),
          }),
    }) as unknown as Provider;

  test('reads holds from held sessions, usage and sign-in from providers, and saved routes', async () => {
    db.prepare(
      `INSERT INTO sessions (id, title, workspace_path, created_at, last_active_at, status, config, metadata, processing_state)
       VALUES ('held', 't', '/w', '2026-11-16', '2026-11-16', 'active', ?, '{}', ?)`
    ).run(
      JSON.stringify({ provider: 'anthropic', model: 'opus' }),
      JSON.stringify({
        status: 'rate_limit_cooldown',
        retryCount: 0,
        maxRetries: 0,
        retryAt: NOW + 60_000,
        reason: 'limit',
      })
    );
    db.prepare(
      `INSERT INTO neo_pack_preferences (pack, scope_kind, scope_key, key, value_json, set_by, set_at)
       VALUES ('model-routing', 'global', '', 'routes', ?, 'human', 1)`
    ).run(JSON.stringify([{ kind: 'coding.write', lines: [C, B] }]));
    const providers: Record<string, Provider> = {
      anthropic: provider(true, 10),
      'anthropic-codex': provider(true, 100),
      kimi: provider(false, null),
    };
    const pack = createModelRoutingPack({
      database: () => db,
      provider: (id) => providers[id],
      now: () => NOW,
    });

    const gone = { provider: 'not-installed', model: 'x' };
    const ranking = await pack.rankLines!('coding.write', [A, B, C, gone], {});

    expect(ranking).toEqual({
      ranked: [],
      skipped: [
        { line: C, reason: 'not signed in' },
        { line: B, reason: 'usage exhausted' },
        { line: A, reason: 'held (limit) until 2026-11-16T12:01:00.000Z' },
        { line: gone, reason: 'not configured' },
      ],
      exhausted: true,
    });
    providers.kimi = provider(true, null);
    expect((await pack.rankLines!('coding.write', [A, B, C], {})).ranked).toEqual([
      { line: C, reason: 'usage unknown' },
    ]);
  });

  test('a provider whose usage or sign-in read hangs cannot block ranking', async () => {
    const never = () => new Promise<never>(() => {});
    const providers: Record<string, Provider> = {
      anthropic: { ...provider(true, null), getUsage: never } as unknown as Provider,
      'anthropic-codex': provider(true, 10),
      kimi: { ...provider(true, null), isAvailable: never } as unknown as Provider,
    };
    const pack = createModelRoutingPack({
      database: () => db,
      provider: (id) => providers[id],
      now: () => NOW,
      readDeadlineMs: 20,
    });
    expect(await pack.rankLines!('coding.write', [A, B, C], {})).toEqual({
      ranked: [{ line: A, reason: 'usage unknown' }, { line: B }],
      skipped: [{ line: C, reason: 'availability unknown' }],
      exhausted: false,
    });
  });

  test('usage is read in parallel and a fresh reading is not read again', async () => {
    let reads = 0;
    let open = 0;
    let most = 0;
    const counted = {
      ...provider(true, null),
      getUsage: async () => {
        reads += 1;
        open += 1;
        most = Math.max(most, open);
        await new Promise((resolve) => setTimeout(resolve, 5));
        open -= 1;
        return { supported: true, provider: 'x', windows: [] };
      },
    } as unknown as Provider;
    const pack = createModelRoutingPack({
      database: () => db,
      provider: () => counted,
      now: () => NOW,
    });
    await pack.rankLines!('coding.write', [A, B, C], {});
    await pack.rankLines!('coding.write', [A, B, C], {});
    expect({ reads, most }).toEqual({ reads: 3, most: 3 });
  });

  test('ignores holds left on archived and ended sessions', async () => {
    const cooling = JSON.stringify({
      status: 'rate_limit_cooldown',
      retryCount: 0,
      maxRetries: 0,
      retryAt: NOW + 60_000,
      reason: 'limit',
    });
    const insert = db.prepare(
      `INSERT INTO sessions (id, title, workspace_path, created_at, last_active_at, status, config, metadata, processing_state, archived_at)
       VALUES (?, 't', '/w', '2026-11-16', '2026-11-16', ?, ?, '{}', ?, ?)`
    );
    const config = JSON.stringify({ provider: 'anthropic', model: 'opus' });
    insert.run('archived', 'archived', config, cooling, '2026-11-16');
    insert.run('ended', 'ended', config, cooling, null);
    const pack = createModelRoutingPack({
      database: () => db,
      provider: () => provider(true, 10),
      now: () => NOW,
    });

    expect(await pack.rankLines!('coding.write', [A], {})).toEqual({
      ranked: [{ line: A }],
      skipped: [],
      exhausted: false,
    });
  });
});
