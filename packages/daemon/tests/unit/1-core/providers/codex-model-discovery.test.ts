import { beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { mkdtempSync } from 'node:fs';
import {
  CODEX_DISCOVERY_TTL_MS,
  CODEX_MODELS_ENDPOINT,
  CodexModelsCache,
  applyCodexDiscoveryPolicy,
  fetchCodexRemoteModels,
  mergeCodexDiscoveredWithStatic,
  normalizeCodexRemoteModel,
  normalizeCodexRemoteModels,
  parseCodexModelsCacheFile,
} from '../../../../src/lib/providers/codex-model-discovery';

function remoteModel(overrides: Partial<Parameters<typeof normalizeCodexRemoteModel>[0]> = {}) {
  return {
    slug: 'gpt-6-astra',
    display_name: 'GPT-6-Astra',
    description: 'Frontier intelligence for the most demanding work.',
    visibility: 'list' as const,
    supported_in_api: true,
    priority: 2,
    context_window: 272000,
    max_context_window: 872000,
    ...overrides,
  };
}

const LIVE_SHAPED_CATALOG = [
  remoteModel({ slug: 'gpt-6-astra', display_name: 'GPT-6-Astra', priority: 2 }),
  remoteModel({ slug: 'gpt-6-sol', display_name: 'GPT-6-Sol', priority: 3 }),
  remoteModel({ slug: 'gpt-6-luna', display_name: 'GPT-6-Luna', priority: 5 }),
  remoteModel({ slug: 'gpt-5.6-sol', display_name: 'GPT-5.6 Sol', priority: 7 }),
  remoteModel({ slug: 'gpt-5.5', display_name: 'GPT-5.5', priority: 13 }),
  remoteModel({
    slug: 'gpt-reserve',
    display_name: 'GPT Reserve',
    visibility: 'hide',
    priority: 40,
  }),
  remoteModel({
    slug: 'codex-auto-review',
    display_name: 'Codex Auto Review',
    visibility: 'hide',
    priority: 43,
  }),
];

describe('applyCodexDiscoveryPolicy', () => {
  it('drops hidden and non-visible models and keeps listed ones', () => {
    const applied = applyCodexDiscoveryPolicy(LIVE_SHAPED_CATALOG);
    expect(applied.map((model) => model.slug)).toEqual([
      'gpt-6-astra',
      'gpt-6-sol',
      'gpt-6-luna',
      'gpt-5.6-sol',
      'gpt-5.5',
    ]);
  });

  it('orders by discovery priority ascending', () => {
    const applied = applyCodexDiscoveryPolicy(
      LIVE_SHAPED_CATALOG.map((model) =>
        model.slug === 'gpt-5.5' ? { ...model, priority: 1 } : model
      )
    );
    expect(applied[0].slug).toBe('gpt-5.5');
  });

  it('passes through unknown-but-allowed slugs', () => {
    const applied = applyCodexDiscoveryPolicy([
      remoteModel({ slug: 'gpt-7-nova', display_name: 'GPT-7 Nova', priority: 1 }),
    ]);
    expect(applied.map((model) => model.slug)).toEqual(['gpt-7-nova']);
  });

  it('filters denied slugs even when listed', () => {
    const applied = applyCodexDiscoveryPolicy(LIVE_SHAPED_CATALOG, {
      allowPatterns: [/^gpt-/],
      denyPatterns: [/^gpt-5\.5$/],
      pinnedOrder: [],
    });
    expect(applied.some((model) => model.slug === 'gpt-5.5')).toBe(false);
  });

  it('filters slugs outside the allow patterns', () => {
    const applied = applyCodexDiscoveryPolicy([
      remoteModel({ slug: 'o9-preview', display_name: 'O9 Preview', priority: 1 }),
    ]);
    expect(applied).toEqual([]);
  });

  it('pins ordered slugs ahead of priority ordering', () => {
    const applied = applyCodexDiscoveryPolicy(LIVE_SHAPED_CATALOG, {
      allowPatterns: [/^gpt-/],
      denyPatterns: [],
      pinnedOrder: ['gpt-5.5', 'gpt-6-luna'],
    });
    expect(applied.map((model) => model.slug)).toEqual([
      'gpt-5.5',
      'gpt-6-luna',
      'gpt-6-astra',
      'gpt-6-sol',
      'gpt-5.6-sol',
    ]);
  });
});

describe('normalizeCodexRemoteModel', () => {
  it('maps discovery fields onto the internal model descriptor', () => {
    const model = normalizeCodexRemoteModel(remoteModel());
    expect(model).toMatchObject({
      id: 'gpt-6-astra',
      name: 'GPT-6-Astra',
      sdkModelIds: ['gpt-6-astra'],
      family: 'gpt',
      provider: 'anthropic-codex',
      contextWindow: 272000,
      preferContextWindowMetadata: true,
      description: 'Frontier intelligence for the most demanding work.',
      available: true,
    });
  });

  it('reuses static metadata for already-known slugs', () => {
    const model = normalizeCodexRemoteModel(
      remoteModel({ slug: 'gpt-5.5', display_name: 'GPT-5.5' })
    );
    expect(model.alias).toBe('codex-5.5');
    expect(model.providerAliases).toContain('codex-5.5');
    expect(model.releaseDate).toBe('2026-04-01');
  });

  it('falls back to the static context window and display name when discovery omits them', () => {
    const model = normalizeCodexRemoteModel(
      remoteModel({
        slug: 'gpt-5.6-sol',
        context_window: undefined,
        max_context_window: undefined,
        description: undefined,
      })
    );
    expect(model.contextWindow).toBe(1050000);
    expect(model.description).toBe('GPT-6-Astra');
  });

  it('derives safe defaults for brand-new slugs', () => {
    const model = normalizeCodexRemoteModel(
      remoteModel({
        slug: 'gpt-7-nova',
        display_name: '',
        context_window: undefined,
        max_context_window: undefined,
        description: undefined,
      })
    );
    expect(model.name).toBe('gpt-7-nova');
    expect(model.contextWindow).toBe(128000);
    expect(model.description).toBe('gpt-7-nova');
    expect(model.alias).toBe('');
  });
});

describe('normalizeCodexRemoteModels', () => {
  it('applies policy before normalization', () => {
    const models = normalizeCodexRemoteModels(LIVE_SHAPED_CATALOG);
    expect(models.map((model) => model.id)).not.toContain('codex-auto-review');
    expect(models.map((model) => model.id)).not.toContain('gpt-reserve');
  });
});

describe('mergeCodexDiscoveredWithStatic', () => {
  it('returns the static catalog unchanged when discovery produced nothing', () => {
    const merged = mergeCodexDiscoveredWithStatic([]);
    expect(merged.map((model) => model.id)).toContain('gpt-5.3-codex');
    expect(merged.every((model) => model.available)).toBe(true);
  });

  it('marks static models missing from discovery as unavailable without dropping them', () => {
    const merged = mergeCodexDiscoveredWithStatic(normalizeCodexRemoteModels(LIVE_SHAPED_CATALOG));
    const byId = new Map(merged.map((model) => [model.id, model]));
    expect(byId.get('gpt-6-astra')?.available).toBe(true);
    expect(byId.get('gpt-5.5')?.available).toBe(true);
    expect(byId.get('gpt-5.3-codex')?.available).toBe(false);
    expect(byId.get('gpt-5.4')?.available).toBe(false);
  });
});

describe('parseCodexModelsCacheFile', () => {
  it('rejects malformed payloads', () => {
    expect(parseCodexModelsCacheFile('not json', undefined)).toBeNull();
    expect(parseCodexModelsCacheFile('[]', undefined)).toBeNull();
    expect(
      parseCodexModelsCacheFile('{"version":2,"models":[],"fetchedAt":1}', undefined)
    ).toBeNull();
    expect(
      parseCodexModelsCacheFile('{"version":1,"models":{},"fetchedAt":1}', undefined)
    ).toBeNull();
    expect(
      parseCodexModelsCacheFile('{"version":1,"models":[],"fetchedAt":"x"}', undefined)
    ).toBeNull();
  });

  it('rejects entries fetched in the future', () => {
    expect(
      parseCodexModelsCacheFile('{"version":1,"models":[],"fetchedAt":99999999999999}', undefined)
    ).toBeNull();
  });

  it('rejects entries persisted for a different account', () => {
    const raw = JSON.stringify({
      version: 1,
      accountId: 'account-a',
      fetchedAt: Date.now(),
      models: [remoteModel()],
    });
    expect(parseCodexModelsCacheFile(raw, 'account-b')).toBeNull();
    expect(parseCodexModelsCacheFile(raw, 'account-a')?.models.length).toBe(1);
    expect(parseCodexModelsCacheFile(raw, undefined)?.models.length).toBe(1);
  });

  it('skips entries without a usable slug', () => {
    const raw = JSON.stringify({
      version: 1,
      fetchedAt: Date.now(),
      models: [{ slug: '', display_name: 'x' }, { display_name: 'no slug' }, remoteModel()],
    });
    expect(parseCodexModelsCacheFile(raw, undefined)?.models.length).toBe(1);
  });
});

describe('CodexModelsCache', () => {
  let cacheDir: string;
  let cachePath: string;
  let nowMs: number;

  beforeEach(() => {
    cacheDir = mkdtempSync(path.join(os.tmpdir(), 'hyperneo-codex-models-cache-'));
    cachePath = path.join(cacheDir, 'codex-models-cache.json');
    nowMs = Date.now();
  });

  it('round-trips saved models', async () => {
    const cache = new CodexModelsCache(cachePath, CODEX_DISCOVERY_TTL_MS, () => nowMs);
    await cache.save(LIVE_SHAPED_CATALOG, 'account-a');
    const loaded = await cache.loadFresh('account-a');
    expect(loaded?.map((model) => model.slug)).toContain('gpt-6-astra');
  });

  it('serves fresh entries without refetching', async () => {
    const cache = new CodexModelsCache(cachePath, CODEX_DISCOVERY_TTL_MS, () => nowMs);
    await cache.save(LIVE_SHAPED_CATALOG, 'account-a');
    expect(await cache.loadFresh('account-a')).not.toBeNull();
    const staleCache = new CodexModelsCache(
      cachePath,
      CODEX_DISCOVERY_TTL_MS,
      () => nowMs + CODEX_DISCOVERY_TTL_MS + 1
    );
    expect(await staleCache.loadFresh('account-a')).toBeNull();
    expect(await staleCache.loadLastGood('account-a')).not.toBeNull();
  });

  it('keeps last-good entries past the TTL for the fallback ladder', async () => {
    const cache = new CodexModelsCache(cachePath, CODEX_DISCOVERY_TTL_MS, () => nowMs);
    await cache.save(LIVE_SHAPED_CATALOG, 'account-a');
    const muchLater = new CodexModelsCache(
      cachePath,
      CODEX_DISCOVERY_TTL_MS,
      () => nowMs + 90 * 24 * 60 * 60_000
    );
    const lastGood = await muchLater.loadLastGood('account-a');
    expect(lastGood?.map((model) => model.slug)).toContain('gpt-5.5');
  });

  it('returns nothing when no cache file exists', async () => {
    const cache = new CodexModelsCache(cachePath);
    expect(await cache.loadFresh('account-a')).toBeNull();
    expect(await cache.loadLastGood('account-a')).toBeNull();
  });

  it('tolerates a corrupt cache file', async () => {
    await fs.writeFile(cachePath, '{corrupt', 'utf-8');
    const cache = new CodexModelsCache(cachePath);
    expect(await cache.loadFresh('account-a')).toBeNull();
    expect(await cache.loadLastGood('account-a')).toBeNull();
  });

  it('writes atomically and leaves no temp files behind', async () => {
    const cache = new CodexModelsCache(cachePath);
    await cache.save(LIVE_SHAPED_CATALOG, 'account-a');
    const entries = await fs.readdir(cacheDir);
    expect(entries).toEqual(['codex-models-cache.json']);
  });
});

describe('fetchCodexRemoteModels', () => {
  it('sends subscription auth headers to the catalog endpoint', async () => {
    let seenUrl: string | undefined;
    let seenHeaders: Record<string, string> | undefined;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      seenUrl = String(input);
      seenHeaders = init?.headers as Record<string, string>;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    await fetchCodexRemoteModels(
      { apiKey: 'access-token', accountId: 'account-a' },
      fetchImpl,
      1000
    );
    expect(seenUrl).toBe(CODEX_MODELS_ENDPOINT);
    expect(seenHeaders?.authorization).toBe('Bearer access-token');
    expect(seenHeaders?.['ChatGPT-Account-ID']).toBe('account-a');
  });

  it('parses the live response shape', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ models: LIVE_SHAPED_CATALOG }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    const fetched = await fetchCodexRemoteModels(
      { apiKey: 'access-token', accountId: 'account-a' },
      fetchImpl,
      1000
    );
    expect(fetched.length).toBe(LIVE_SHAPED_CATALOG.length);
    expect(fetched[0].slug).toBe('gpt-6-astra');
  });

  it('throws on HTTP failures', async () => {
    const fetchImpl = (async () => new Response('{}', { status: 403 })) as unknown as typeof fetch;
    await expect(
      fetchCodexRemoteModels({ apiKey: 'access-token' }, fetchImpl, 1000)
    ).rejects.toThrow('(HTTP 403)');
  });

  it('throws on payloads without a models array', async () => {
    const fetchImpl = (async () => new Response('{"data": []}', { status: 200 })) as unknown as (
      ...args: unknown[]
    ) => Promise<Response>;
    await expect(
      fetchCodexRemoteModels({ apiKey: 'access-token' }, fetchImpl as typeof fetch, 1000)
    ).rejects.toThrow('unexpected payload');
  });

  it('skips malformed entries instead of failing the whole catalog', async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          models: [
            { nope: true },
            remoteModel(),
            remoteModel({ slug: 'gpt-6-sol', display_name: 'GPT-6-Sol' }),
          ],
        }),
        { status: 200 }
      )) as unknown as typeof fetch;
    const fetched = await fetchCodexRemoteModels({ apiKey: 'access-token' }, fetchImpl, 1000);
    expect(fetched.map((model) => model.slug)).toEqual(['gpt-6-astra', 'gpt-6-sol']);
  });
});
