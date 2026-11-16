import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createCodingPack } from '../../../packages/daemon/src/lib/neo/packs/coding/pack.ts';
import { CodingPrEventRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-events.ts';
import { CodingPrLedgerRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-ledger.ts';
import { CodingPrSweepRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-sweep.ts';
import { createCodingPackTables } from '../../../packages/daemon/src/lib/neo/packs/coding/schema/coding-tables.ts';
import { CodingTodoPrRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/todo-prs.ts';
import { createTables, runMigrations } from '../../../packages/daemon/src/storage/schema/index.ts';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
for (const dir of ['data', 'evidence']) mkdirSync(join(run, dir), { recursive: true });
globalThis.fetch = (() => {
  throw new Error('External HTTP is disabled');
}) as typeof fetch;

const MIN = 60_000;
const repo = 'synthetic/app';
const url = `https://github.com/${repo}/pull/1`;
const author = { adapter: 'hyperneo', id: 'synthetic-author' };
const finding = 'P1 the retry loop never stops.';
const evidence: Record<string, unknown> = { steps: [] };
const db = new Database(join(run, 'data/daemon.db'));
try {
  runMigrations(db, () => {});
  createTables(db);
  createCodingPackTables(db);
  for (const [key, value] of Object.entries({
    mergePolicy: 'review_bot',
    reviewBot: 'synthetic-bot',
    crossModelReview: true,
  }))
    db.prepare(
      `INSERT INTO neo_pack_preferences VALUES ('coding', 'repo', ?, ?, ?, 'human', 1)`
    ).run(repo, key, JSON.stringify(value));
  db.exec(`INSERT INTO neo_asks (id, session_id, title, request, status, created_at, updated_at)
    VALUES ('ask', 'neo', 'A', 'R', 'open', 1, 1);
    INSERT INTO neo_todos (id, ask_id, position, title, done_when, state, started_at, created_at, updated_at)
    VALUES ('author-todo', 'ask', 0, 'Fix it', 'Merged', 'doing', 1, 1, 1)`);
  db.prepare("INSERT INTO neo_todo_sessions (todo_id, target, ref) VALUES ('author-todo', '{}', ?)").run(
    JSON.stringify(author)
  );
  db.prepare("UPDATE neo_todos SET check_json = ? WHERE id = 'author-todo'").run(
    JSON.stringify({ pack: 'coding', kind: 'pr_merged', params: { urls: [url] } })
  );

  let head = 'a'.repeat(40);
  const pr = () => ({
    number: 1,
    title: 'Fix it',
    body: 'Fix it.\n\nAgent: claude-opus-5-5 (effort: medium) via Claude',
    headRefName: 'fix',
    headRefOid: head,
    state: 'OPEN',
    isDraft: false,
    mergeable: 'MERGEABLE',
    reviewDecision: null,
    reviews: {
      nodes: [{ state: 'APPROVED', commit: { oid: head }, author: { login: 'synthetic-bot' } }],
    },
    closedAt: null,
    author: { login: 'someone', __typename: 'User' },
    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
  });
  const told: { ref: unknown; key: string; text: string }[] = [];
  const woken: string[] = [];
  const ledger = new CodingPrLedgerRepository(db);
  const pack = createCodingPack({
    database: () => db,
    readPrs: async () => [],
    todoPrs: new CodingTodoPrRepository(db),
    prLedger: ledger,
    prEvents: new CodingPrEventRepository(db),
    prSweep: new CodingPrSweepRepository(db),
    projectRepos: () => [repo],
    readLedgerRepo: async () => ({
      data: {
        rateLimit: { remaining: 4000 },
        repository: {
          nameWithOwner: repo,
          open: { pageInfo: { hasNextPage: false }, nodes: [pr()] },
          done: { nodes: [] },
        },
      },
    }),
    prSweepDeps: {
      tell: async (ref, key, text) => {
        told.push({ ref, key, text });
        return true;
      },
      wake: async (_key, text) => {
        woken.push(text);
        return true;
      },
    },
    attend: async (event) => {
      woken.push(String(event.facts.text));
      return true;
    },
  });
  const t0 = Date.now();
  const sweep = async (name: string, minutes: number) => {
    await pack.sweep!(t0 + minutes * MIN);
    const row = ledger.snapshot([repo], t0 + minutes * MIN)[0];
    const step = {
      name,
      minutes,
      head: head.slice(0, 7),
      state: row?.state,
      owner: row ? `${row.ownerAdapter}:${row.ownerId}` : null,
      told: told.map((item) => item.text),
      woken: [...woken],
    };
    (evidence.steps as unknown[]).push(step);
    return step;
  };

  const before = await sweep('approved, green, no cross-model review yet', 0);
  assert.equal(before.state, 'waiting_cross_review');
  assert.equal(before.told.length, 0);

  assert.equal(
    await ledger.write('recordStage', {
      url,
      head,
      stage: 'review',
      actor: { kind: 'agent', id: 'synthetic-reviewer', model: 'gpt-6.1-sol', harness: 'codex' },
      verdict: 'fail',
      acceptanceContract: 'Synthetic contract',
      evidence: [finding],
    }),
    true
  );
  const failed = await sweep('the cross-model review recorded fail on the head', 1);
  assert.equal(failed.state, 'changes_requested');
  assert.equal(failed.owner, 'hyperneo:synthetic-author');
  assert.equal(told.length, 1);
  assert.deepEqual(told[0].ref, author);
  assert.match(told[0].text, /has requested changes on head aaaaaaa\. Address the review and push\. Review findings: P1 the retry loop never stops\./);

  const reminded = await sweep('20 min later with no fix pushed', 21);
  assert.equal(reminded.state, 'changes_requested');
  assert.equal(told.length, 2);
  assert.deepEqual(told[1].ref, author);
  assert.match(told[1].text, /waiting on requested changes .* Review findings: P1 the retry loop never stops\./);
  assert(!woken.some((text) => text.includes('different model')), 'Neo is not asked for a second reviewer');

  head = 'b'.repeat(40);
  const pushed = await sweep('the author pushed a new head', 22);
  assert.equal(pushed.state, 'waiting_cross_review');
  evidence.passed = true;
  console.log('PASS: a failed cross-model review asks its author with the findings; a new head waits for review again');
} catch (error) {
  evidence.error = String(error);
  throw error;
} finally {
  writeFileSync(join(run, 'evidence/coding-cross-review-fail.json'), JSON.stringify(evidence, null, 2));
  db.close();
}
