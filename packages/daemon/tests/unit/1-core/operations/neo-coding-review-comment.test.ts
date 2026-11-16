import { describe, test, expect } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { CodingPrLedgerRepository } from '../../../../src/lib/neo/packs/coding/pr-ledger.ts';
import {
  createCodingReviewComments,
  readCodingOpenReviews,
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
  const outage = { on: false };
  const github = async (host: string, args: string[]) => {
    if (outage.on) throw new Error('gh lookup timed out');
    const path = args[0];
    if (args.includes('GET'))
      return [comments.filter((item) => item.path === path).map(({ body }) => ({ body }))];
    const body = args.find((arg) => arg.startsWith('body='));
    if (!body) throw new Error('unexpected GitHub call');
    comments.push({ host, path, body: body.slice('body='.length) });
    return {};
  };
  const sweep = (post = createCodingReviewComments(github)) =>
    post(() => readCodingOpenReviews(db, ledger));
  return { db, ledger, comments, outage, github, sweep };
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
  test('a PR merged while GitHub failed gets its comment on a later sweep', async () => {
    const { db, ledger, comments, outage, sweep, github } = setup();
    try {
      ledger.recordStage(fact);
      const post = createCodingReviewComments(github);
      outage.on = true;
      await sweep(post);
      db.prepare("UPDATE pack_coding_pr_ledger SET state = 'merged', closed_at = 5").run();
      outage.on = false;
      await sweep(post);
      expect(comments).toHaveLength(1);
    } finally {
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
});
