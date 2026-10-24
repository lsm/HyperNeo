import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { CodingPrLedgerRepository } from '../../../../src/lib/neo/packs/coding/pr-ledger.ts';
import { CodingTodoPrRepository } from '../../../../src/lib/neo/packs/coding/todo-prs.ts';
import { CodingAssignmentsRepository } from '../../../../src/lib/neo/packs/coding/assignments.ts';
import { createCodingMergeOperation } from '../../../../src/lib/neo/packs/coding/merge-operation.ts';
import { runCodingReview } from '../../../../src/lib/neo/packs/coding/review.ts';
import { prepareCodingMerge } from '../../../../src/lib/neo/packs/coding/merge-gates.ts';
import { createOperationRegistry } from '../../../../src/lib/operations/registry.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';

const originalPath = process.env.PATH;
const cleanups: (() => void)[] = [];
afterEach(() => {
  process.env.PATH = originalPath;
  for (const cleanup of cleanups.splice(0)) cleanup();
});
const url = 'https://github.com/synthetic/merge/pull/7',
  head = 'a'.repeat(40);
const author = { adapter: 'fixture', id: 'author' },
  verifier = { adapter: 'fixture', id: 'verifier', daemon: 'verify-daemon' },
  reviewer = { adapter: 'claude-code', id: 'reviewer' };
const agent = (ref: typeof author) => ({
  kind: 'agent' as const,
  id: ref.id,
  harness: ref.adapter,
  model: 'claude-opus-5-5',
});
function fixture(bot = true) {
  const root = mkdtempSync(join(tmpdir(), 'coding-merge-op-'));
  const data = {
    pr: {
      url,
      body: 'Agent: GPT-6 via fixture',
      state: 'OPEN',
      headRefOid: head,
      isDraft: false,
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      author: { login: 'author' },
      changedFiles: 1,
      files: [{ path: 'src/change.ts' }],
      labels: [] as { name: string }[],
    },
    reviews: [
      [
        {
          state: 'APPROVED',
          commit_id: head,
          user: { login: 'fixture-bot', type: 'Bot' },
          html_url: `${url}#review-1`,
        },
      ],
    ],
    checks: [{ bucket: 'pass', name: 'Required', link: `${url}/checks` }],
    threads: { headOid: head, unresolvedThreadUrls: [] as string[] },
    finalHead: head,
    fail: '',
  };
  const publish = () => writeFileSync(join(root, 'data.json'), JSON.stringify(data));
  publish();
  writeFileSync(
    join(root, 'gh'),
    `#!${process.execPath}\nimport{readFileSync,appendFileSync}from'node:fs';const a=process.argv.slice(2),f=JSON.parse(readFileSync(${JSON.stringify(join(root, 'data.json'))},'utf8'));appendFileSync(${JSON.stringify(join(root, 'commands.jsonl'))},JSON.stringify(a)+'\\n');if(a.includes(f.fail))process.exit(1);if(a[0]==='pr'&&a[1]==='view')console.log(JSON.stringify(a.at(-1)==='headRefOid,state'?{...f.pr,headRefOid:f.finalHead}:f.pr));else if(a[0]==='pr'&&a[1]==='checks')console.log(JSON.stringify(f.checks));else if(a.includes('graphql'))console.log(JSON.stringify({data:{repository:{pullRequest:{url:f.pr.url,headRefOid:f.threads.headOid,reviewThreads:{nodes:f.threads.unresolvedThreadUrls.map(url=>({id:url,isResolved:false,comments:{nodes:[{url}]}})),pageInfo:{hasNextPage:false,endCursor:null}}}}}}));else if(a.some(v=>v.endsWith('/reviews')))console.log(JSON.stringify(f.reviews));else process.exit(1);`,
    { mode: 0o700 }
  );
  process.env.PATH = `${root}:${originalPath}`;
  const db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  createCodingPackTables(db);
  cleanups.push(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  db.exec(
    "INSERT INTO neo_asks(id,session_id,title,request,created_at,updated_at) VALUES('ask','fixture','Merge','Merge',1,1); INSERT INTO neo_todos(id,ask_id,position,title,done_when,state,created_at,updated_at) VALUES('todo','ask',1,'Merge','Deliver','doing',1,1)"
  );
  const ledger = new CodingPrLedgerRepository(db),
    todos = new CodingTodoPrRepository(db),
    assignments = new CodingAssignmentsRepository(db);
  new NeoTodoSessionRepository(db).bind('todo', author, 1);
  todos.claim('todo', [{ url, claim: 'named' }], 1);
  ledger.stageFacts.observeHead(url, head, 1);
  const setting = (key: string, value: unknown) =>
    db
      .prepare(
        "INSERT INTO neo_pack_preferences(pack,scope_kind,scope_key,key,value_json,set_by,set_at) VALUES('coding','repo','synthetic/merge',?,?,'fixture',1) ON CONFLICT(pack,scope_kind,scope_key,key) DO UPDATE SET value_json=excluded.value_json"
      )
      .run(key, JSON.stringify(value));
  setting('mergePolicy', bot ? 'review_bot' : 'ci_only');
  if (bot) setting('reviewBot', 'fixture-bot');
  const base = {
    url,
    head,
    acceptanceContract: 'artifact:contract',
    newDispatch: true as const,
    write: author,
  };
  expect(
    assignments.record('todo', 'review', {
      ...base,
      ...(bot ? { bot: 'fixture-bot' } : { ref: reviewer, actor: agent(reviewer) }),
    })
  ).toBe(true);
  expect(assignments.record('todo', 'qa', { ...base, ref: verifier, actor: agent(verifier) })).toBe(
    true
  );
  const stage = (kind: 'review' | 'qa', ref = kind === 'review' ? reviewer : verifier) =>
    ledger.stageFacts.record({
      url,
      head,
      stage: kind,
      ref,
      actor: agent(ref),
      verdict: 'pass',
      acceptanceContract: base.acceptanceContract,
      evidence: [`artifact:${kind}`],
    });
  const registry = createOperationRegistry([
    createCodingMergeOperation({
      db,
      ledger,
      todos,
      review: runCodingReview,
      prepareMerge: prepareCodingMerge,
    }),
  ]);
  const invoke = (input: unknown = { todoId: 'todo', url }, role: 'neo' | 'worker' = 'neo') =>
    invokeOperation(registry, 'neo.coding.merge.prepare', input, { source: 'mcp', role });
  const prepare = async () => {
    publish();
    const result = await invoke();
    expect(result.kind).toBe('completed');
    return result.kind === 'completed'
      ? (result.value as { accepted: boolean; head?: string; command?: string[]; reason?: string })
      : { accepted: false };
  };
  return {
    db,
    ledger,
    todos,
    assignments,
    data,
    publish,
    stage,
    prepare,
    invoke,
    setting,
    commands: () => readFileSync(join(root, 'commands.jsonl'), 'utf8'),
  };
}

describe('coding merge operation', () => {
  test('does not accept author assertions', async () => {
    const f = fixture();
    expect((await f.invoke({ todoId: 'todo', url, requiredCiGreen: true })).kind).not.toBe(
      'completed'
    );
  });
  test('requires Verify evidence then returns only a persisted pinned command', async () => {
    const f = fixture();
    expect((await f.prepare()).accepted).toBe(false);
    f.stage('qa');
    const result = await f.prepare();
    expect(result.accepted).toBe(true);
    expect(result.command).toEqual([
      'gh',
      'pr',
      'merge',
      url,
      '--squash',
      '--match-head-commit',
      head,
    ]);
    expect(f.todos.deliveryFacts.read('todo', url, head)?.gate.qa).toEqual(verifier);
    expect(f.db.prepare("SELECT state FROM neo_todos WHERE id='todo'").get()).toEqual({
      state: 'doing',
    });
    expect(f.commands()).not.toContain('"merge"');
  });
  test('reuses the assigned no-bot reviewer without starting another session', async () => {
    const f = fixture(false);
    f.stage('qa');
    expect((await f.prepare()).accepted).toBe(false);
    f.stage('review');
    expect((await f.prepare()).accepted).toBe(true);
    expect(f.todos.deliveryFacts.read('todo', url, head)?.gate.reviewer).toEqual(reviewer);
  });
  test('cannot inherit old-head assignments', async () => {
    const f = fixture();
    f.stage('qa');
    f.data.pr.headRefOid = 'b'.repeat(40);
    f.data.threads.headOid = f.data.pr.headRefOid;
    expect((await f.prepare()).accepted).toBe(false);
  });
  test('a latched failed Verify cannot be overwritten to open admission', async () => {
    const f = fixture();
    f.stage('qa');
    f.ledger.stageFacts.record({ ...f.ledger.stageFacts.read(url)[0], verdict: 'fail' });
    expect(f.stage('qa')).toBe(false);
    expect((await f.prepare()).accepted).toBe(false);
  });
  test.each(['pending', 'fail', 'cancel'])('required CI %s refuses admission', async (bucket) => {
    const f = fixture();
    f.stage('qa');
    f.data.checks[0].bucket = bucket;
    expect((await f.prepare()).accepted).toBe(false);
  });
  test.each(['checks', 'graphql', 'repos/synthetic/merge/pulls/7/reviews'])(
    'unreadable %s refuses admission',
    async (failure) => {
      const f = fixture();
      f.stage('qa');
      f.data.fail = failure;
      expect((await f.prepare()).accepted).toBe(false);
    }
  );
  test('historical null-user reviews cannot block a current bot approval or supply sign-off', async () => {
    const f = fixture();
    f.stage('qa');
    f.data.reviews.unshift([
      { ...f.data.reviews[0][0], user: null } as unknown as (typeof f.data.reviews)[number][number],
    ]);
    expect((await f.prepare()).accepted).toBe(true);
    f.setting('humanSignoff', ['src/**']);
    expect((await f.prepare()).accepted).toBe(false);
    f.data.reviews.push([{ ...f.data.reviews[1][0], user: { login: 'human', type: 'User' } }]);
    expect((await f.prepare()).accepted).toBe(true);
  });
  test('later bot changes requested overrides the approval', async () => {
    const f = fixture();
    f.stage('qa');
    f.data.reviews.push([{ ...f.data.reviews[0][0], state: 'CHANGES_REQUESTED' }]);
    expect((await f.prepare()).accepted).toBe(false);
  });
  test('another bot approval cannot substitute for the configured bot', async () => {
    const f = fixture();
    f.stage('qa');
    f.data.reviews[0][0].user.login = 'wrong-bot';
    expect((await f.prepare()).accepted).toBe(false);
  });
  test('unresolved findings or a mismatched findings head refuse', async () => {
    const f = fixture();
    f.stage('qa');
    f.data.threads.unresolvedThreadUrls = [`${url}#finding`];
    expect((await f.prepare()).accepted).toBe(false);
    f.data.threads.unresolvedThreadUrls = [];
    f.data.threads.headOid = 'b'.repeat(40);
    expect((await f.prepare()).accepted).toBe(false);
  });
  test.each(['DIRTY', 'BEHIND', 'UNKNOWN'])('merge status %s refuses', async (status) => {
    const f = fixture();
    f.stage('qa');
    f.data.pr.mergeStateStatus = status;
    expect((await f.prepare()).accepted).toBe(false);
  });
  test('head changes at the final reread refuse without storing a receipt', async () => {
    const f = fixture();
    f.stage('qa');
    f.data.finalHead = 'b'.repeat(40);
    expect((await f.prepare()).accepted).toBe(false);
    expect(f.todos.deliveryFacts.read('todo', url, head)).toBeNull();
  });
  test('live author and policy changes cannot reuse assigned actors', async () => {
    const f = fixture();
    f.stage('qa');
    f.setting('reviewBot', 'other-bot');
    expect((await f.prepare()).accepted).toBe(false);
    f.setting('reviewBot', 'fixture-bot');
    new NeoTodoSessionRepository(f.db).bind('todo', { ...author, daemon: 'other-daemon' }, 2);
    expect((await f.prepare()).accepted).toBe(false);
  });
  test('applicable paths require a current non-author human approval', async () => {
    const f = fixture();
    f.stage('qa');
    f.setting('humanSignoff', ['src/**']);
    expect((await f.prepare()).accepted).toBe(false);
    const human = {
      ...f.data.reviews[0][0],
      user: { login: 'human', type: 'User' },
      html_url: `${url}#human`,
    };
    f.data.reviews.push([human]);
    expect((await f.prepare()).accepted).toBe(true);
    expect(f.todos.deliveryFacts.read('todo', url, head)?.gate.evidence).toContain(human.html_url);
    f.data.reviews.push([{ ...human, state: 'DISMISSED' }]);
    expect((await f.prepare()).accepted).toBe(false);
  });
  test('label rules apply only to matching labels; truncated files stay closed', async () => {
    const f = fixture();
    f.stage('qa');
    f.setting('humanSignoff', ['label:security*']);
    expect((await f.prepare()).accepted).toBe(true);
    f.data.pr.labels.push({ name: 'security-review' });
    expect((await f.prepare()).accepted).toBe(false);
    f.data.pr.labels = [];
    f.data.pr.changedFiles = 101;
    expect((await f.prepare()).accepted).toBe(false);
  });
  test('a bot policy without a configured bot cannot fall back to a session', async () => {
    const f = fixture(false);
    f.stage('qa');
    f.stage('review');
    f.setting('mergePolicy', 'review_bot');
    expect((await f.prepare()).accepted).toBe(false);
  });
  test('human merge policy needs GitHub human approval alongside recorded Review', async () => {
    const f = fixture(false);
    f.stage('qa');
    f.stage('review');
    f.setting('mergePolicy', 'human');
    expect((await f.prepare()).accepted).toBe(false);
    f.data.reviews.push([{ ...f.data.reviews[0][0], user: { login: 'human', type: 'User' } }]);
    expect((await f.prepare()).accepted).toBe(true);
  });
});
