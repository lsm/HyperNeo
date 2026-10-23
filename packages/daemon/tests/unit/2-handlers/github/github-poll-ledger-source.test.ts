import { expect, test } from 'bun:test';
import { createGitHubPollSource } from '../../../../src/lib/github/poll-source.ts';
import { CodingPollFactsRepository } from '../../../../src/lib/neo/packs/coding/poll-facts.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

const url = 'https://api.github.com/repos/synthetic/shared/pulls/7';
const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
function setup() {
  const db = new Database(':memory:');
  createCodingPackTables(db);
  const facts = new CodingPollFactsRepository(db);
  let requests = 0;
  const source = (cycle: string, credentialId = 'opaque-one', readFailed = false) =>
    createGitHubPollSource({
      collection: { collect: (...args) => facts.collect(...args), cycle, credentialId },
      fetchImpl: (async () => {
        requests++;
        return Response.json(
          { head: `head-${requests}` },
          {
            headers: { etag: `"page-${requests}"`, 'x-ratelimit-remaining': '90' },
          }
        );
      }) as typeof fetch,
      hasInjectedFetch: true,
      hasToken: !readFailed,
      readFailed,
      credentialSource: 'credential-store',
      repo: 'synthetic/shared',
      observe: () => {},
      onAccessible: () => {},
    });
  return { db, source, requests: () => requests };
}

test('polling sources share one page across destinations and refresh a later cycle head', async () => {
  const { db, source, requests } = setup();
  try {
    const first = await source('first')(url, { headers });
    const second = await source('first')(new Request(url, { headers }));
    expect(await first.json()).toEqual({ head: 'head-1' });
    expect(await second.json()).toEqual({ head: 'head-1' });
    expect(second.headers.get('x-ratelimit-remaining')).toBe('90');
    expect(requests()).toBe(1);
    const next = await source('next')(new URL(url), { headers });
    const other = await source('next')(url, { headers });
    expect(await next.json()).toEqual({ head: 'head-2' });
    expect(await other.json()).toEqual({ head: 'head-2' });
    expect(requests()).toBe(2);
  } finally {
    db.close();
  }
});

test('polling collection keeps credential and representation coverage separate', async () => {
  const { db, source, requests } = setup();
  try {
    await source('same', 'opaque-one')(url, { headers });
    await source('same', 'opaque-two')(url, { headers });
    await source('same')(url, { headers: { ...headers, Accept: 'application/json' } });
    await source('same')(url, {
      headers: { ...headers, 'X-GitHub-Api-Version': 'next-version' },
    });
    expect(requests()).toBe(4);
    expect(db.prepare('SELECT subject FROM pack_coding_poll_facts').all()).toHaveLength(4);
  } finally {
    db.close();
  }
});

test('failed configured credentials refuse even a covered page before collection', async () => {
  const { db, source, requests } = setup();
  try {
    await source('same')(url, { headers });
    await expect(source('same', 'opaque-one', true)(url, { headers })).rejects.toThrow(
      'Configured GitHub credentials unavailable'
    );
    expect(requests()).toBe(1);
  } finally {
    db.close();
  }
});
