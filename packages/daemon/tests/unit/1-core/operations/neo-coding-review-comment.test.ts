import { describe, test, expect, jest } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { CodingPrLedgerRepository } from '../../../../src/lib/neo/packs/coding/pr-ledger.ts';
import type { SpawnFn } from '../../../../src/lib/runtime-spawn/index.ts';
import {
  codingGithubApi,
  createCodingReviewComments,
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
      return [comments.filter((item) => item.path === path).map(({ body }) => ({ body }))];
    const body = args.find((arg) => arg.startsWith('body='));
    if (!body) throw new Error('unexpected GitHub call');
    comments.push({ host, path, body: body.slice('body='.length) });
    return {};
  };
  const sweep = (post = createCodingReviewComments(github)) =>
    post(
      () => readCodingPostableReviews(db, ledger),
      (fact, marker) => ledger.write('recordPostedReview', fact.url, marker)
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
    const post = createCodingReviewComments((host, args) => codingGithubApi(host, args, spawn));
    const sweep = () =>
      post(
        () => readCodingPostableReviews(db, ledger),
        (posted, marker) => ledger.write('recordPostedReview', posted.url, marker)
      );
    return { db, comments, calls, sweep };
  };
  test('a 403 whose only rate-limit sign is Retry-After holds the poster until then', async () => {
    const { db, calls, sweep } = sweepWith((args) =>
      args.includes('POST')
        ? reply(
            'HTTP/2.0 403 Forbidden\r\nRetry-After: 120\r\nContent-Type: application/json\r\n\r\n{"message":"Forbidden"}',
            1,
            'gh: Forbidden (HTTP 403)'
          )
        : reply(JSON.stringify([[]]), 0)
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
