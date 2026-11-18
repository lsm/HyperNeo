import assert from 'node:assert/strict';
import { decideCodingDaemonMerge } from '../../../packages/daemon/src/lib/neo/packs/coding/daemon-merge-gates.ts';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createCodingPack } from '../../../packages/daemon/src/lib/neo/packs/coding/pack.ts';
import { CodingPrEventRepository } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-events.ts';
import { CodingPrLedgerRepository, reconcileCodingPrLedger } from '../../../packages/daemon/src/lib/neo/packs/coding/pr-ledger.ts';
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
  let botReview = 'APPROVED';
  let draft = false;
  let mergeable = 'MERGEABLE';
  let ci = 'SUCCESS';
  const pr = () => ({
    number: 1,
    title: 'Fix it',
    body: 'Fix it.\n\nAgent: claude-opus-5-5 (effort: medium) via Claude',
    headRefName: 'fix',
    headRefOid: head,
    state: 'OPEN',
    isDraft: draft,
    mergeable,
    reviewDecision: null,
    reviews: {
      nodes: [{ state: botReview, commit: { oid: head }, author: { login: 'synthetic-bot' } }],
    },
    closedAt: null,
    author: { login: 'someone', __typename: 'User' },
    commits: { nodes: [{ commit: { statusCheckRollup: { state: ci } } }] },
  });
  const told: { ref: unknown; key: string; text: string }[] = [];
  const delivered = new Set<string>();
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
        if (!delivered.has(key)) told.push({ ref, key, text });
        delivered.add(key);
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

  assert.equal(ledger.pollFacts.record(
    { credentialId: 'github-connector', url, accept: 'application/vnd.hyperneo.pr-review-threads+json', apiVersion: 'v1' },
    { value: { headOid: head, unresolvedThreadUrls: [`${url}#discussion_r1`] }, etag: null, next: null },
    t0, 0
  ), true);
  const before = await sweep('approved green with an unresolved thread', 0);
  assert.equal(before.state, 'changes_requested');
  assert.equal(before.owner, 'hyperneo:synthetic-author');
  draft = true;
  assert.equal((await sweep('draft with an unresolved thread', 1)).state, 'draft');
  draft = false;
  mergeable = 'CONFLICTING';
  assert.equal((await sweep('conflict with an unresolved thread', 2)).state, 'dirty');
  mergeable = 'MERGEABLE';
  ci = 'FAILURE';
  botReview = 'CHANGES_REQUESTED';
  told.length = 0;
  assert.equal((await sweep('failing CI with an unresolved thread', 3)).state, 'failing');
  assert(
    told.some((item) => item.text.includes('failing CI') && item.text.includes(`${url}#discussion_r1`))
  );
  told.length = 0;
  await sweep('failing CI reminder with an unresolved thread', 24);
  assert(
    told.some((item) => item.text.includes('failing CI') && item.text.includes(`${url}#discussion_r1`))
  );
  ci = 'SUCCESS';
  botReview = 'APPROVED';
  assert.equal((await sweep('ready except for thread', 25)).state, 'changes_requested');
  const reminder = await sweep('author reminder', 46);
  assert(told.some((item) => item.text.includes(`${url}#discussion_r1`)));
  const decision = decideCodingDaemonMerge({
    ok: true, head, state: 'OPEN', draft: false, mergeable: 'MERGEABLE',
    passingCommitStatus: false, requiredCi: { head, green: true, count: 1 },
    threads: { head, unresolved: 1 }, reviews: [{ head, login: 'synthetic-bot', state: 'APPROVED' }],
    files: [], labels: [],
  }, { mergeBy: 'daemon', mergePolicy: 'review_bot', reviewBot: 'synthetic-bot' });
  assert.deepEqual(decision, { kind: 'skip', reason: 'review_threads_unresolved_or_stale' });
  assert.equal(ledger.pollFacts.record(
    { credentialId: 'github-connector', url, accept: 'application/vnd.hyperneo.pr-review-threads+json', apiVersion: 'v1' },
    { value: { headOid: head, unresolvedThreadUrls: [] }, etag: null, next: null },
    t0 + 47 * MIN, 1
  ), true);
  const resolved = await sweep('thread resolved', 47);
  assert.equal(resolved.state, 'approved_green');
  db.prepare("UPDATE pack_coding_pr_ledger SET state = 'changes_requested' WHERE repo = ?").run(repo);
  head = 'b'.repeat(40);
  const read = (remaining: number) => async () => ({
    data: { rateLimit: { remaining }, repository: { nameWithOwner: repo,
      open: { pageInfo: { hasNextPage: false }, nodes: [pr()] }, done: { nodes: [] } } },
  });
  let refreshes = 0;
  const failedRefresh = async () => { refreshes++; return { ok: false }; };
  await reconcileCodingPrLedger(ledger, [repo], read(4000), t0 + 48 * MIN, failedRefresh);
  assert.equal(refreshes, 1);
  assert.equal(ledger.list()[0].readAt, t0 + 48 * MIN);
  assert.equal(ledger.list()[0].state, 'changes_requested');
  assert.equal(ledger.health.read(repo)?.misses, 0);
  await reconcileCodingPrLedger(ledger, [repo], read(499), t0 + 49 * MIN, failedRefresh);
  assert.equal(refreshes, 1);
  assert.equal(ledger.list()[0].readAt, t0 + 49 * MIN);
  assert.equal(ledger.pollFacts.record(
    { credentialId: 'github-connector', url, accept: 'application/vnd.hyperneo.pr-review-threads+json', apiVersion: 'v1' },
    { value: { headOid: head, unresolvedThreadUrls: [`${url}#discussion_r2`] }, etag: null, next: null },
    t0 + 50 * MIN, 2
  ), true);
  db.prepare("INSERT INTO neo_pack_preferences VALUES ('coding', 'repo', ?, 'crossModelReview', 'true', 'human', 1)").run(repo);
  db.exec("DELETE FROM neo_todo_sessions; UPDATE pack_coding_pr_ledger SET owner = NULL");
  const cross = await sweep('unowned PR needs cross-model review', 51);
  assert.equal(cross.state, 'waiting_cross_review');
  const escalated = await sweep('cross-model review reminder', 71);
  assert(escalated.woken.some((text) => text.includes('different model')));
  for (const [newHead, newDraft, newMergeable, newCi, expected] of [
    ['d', true, 'MERGEABLE', 'SUCCESS', 'draft'],
    ['e', false, 'CONFLICTING', 'SUCCESS', 'dirty'],
    ['f', false, 'MERGEABLE', 'FAILURE', 'failing'],
  ] as const) {
    head = newHead.repeat(40);
    draft = newDraft;
    mergeable = newMergeable;
    ci = newCi;
    db.prepare("UPDATE pack_coding_pr_ledger SET state = 'changes_requested' WHERE repo = ?").run(repo);
    await reconcileCodingPrLedger(ledger, [repo], read(4000), t0 + 71 * MIN, failedRefresh);
    assert.equal(ledger.list()[0].state, expected);
  }
  draft = false;
  mergeable = 'MERGEABLE';
  ci = 'SUCCESS';
  const closed = async () => ({ data: { rateLimit: { remaining: 4000 }, repository: {
    nameWithOwner: repo, open: { pageInfo: { hasNextPage: false }, nodes: [] },
    done: { nodes: [{ ...pr(), state: 'CLOSED', closedAt: new Date(t0 + 72 * MIN).toISOString() }] },
  } } });
  await reconcileCodingPrLedger(ledger, [repo], closed, t0 + 72 * MIN);
  assert.equal(ledger.list()[0].state, 'closed');
  head = 'c'.repeat(40);
  await reconcileCodingPrLedger(ledger, [repo], read(4000), t0 + 73 * MIN, failedRefresh);
  const reopened = ledger.list()[0];
  assert.equal(reopened.state, 'waiting_cross_review');
  assert.equal(reopened.closedAt, null);
  db.prepare("UPDATE neo_pack_preferences SET value_json = 'false' WHERE key = 'crossModelReview'").run();
  db.prepare("INSERT INTO neo_todo_sessions (todo_id, target, ref) VALUES ('author-todo', '{}', ?)").run(JSON.stringify(author));
  head = 'e'.repeat(40);
  ci = 'FAILURE';
  botReview = 'APPROVED';
  told.length = 0;
  await sweep('CI fails before review', 74);
  assert(told.some((item) => item.text.includes('failing CI')));
  told.length = 0;
  botReview = 'CHANGES_REQUESTED';
  assert.equal(ledger.pollFacts.record(
    { credentialId: 'github-connector', url, accept: 'application/vnd.hyperneo.pr-review-threads+json', apiVersion: 'v1' },
    { value: { headOid: head, unresolvedThreadUrls: [`${url}#discussion_r3`] }, etag: null, next: null },
    t0 + 75 * MIN, 3
  ), true);
  await sweep('review arrives after CI', 75);
  assert.equal(told.filter((item) => item.text.includes('failing CI') && item.text.includes(`${url}#discussion_r3`)).length, 1);
  await sweep('unchanged review', 76);
  assert.equal(told.filter((item) => item.text.includes('failing CI') && item.text.includes(`${url}#discussion_r3`)).length, 1);
  writeFileSync(join(run, 'evidence', 'unresolved-thread.json'), JSON.stringify({ before, reminder, resolved, decision, refreshes, cross, escalated, reopened, lateReview: told }, null, 2));
} finally {
  db.close();
}
