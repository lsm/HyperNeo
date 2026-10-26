import { describe, expect, test } from 'bun:test';
import { createCodingLedgerReader } from '../../../../src/lib/neo/packs/coding/pr-ledger-source.ts';
import { planCodingLedgerRead } from '../../../../src/lib/neo/packs/coding/pr-ledger.ts';

function fixture(remaining = 4000, resetAt = '2099-01-01T00:00:00Z') {
  const pull = {
    number: 1,
    title: 'Visible title',
    head: { ref: 'branch', sha: 'head' },
    updated_at: 'initial',
    created_at: '2026-01-01T00:00:00Z',
    closed_at: null,
    draft: false,
    base: { repo: { full_name: 'synthetic/repo' } },
  };
  const fact = {
    number: 1,
    title: pull.title,
    headRefName: 'branch',
    headRefOid: 'head',
    state: 'OPEN',
    isDraft: false,
    mergeable: 'MERGEABLE',
    reviewDecision: null as string | null,
    closedAt: null,
    author: { login: 'human', __typename: 'User' },
    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
  };
  const requests: string[][] = [];
  let failed = false,
    partial = false;
  const read = createCodingLedgerReader(async (args, resource) => {
    requests.push(args);
    if (failed) return { ok: false, error: 'Unavailable', retryAfterMs: 1000 };
    return {
      ok: true,
      data:
        resource === 'core'
          ? args[2].includes('state=open')
            ? [pull]
            : []
          : {
              data: {
                rateLimit: { cost: 1, remaining, resetAt },
                repository: { nameWithOwner: 'synthetic/repo', p1: partial ? null : fact },
              },
            },
    };
  });
  return {
    pull,
    fact,
    requests,
    read,
    fail: () => {
      failed = true;
    },
    partial: () => {
      partial = true;
    },
  };
}

describe('coding ledger acquisition', () => {
  test('a known GraphQL cooldown defers before spending core list requests', async () => {
    const f = fixture(),
      calls: string[] = [];
    const read = createCodingLedgerReader(async (args, resource) => {
      calls.push(args[2]);
      if (args[2] === 'user')
        return { ok: true, data: { id: 1, url: 'https://api.github.com/users/actor' } };
      if (resource === 'core')
        return { ok: true, data: args[2].includes('state=open') ? [f.pull] : [] };
      return {
        ok: false,
        error: 'API rate limit exceeded',
        retryAfterMs: 3600000,
        quota: {
          status: 403,
          resource: 'graphql',
          remaining: 0,
          resetAt: Date.now() + 3600000,
          retryAfterMs: null,
          requestId: 'graphql-refused',
        },
      };
    });
    await read('synthetic/repo');
    const before = calls.length;
    const held = (await read('synthetic/other')) as { quota?: { deferred?: boolean } };
    expect(held.quota?.deferred).toBe(true);
    expect(calls.length).toBe(before);
  });
  for (const change of ['checks', 'mergeability', 'review'] as const) {
    test(`observes same-head ${change} changes by the next sweep without updated_at`, async () => {
      const clock = Date.now,
        start = clock(),
        f = fixture();
      Date.now = () => start;
      try {
        await f.read('synthetic/repo');
        if (change === 'checks') f.fact.commits.nodes[0].commit.statusCheckRollup.state = 'FAILURE';
        if (change === 'mergeability') f.fact.mergeable = 'CONFLICTING';
        if (change === 'review') f.fact.reviewDecision = 'CHANGES_REQUESTED';
        Date.now = () => start + 299_999;
        const cached = planCodingLedgerRead(await f.read('synthetic/repo'), Date.now());
        expect(cached?.rows[0].state).toBe('waiting_human');
        expect(f.requests.filter((args) => args[2] === 'graphql')).toHaveLength(1);
        Date.now = () => start + 300_000;
        const refreshed = planCodingLedgerRead(await f.read('synthetic/repo'), Date.now());
        expect(refreshed?.rows[0].state).toBe(
          { checks: 'failing', mergeability: 'dirty', review: 'changes_requested' }[change]
        );
      } finally {
        Date.now = clock;
      }
    });
  }
  test('expired quota evidence cannot keep cached facts in an old cooldown', async () => {
    const clock = Date.now,
      start = clock();
    const f = fixture(400, new Date(start + 1000).toISOString());
    await f.read('synthetic/repo');
    Date.now = () => start + 2000;
    try {
      expect(
        planCodingLedgerRead(await f.read('synthetic/repo'), Date.now())?.remaining
      ).toBeNull();
    } finally {
      Date.now = clock;
    }
  });
  test('retains unchanged head facts but refreshes same-head reviews after REST changes', async () => {
    const f = fixture();
    const before = planCodingLedgerRead(await f.read('synthetic/repo'), Date.now());
    expect(before?.rows[0]).toMatchObject({
      title: 'Visible title',
      head: 'head',
      authorIsBot: false,
    });
    await f.read('synthetic/repo');
    expect(f.requests.filter((args) => args[2] === 'graphql')).toHaveLength(1);
    f.pull.updated_at = 'changed';
    f.fact.title = 'Edited title';
    f.fact.reviewDecision = 'CHANGES_REQUESTED';
    const after = planCodingLedgerRead(await f.read('synthetic/repo'), Date.now());
    expect(after?.rows[0].title).toBe('Edited title');
    expect(after?.rows[0].state).toBe('changes_requested');
    expect(f.requests.filter((args) => args[2] === 'graphql')).toHaveLength(2);
  });
  test('pending checks are refreshed even without updated_at changing', async () => {
    const f = fixture();
    f.fact.commits.nodes[0].commit.statusCheckRollup.state = 'PENDING';
    await f.read('synthetic/repo');
    f.fact.commits.nodes[0].commit.statusCheckRollup.state = 'SUCCESS';
    const after = planCodingLedgerRead(await f.read('synthetic/repo'), Date.now());
    expect(after?.rows[0].ci).toBe('SUCCESS');
    expect(f.requests.filter((args) => args[2] === 'graphql')).toHaveLength(2);
  });
  test('a new head cannot reuse approval facts from the previous head', async () => {
    const f = fixture();
    f.fact.reviewDecision = 'APPROVED';
    await f.read('synthetic/repo');
    f.pull.head.sha = 'new';
    expect(planCodingLedgerRead(await f.read('synthetic/repo'), Date.now())).toBeNull();
    f.fact.headRefOid = 'new';
    f.fact.reviewDecision = null;
    expect(planCodingLedgerRead(await f.read('synthetic/repo'), Date.now())?.rows[0].head).toBe(
      'new'
    );
  });
  test('transport failure cannot become a successful empty ledger', async () => {
    const f = fixture();
    await f.read('synthetic/repo');
    f.fail();
    const raw = await f.read('synthetic/repo');
    expect(raw).toMatchObject({ error: 'Unavailable' });
    expect(planCodingLedgerRead(raw, Date.now())).toBeNull();
  });
  test('partial hydration never advances the cache', async () => {
    const f = fixture();
    await f.read('synthetic/repo');
    f.partial();
    f.pull.updated_at = 'changed';
    expect(planCodingLedgerRead(await f.read('synthetic/repo'), Date.now())).toBeNull();
    expect(planCodingLedgerRead(await f.read('synthetic/repo'), Date.now())).toBeNull();
    expect(f.requests.filter((args) => args[2] === 'graphql')).toHaveLength(3);
  });
});
