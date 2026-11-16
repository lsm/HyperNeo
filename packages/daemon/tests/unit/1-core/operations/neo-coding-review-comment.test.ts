import { describe, test, expect, jest } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { CodingPrLedgerRepository } from '../../../../src/lib/neo/packs/coding/pr-ledger.ts';
import { createCodingPack } from '../../../../src/lib/neo/packs/coding/pack.ts';
import { CodingPrEventRepository } from '../../../../src/lib/neo/packs/coding/pr-events.ts';
import { CodingPrSweepRepository } from '../../../../src/lib/neo/packs/coding/pr-sweep.ts';
import { CodingTodoPrRepository } from '../../../../src/lib/neo/packs/coding/todo-prs.ts';
import type { SpawnFn } from '../../../../src/lib/runtime-spawn/index.ts';
import {
  codingGithubApi,
  createCodingReviewComments,
  planCodingReviewComment,
  readCodingPostableReviews,
} from '../../../../src/lib/neo/packs/coding/review-comment.ts';
import type { CodingStageFact } from '../../../../src/lib/neo/packs/coding/stage-facts.ts';

const url = 'https://github.com/synthetic/review/pull/3';
const actor = {
  kind: 'agent',
  id: 'reviewer-session',
  harness: 'codex-desktop',
  model: 'gpt-6.1-sol',
} as const;
const fact: CodingStageFact = {
  url,
  head: 'head-a',
  stage: 'review',
  actor,
  ref: { adapter: 'codex-desktop', id: 'reviewer-session' },
  verdict: 'pass',
  acceptanceContract: 'artifact:contract',
  evidence: ['artifact:proof'],
};

function setup(ledgerHead = 'head-a', closedAt: number | null = null, state = 'waiting_review') {
  const db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  createCodingPackTables(db);
  const ledger = new CodingPrLedgerRepository(db);
  ledger.stageFacts.observeHead(url, 'head-a', 1);
  db.prepare(
    `INSERT INTO pack_coding_pr_ledger (repo, number, title, branch, head, state, state_since, closed_at, read_at)
     VALUES ('synthetic/review', 3, 'Synthetic', 'branch', ?, ?, 1, ?, 1)`
  ).run(ledgerHead, state, closedAt);
  const comments: { host: string; path: string; body: string }[] = [];
  const outage: { on: boolean; error?: Error } = { on: false };
  const calls: string[][] = [];
  const github = async (host: string, args: string[]) => {
    calls.push(args);
    if (outage.on) throw outage.error ?? new Error('gh lookup timed out');
    const path = args[0];
    if (args.includes('GET'))
      return comments.filter((item) => item.path === path).map(({ body }) => ({ body }));
    const body = args.find((arg) => arg.startsWith('body='));
    if (!body) throw new Error('unexpected GitHub call');
    comments.push({ host, path, body: body.slice('body='.length) });
    return {};
  };
  const sweep = (post = createCodingReviewComments(github)) =>
    post(
      () => readCodingPostableReviews(db, ledger, 1),
      (fact, marker) => ledger.write('recordPostedReview', fact.url, marker),
      (host, until) => ledger.write('recordReviewCommentHold', host, until)
    );
  return { db, ledger, comments, outage, calls, github, sweep };
}

describe('createCodingReviewComments', () => {
  test.each(['pass', 'fail'] as const)(
    'a recorded %s Review posts one labelled PR comment and the next sweep posts nothing',
    async (verdict) => {
      const { db, ledger, comments, sweep, github } = setup();
      try {
        expect(ledger.recordStage({ ...fact, verdict })).toBe(true);
        const restarted = createCodingReviewComments(github);
        await sweep();
        await sweep();
        await sweep(restarted);
        expect(comments).toHaveLength(1);
        expect(comments[0].host).toBe('github.com');
        expect(comments[0].path).toBe('repos/synthetic/review/issues/3/comments');
        const lines = comments[0].body.split('\n');
        expect(lines[0]).toBe(`**HyperNeo recorded review: ${verdict.toUpperCase()}**`);
        expect(lines).toContain('- Reviewer: `gpt-6.1-sol` via codex-desktop');
        expect(lines).toContain(`- Verdict: ${verdict}`);
        expect(lines).toContain('- Head: `head-a`');
        expect(comments[0].body).not.toContain('reviewer-session');
      } finally {
        db.close();
      }
    }
  );
  test('a later sweep posts the comment a GitHub outage missed', async () => {
    const { db, ledger, comments, outage, sweep, github } = setup();
    try {
      ledger.recordStage(fact);
      const post = createCodingReviewComments(github);
      outage.on = true;
      await sweep(post);
      expect(comments).toEqual([]);
      outage.on = false;
      await sweep(post);
      await sweep(post);
      expect(comments).toHaveLength(1);
    } finally {
      db.close();
    }
  });
  test('a restarted daemon with the same review record makes no GitHub calls', async () => {
    const { db, ledger, comments, calls, sweep, github } = setup();
    try {
      ledger.recordStage(fact);
      await sweep(createCodingReviewComments(github));
      expect(comments).toHaveLength(1);
      calls.length = 0;
      await sweep(createCodingReviewComments(github));
      await sweep(createCodingReviewComments(github));
      expect(calls).toEqual([]);
    } finally {
      db.close();
    }
  });
  test('a merged PR makes no GitHub calls', async () => {
    const { db, ledger, comments, calls, sweep, github } = setup('head-a', 5, 'merged');
    try {
      ledger.recordStage(fact);
      await sweep(createCodingReviewComments(github));
      expect(calls).toEqual([]);
      expect(comments).toEqual([]);
    } finally {
      db.close();
    }
  });
  test('a rate-limit error stops GitHub calls until the reset time', async () => {
    const { db, ledger, comments, outage, calls, sweep, github } = setup();
    const second = 'https://github.com/synthetic/review/pull/4';
    const start = Date.parse('2026-11-16T12:00:00Z');
    try {
      jest.setSystemTime(start);
      db.prepare(
        `INSERT INTO pack_coding_pr_ledger (repo, number, title, branch, head, state, state_since, closed_at, read_at)
         VALUES ('synthetic/review', 4, 'Synthetic', 'branch-4', 'head-a', 'waiting_review', 1, NULL, 1)`
      ).run();
      ledger.stageFacts.observeHead(second, 'head-a', 1);
      ledger.recordStage(fact);
      ledger.recordStage({ ...fact, url: second });
      const post = createCodingReviewComments(github);
      outage.on = true;
      outage.error = Object.assign(
        new Error('gh: API rate limit exceeded for user ID 1 (HTTP 403)'),
        {
          rateLimited: true,
          retryAfterMs: 10 * 60_000,
        }
      );
      await sweep(post);
      expect(calls).toHaveLength(1);
      outage.on = false;
      jest.setSystemTime(start + 9 * 60_000);
      await sweep(post);
      expect(calls).toHaveLength(1);
      jest.setSystemTime(start + 11 * 60_000);
      await sweep(post);
      expect(comments.map((item) => item.path)).toEqual([
        'repos/synthetic/review/issues/3/comments',
        'repos/synthetic/review/issues/4/comments',
      ]);
    } finally {
      jest.useRealTimers();
      db.close();
    }
  });
  test.each([
    ['a closed PR', 'head-a', 5],
    ['a PR whose head moved on', 'head-b', null],
  ] as const)('%s gets no comment', async (_label, head, closedAt) => {
    const { db, ledger, comments, sweep, github } = setup(
      head,
      closedAt,
      closedAt ? 'closed' : 'waiting_review'
    );
    try {
      ledger.recordStage(fact);
      await sweep(createCodingReviewComments(github));
      expect(comments).toEqual([]);
    } finally {
      db.close();
    }
  });
  test('overlapping sweeps post one comment', async () => {
    const { db, ledger, comments, sweep, github } = setup();
    try {
      ledger.recordStage(fact);
      const post = createCodingReviewComments(github);
      await Promise.all([sweep(post), sweep(post), sweep(post)]);
      expect(comments).toHaveLength(1);
    } finally {
      db.close();
    }
  });
  test('a verdict that returns at one head is posted again as the newest comment', async () => {
    const { db, ledger, comments, sweep, github } = setup();
    try {
      const post = createCodingReviewComments(github);
      for (const verdict of ['pass', 'inconclusive', 'pass', 'pass'] as const) {
        expect(ledger.recordStage({ ...fact, verdict })).toBe(true);
        await sweep(post);
      }
      expect(comments.map((item) => item.body.split('\n')[0])).toEqual([
        '**HyperNeo recorded review: PASS**',
        '**HyperNeo recorded review: INCONCLUSIVE**',
        '**HyperNeo recorded review: PASS**',
      ]);
    } finally {
      db.close();
    }
  });
  test('a failed read does not stop later sweeps', async () => {
    const { db, ledger, comments, sweep, github } = setup();
    try {
      ledger.recordStage(fact);
      const post = createCodingReviewComments(github);
      await expect(
        post(
          () => Promise.reject(new Error('gateway busy')),
          async () => {},
          async () => {}
        )
      ).resolves.toBeUndefined();
      await sweep(post);
      expect(comments).toHaveLength(1);
    } finally {
      db.close();
    }
  });
  test('a GitHub Enterprise host reads facts and posts on that host', async () => {
    const host = process.env.GH_HOST;
    process.env.GH_HOST = 'git.example.com';
    const enterprise = 'https://git.example.com/synthetic/review/pull/3';
    const { db, ledger, comments, sweep, github } = setup();
    try {
      ledger.stageFacts.observeHead(enterprise, 'head-a', 1);
      ledger.recordStage({ ...fact, url: enterprise });
      await sweep(createCodingReviewComments(github));
      expect(comments.map((item) => item.host)).toEqual(['git.example.com']);
    } finally {
      if (host === undefined) delete process.env.GH_HOST;
      else process.env.GH_HOST = host;
      db.close();
    }
  });
  test('a verdict replaced before any sweep posts only the stored verdict', async () => {
    const { db, ledger, comments, outage, sweep, github } = setup();
    try {
      const post = createCodingReviewComments(github);
      ledger.recordStage(fact);
      outage.on = true;
      await sweep(post);
      ledger.recordStage({ ...fact, verdict: 'fail' });
      outage.on = false;
      await sweep(post);
      await sweep(post);
      expect(comments.map((item) => item.body.split('\n')[0])).toEqual([
        '**HyperNeo recorded review: FAIL**',
      ]);
    } finally {
      db.close();
    }
  });
});

describe('coding pack review comments', () => {
  const ledgerNode = (state: 'OPEN' | 'MERGED') => ({
    number: 3,
    title: 'Synthetic',
    body: '',
    headRefName: 'branch',
    headRefOid: 'head-a',
    state,
    isDraft: true,
    mergeable: 'MERGEABLE',
    reviewDecision: null,
    closedAt: state === 'MERGED' ? new Date(Date.now() - 1000).toISOString() : null,
    createdAt: null,
  });
  const packWith = (read: () => Promise<unknown>) => {
    const { db, ledger, comments, calls, github } = setup();
    ledger.recordStage(fact);
    const pack = createCodingPack({
      database: () => db,
      readPrs: async () => [],
      todoPrs: new CodingTodoPrRepository(db),
      prLedger: ledger,
      prSweep: new CodingPrSweepRepository(db),
      prEvents: new CodingPrEventRepository(db),
      prSweepDeps: {
        human: async () => false,
        tell: async () => false,
        wake: async () => false,
      },
      attend: async () => false,
      projectRepos: () => ['synthetic/review'],
      readLedgerRepo: read,
      postReviewComments: createCodingReviewComments(github),
    });
    return { db, comments, calls, pack };
  };
  const response = (state: 'OPEN' | 'MERGED') => ({
    data: {
      rateLimit: { remaining: 5000 },
      repository: {
        nameWithOwner: 'synthetic/review',
        open: {
          pageInfo: { hasNextPage: false },
          nodes: state === 'OPEN' ? [ledgerNode(state)] : [],
        },
        done: { nodes: state === 'MERGED' ? [ledgerNode(state)] : [] },
      },
    },
  });
  test('a PR that merged while the daemon was offline gets no comment on the next sweep', async () => {
    const { db, comments, calls, pack } = packWith(async () => response('MERGED'));
    try {
      await pack.sweep!(Date.now());
      expect(calls).toEqual([]);
      expect(comments).toEqual([]);
    } finally {
      db.close();
    }
  });
  test('a sweep whose ledger read fails posts nothing', async () => {
    const { db, comments, calls, pack } = packWith(async () => ({ error: 'ledger unavailable' }));
    try {
      await pack.sweep!(Date.now());
      expect(calls).toEqual([]);
      expect(comments).toEqual([]);
    } finally {
      db.close();
    }
  });
  test('a PR the ledger confirms open is commented once', async () => {
    const { db, comments, pack } = packWith(async () => response('OPEN'));
    try {
      await pack.sweep!(Date.now());
      expect(comments).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});

describe('codingGithubApi rate limits', () => {
  const start = Date.parse('2026-11-16T12:00:00Z');
  const reply = (stdout: string, code: number, stderr = '') =>
    ({
      stdout: new Response(stdout).body,
      stderr: new Response(stderr).body,
      exited: Promise.resolve(code),
      exitCode: code,
      kill() {},
    }) as unknown as ReturnType<SpawnFn>;
  const sweepWith = (respond: (args: string[]) => ReturnType<SpawnFn>, prUrl = url) => {
    const { db, ledger, comments } = setup();
    const calls: string[][] = [];
    const spawn: SpawnFn = (args) => {
      calls.push([...args]);
      return respond([...args]);
    };
    ledger.stageFacts.observeHead(prUrl, 'head-a', 1);
    ledger.recordStage({ ...fact, url: prUrl });
    const make = () =>
      createCodingReviewComments((host, args, timeoutMs) =>
        codingGithubApi(host, args, timeoutMs, spawn)
      );
    let post = make();
    const sweep = () =>
      post(
        () => readCodingPostableReviews(db, ledger, 1),
        (posted, marker) => ledger.write('recordPostedReview', posted.url, marker),
        (host, until) => ledger.write('recordReviewCommentHold', host, until)
      );
    const restart = () => {
      post = make();
    };
    return { db, ledger, comments, calls, sweep, restart };
  };
  const secondPr = (db: Database, ledger: CodingPrLedgerRepository) => {
    const second = 'https://github.com/synthetic/review/pull/4';
    db.prepare(
      `INSERT INTO pack_coding_pr_ledger (repo, number, title, branch, head, state, state_since, closed_at, read_at)
       VALUES ('synthetic/review', 4, 'Synthetic', 'branch-4', 'head-a', 'waiting_review', 1, NULL, 1)`
    ).run();
    ledger.stageFacts.observeHead(second, 'head-a', 1);
    ledger.recordStage({ ...fact, url: second });
  };
  test('a restart during a Retry-After hold makes no comment calls until the reset', async () => {
    const { db, calls, sweep, restart } = sweepWith((args) =>
      args.includes('POST')
        ? reply(
            'HTTP/2.0 403 Forbidden\r\nRetry-After: 120\r\nContent-Type: application/json\r\n\r\n{"message":"Forbidden"}',
            1,
            'gh: Forbidden (HTTP 403)'
          )
        : reply(JSON.stringify([]), 0)
    );
    try {
      jest.setSystemTime(start);
      await sweep();
      expect(calls.some((args) => args.includes('POST'))).toBe(true);
      const tried = calls.length;
      jest.setSystemTime(start + 30_000);
      restart();
      await sweep();
      expect(calls).toHaveLength(tried);
      jest.setSystemTime(start + 121_000);
      await sweep();
      expect(calls.length).toBeGreaterThan(tried);
    } finally {
      jest.useRealTimers();
      db.close();
    }
  });
  test.each([
    [
      'a 403 with an exhausted quota and a reset header',
      (reset: number) =>
        `HTTP/2.0 403 Forbidden\r\nX-RateLimit-Remaining: 0\r\nX-RateLimit-Reset: ${reset}\r\nContent-Type: application/json\r\n\r\n{"message":"Forbidden"}`,
      120_000,
    ],
    [
      'a 429 with no rate-limit wording',
      () =>
        'HTTP/2.0 429 Too Many Requests\r\nContent-Type: application/json\r\n\r\n{"message":"slow down"}',
      60_000,
    ],
  ] as const)('%s stops the pass and holds until the reset', async (_label, headers, holdMs) => {
    const reset = Math.floor(start / 1000) + 120;
    const { db, ledger, calls, sweep } = sweepWith((args) =>
      args.includes('--include')
        ? reply(headers(reset), 1, 'gh: request failed')
        : reply('', 1, 'gh: request failed')
    );
    try {
      secondPr(db, ledger);
      jest.setSystemTime(start);
      await sweep();
      expect(calls).toHaveLength(1);
      jest.setSystemTime(start + holdMs - 5_000);
      await sweep();
      expect(calls).toHaveLength(1);
      jest.setSystemTime(start + holdMs + 1_000);
      await sweep();
      expect(calls.length).toBeGreaterThan(1);
    } finally {
      jest.useRealTimers();
      db.close();
    }
  });
  test('an exhausted quota holds until its reset even when Retry-After is shorter, across a restart', async () => {
    const reset = Math.floor(start / 1000) + 2_400;
    const { db, ledger, calls, sweep, restart } = sweepWith((args) =>
      args.includes('--include')
        ? reply(
            `HTTP/2.0 403 Forbidden\r\nRetry-After: 60\r\nX-RateLimit-Remaining: 0\r\nX-RateLimit-Reset: ${reset}\r\nContent-Type: application/json\r\n\r\n{"message":"Forbidden"}`,
            1,
            'gh: request failed'
          )
        : reply('', 1, 'gh: request failed')
    );
    try {
      secondPr(db, ledger);
      jest.setSystemTime(start);
      await sweep();
      expect(calls).toHaveLength(1);
      jest.setSystemTime(start + 61_000);
      await sweep();
      expect(calls).toHaveLength(1);
      jest.setSystemTime(start + 1_200_000);
      restart();
      await sweep();
      expect(calls).toHaveLength(1);
      jest.setSystemTime(start + 2_401_000);
      await sweep();
      expect(calls.length).toBeGreaterThan(1);
    } finally {
      jest.useRealTimers();
      db.close();
    }
  });
  test('a comment scan that runs past one minute stops and posts nothing', async () => {
    const { db, ledger, calls, sweep } = sweepWith((args) => {
      if (args.includes('POST')) return reply('{}', 0);
      const page = Number(args.find((arg) => arg.startsWith('page='))?.slice(5));
      jest.setSystemTime(Date.now() + 25_000);
      return reply(
        JSON.stringify(page <= 10 ? Array.from({ length: 100 }, () => ({ body: 'chatter' })) : []),
        0
      );
    });
    try {
      jest.setSystemTime(start);
      await sweep();
      expect(calls.length).toBeLessThanOrEqual(3);
      expect(calls.some((args) => args.includes('POST'))).toBe(false);
      expect(await readCodingPostableReviews(db, ledger, 1)).toHaveLength(1);
    } finally {
      jest.useRealTimers();
      db.close();
    }
  });
  test('a marker on the second page of comments is found and nothing is posted', async () => {
    let marker = '';
    const { db, ledger, calls, sweep } = sweepWith((args) =>
      args.includes('page=1')
        ? reply(JSON.stringify(Array.from({ length: 100 }, () => ({ body: 'chatter' }))), 0)
        : args.includes('page=2')
          ? reply(JSON.stringify([{ body: marker }]), 0)
          : reply('', 1, 'gh: unexpected call')
    );
    try {
      const [stored] = await readCodingPostableReviews(db, ledger, 1);
      marker = planCodingReviewComment(stored).marker;
      await sweep();
      expect(calls.map((args) => args.find((arg) => arg.startsWith('page=')))).toEqual([
        'page=1',
        'page=2',
      ]);
    } finally {
      db.close();
    }
  });
  test('a comment-list 403 marked only by Retry-After stops the pass and holds until then', async () => {
    const forbidden = (args: string[]) =>
      args.includes('--include')
        ? reply(
            'HTTP/2.0 403 Forbidden\r\nRetry-After: 120\r\nContent-Type: application/json\r\n\r\n{"message":"Forbidden"}',
            1,
            'gh: Forbidden (HTTP 403)'
          )
        : reply('', 1, 'gh: Forbidden (HTTP 403)');
    const { db, ledger, calls, sweep } = sweepWith(forbidden);
    const second = 'https://github.com/synthetic/review/pull/4';
    try {
      db.prepare(
        `INSERT INTO pack_coding_pr_ledger (repo, number, title, branch, head, state, state_since, closed_at, read_at)
         VALUES ('synthetic/review', 4, 'Synthetic', 'branch-4', 'head-a', 'waiting_review', 1, NULL, 1)`
      ).run();
      ledger.stageFacts.observeHead(second, 'head-a', 1);
      ledger.recordStage({ ...fact, url: second });
      jest.setSystemTime(start);
      await sweep();
      expect(calls).toHaveLength(1);
      jest.setSystemTime(start + 60_000);
      await sweep();
      expect(calls).toHaveLength(1);
      jest.setSystemTime(start + 121_000);
      await sweep();
      expect(calls.length).toBeGreaterThan(1);
    } finally {
      jest.useRealTimers();
      db.close();
    }
  });
  test('a 403 whose only rate-limit sign is Retry-After holds the poster until then', async () => {
    const { db, calls, sweep } = sweepWith((args) =>
      args.includes('POST')
        ? reply(
            'HTTP/2.0 403 Forbidden\r\nRetry-After: 120\r\nContent-Type: application/json\r\n\r\n{"message":"Forbidden"}',
            1,
            'gh: Forbidden (HTTP 403)'
          )
        : reply(JSON.stringify([]), 0)
    );
    try {
      jest.setSystemTime(start);
      await sweep();
      const tried = calls.length;
      expect(calls.some((args) => args.includes('POST'))).toBe(true);
      jest.setSystemTime(start + 60_000);
      await sweep();
      expect(calls).toHaveLength(tried);
      jest.setSystemTime(start + 121_000);
      await sweep();
      expect(calls.length).toBeGreaterThan(tried);
    } finally {
      jest.useRealTimers();
      db.close();
    }
  });
  test('a core rate limit holds until the core reset on the PR host', async () => {
    const host = process.env.GH_HOST;
    process.env.GH_HOST = 'git.example.com';
    const coreReset = Math.floor(start / 1000) + 3600;
    const { db, calls, sweep } = sweepWith(
      (args) =>
        args.includes('/rate_limit')
          ? reply(
              JSON.stringify({
                resources: {
                  core: { remaining: 0, reset: coreReset },
                  graphql: { remaining: 0, reset: Math.floor(start / 1000) + 60 },
                },
              }),
              0
            )
          : reply('', 1, 'gh: API rate limit exceeded for user ID 1. (HTTP 403)'),
      'https://git.example.com/synthetic/review/pull/3'
    );
    try {
      jest.setSystemTime(start);
      await sweep();
      const limit = calls.find((args) => args.includes('/rate_limit'));
      expect(limit).toContain('--hostname');
      expect(limit?.[limit.indexOf('--hostname') + 1]).toBe('git.example.com');
      const tried = calls.length;
      jest.setSystemTime(start + 10 * 60_000);
      await sweep();
      expect(calls).toHaveLength(tried);
      jest.setSystemTime(coreReset * 1000 + 1000);
      await sweep();
      expect(calls.length).toBeGreaterThan(tried);
    } finally {
      jest.useRealTimers();
      if (host === undefined) delete process.env.GH_HOST;
      else process.env.GH_HOST = host;
      db.close();
    }
  });
});
