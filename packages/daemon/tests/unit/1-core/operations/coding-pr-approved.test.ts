import { expect, test } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { createNeoQuestionOperations } from '../../../../src/lib/neo/question-operations.ts';
import {
  CodingTodoPrRepository,
  createCodingTodoPack,
} from '../../../../src/lib/neo/packs/coding/todo-prs.ts';

const url = 'https://github.com/synthetic/project/pull/78';
const check = { pack: 'coding', kind: 'pr_approved', params: { url } };
function fixture() {
  const db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  const store = new NeoAskTodoRepository(db);
  store.openAsk({
    id: 'ask',
    sessionId: 'neo',
    projectId: null,
    originMessageId: null,
    title: 'Approval facts',
    request: 'Wait for approval',
    createdAt: 1,
  });
  const repository = new CodingTodoPrRepository(db);
  const pack = createCodingTodoPack(repository, async () => []);
  pack.schema(db);
  const packs = () => [{ id: 'coding', describe: 'Coding', instructions: () => null, todos: pack }];
  const operation = createNeoQuestionOperations(
    store,
    async () => {},
    async () => ({ ok: true }),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    packs
  ).find((operation) => operation.name === 'neo.question.ask')!;
  return { db, store, repository, pack, operation };
}

test('a question can wait for a PR approval without a linked todo', async () => {
  const f = fixture();
  try {
    const receipt = (await f.operation.execute(
      f.operation.inputSchema.parse({
        askId: 'ask',
        kind: 'reply',
        text: 'There is no review app',
        retireWhen: check,
      }),
      { source: 'mcp', role: 'neo', sessionId: 'neo' }
    )) as { ok: boolean; question?: { id: string } };
    expect(receipt.ok).toBe(true);
    expect(f.store.getQuestion(receipt.question!.id)?.todoId).toBeUndefined();
    expect(f.store.getQuestion(receipt.question!.id)).toMatchObject({
      state: 'open',
      retireWhen: check,
    });
  } finally {
    f.db.close();
  }
});

import { checkCodingPrApproved } from '../../../../src/lib/neo/packs/coding/pr-approved.ts';
import type { LedgerQuotaRun } from '../../../../src/lib/neo/packs/coding/ledger-quota.ts';
import {
  CodingPrLedgerRepository,
  type CodingMergePolicy,
} from '../../../../src/lib/neo/packs/coding/pr-ledger.ts';

const headA = 'a'.repeat(40),
  headB = 'b'.repeat(40);
const review = (state = 'APPROVED', head = headA, by = 'review-bot[bot]') => ({
  state,
  commit_id: head,
  html_url: url + '#review',
  user: { login: by, type: 'Bot' },
});
function reader(
  policy: CodingMergePolicy = { mergePolicy: 'review_bot', reviewBot: 'review-bot' }
) {
  const state = {
    policy,
    head: headA,
    pages: [[review()]] as unknown,
    checks: [{ bucket: 'pass', name: 'Required', link: url + '/checks' }] as unknown,
    fail: '',
    malformedHead: false,
    duringDecision: () => {},
    throwRead: false,
  };
  const run: LedgerQuotaRun = async (args) => {
    if (state.throwRead) throw new Error('Synthetic read failed');
    if (state.fail && args.some((arg) => arg.includes(state.fail)))
      return { ok: false, error: 'Synthetic read failed' };
    if (args[2] === 'view')
      return {
        ok: true,
        data: state.malformedHead ? null : { headRefOid: state.head, state: 'OPEN' },
      };
    state.duringDecision();
    return { ok: true, data: args[2] === 'checks' ? state.checks : state.pages };
  };
  return { state, run, check: () => checkCodingPrApproved(url, () => state.policy, run) };
}

test('saved configured-bot approval passes and records its exact head', async () => {
  const f = fixture(),
    r = reader();
  try {
    const ledger = new CodingPrLedgerRepository(f.db);
    for (const [key, value] of Object.entries(r.state.policy))
      f.db
        .prepare(
          "INSERT INTO neo_pack_preferences VALUES ('coding','repo','Synthetic/Project',?,?, 'human',1)"
        )
        .run(key, JSON.stringify(value));
    expect(await checkCodingPrApproved(url, (repo) => ledger.policy(repo), r.run)).toMatchObject({
      done: true,
      evidence: expect.stringContaining(headA),
    });
  } finally {
    f.db.close();
  }
});

test.each(['human', undefined] as const)(
  'policy %s never passes automatically',
  async (mergePolicy) => {
    expect(await reader({ mergePolicy, reviewBot: 'review-bot' }).check()).toEqual({
      done: false,
      evidence: null,
    });
  }
);

test('a missing configured reviewer cannot use another approval', async () => {
  expect(await reader({ mergePolicy: 'review_bot' }).check()).toEqual({
    done: false,
    evidence: null,
  });
});

test.each(
  [
    [[review('APPROVED', headA, 'another-bot')]],
    [[review('APPROVED', headB)]],
    [[review(), review('CHANGES_REQUESTED')]],
    [[review(), review('DISMISSED')]],
    [[review(), review('COMMENTED')]],
    [[{ ...review(), user: null }]],
    [[]],
    [],
    null,
  ].map((pages) => ({ pages }))
)('only the configured bot’s latest review on the current head passes: %j', async ({ pages }) => {
  const r = reader();
  r.state.pages = pages;
  expect(await r.check()).toEqual({ done: false, evidence: null });
});

test('another author or an old-head review does not replace the matching head’s approval', async () => {
  const r = reader({ mergePolicy: 'review_bot', reviewBot: 'REVIEW-BOT[bot]' });
  r.state.pages = [
    [review()],
    [review('CHANGES_REQUESTED', headB), review('CHANGES_REQUESTED', headA, 'someone-else')],
  ];
  expect(await r.check()).toMatchObject({ done: true });
});

test('a new head clears approval until that head receives its own latest approval', async () => {
  const r = reader();
  expect(await r.check()).toMatchObject({ done: true });
  r.state.head = headB;
  expect(await r.check()).toEqual({ done: false, evidence: null });
  r.state.pages = [[review(), review('APPROVED', headB)]];
  expect(await r.check()).toMatchObject({ done: true, evidence: expect.stringContaining(headB) });
});

test('a push during the read leaves the check unmet', async () => {
  const r = reader();
  r.state.duringDecision = () => {
    r.state.head = headB;
  };
  expect(await r.check()).toEqual({ done: false, evidence: null });
});

test('changing the saved policy to human during the read leaves the check unmet', async () => {
  const r = reader();
  r.state.duringDecision = () => {
    r.state.policy.mergePolicy = 'human';
  };
  expect(await r.check()).toEqual({ done: false, evidence: null });
});

test('bot approval is independent of CI when the saved policy selects review_bot', async () => {
  const r = reader();
  r.state.fail = 'checks';
  expect(await r.check()).toMatchObject({ done: true });
});

test('ci_only passes on green required CI without consulting bot reviews', async () => {
  const r = reader({ mergePolicy: 'ci_only' });
  r.state.fail = '/reviews';
  expect(await r.check()).toMatchObject({
    done: true,
    evidence: expect.stringContaining('ci_only'),
  });
});

test.each(['pending', 'fail', 'skipping', 'cancel'])(
  'ci_only stays unmet for required CI bucket %s',
  async (bucket) => {
    const r = reader({ mergePolicy: 'ci_only' });
    r.state.checks = [{ bucket, name: 'Required', link: url }];
    expect(await r.check()).toEqual({ done: false, evidence: null });
  }
);

test.each([[], null, [{ bucket: 'pass' }]].map((checks) => ({ checks })))(
  'ci_only requires readable positive required-CI evidence: %j',
  async ({ checks }) => {
    const r = reader({ mergePolicy: 'ci_only' });
    r.state.checks = checks;
    expect(await r.check()).toEqual({ done: false, evidence: null });
  }
);

test.each(['view', '/reviews'])('read failure at %s is not approval', async (fail) => {
  const r = reader();
  r.state.fail = fail;
  expect(await r.check()).toEqual({ done: false, evidence: null });
});

test('a failed CI read is not green CI', async () => {
  const r = reader({ mergePolicy: 'ci_only' });
  r.state.fail = 'checks';
  expect(await r.check()).toEqual({ done: false, evidence: null });
});

test('malformed head or a thrown reader is not approval', async () => {
  const r = reader();
  r.state.malformedHead = true;
  expect(await r.check()).toEqual({ done: false, evidence: null });
  r.state.throwRead = true;
  expect(await r.check()).toEqual({ done: false, evidence: null });
});

test.each([
  {},
  { url: 78 },
  { url: 'https://github.com/synthetic/project/issues/78' },
  { url: 'https://unconfigured.invalid/synthetic/project/pull/78' },
  { url: 'https://github.com/synthetic/project/pull/0' },
])('malformed approval params refuse a card before opening it: %j', async (params) => {
  const f = fixture();
  try {
    const result = await f.operation.execute(
      f.operation.inputSchema.parse({
        askId: 'ask',
        kind: 'reply',
        text: 'Approval?',
        retireWhen: { ...check, params },
      }),
      { source: 'mcp', role: 'neo', sessionId: 'neo' }
    );
    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining('pr_approved_invalid_url:'),
    });
    expect(f.store.listQuestions('ask')).toEqual([]);
  } finally {
    f.db.close();
  }
});

test('the coding pack exposes the same approval outcome to checks and fact judgement', async () => {
  const f = fixture(),
    r = reader();
  try {
    const pack = createCodingTodoPack(f.repository, async () => [], undefined, undefined, r.check);
    const todo = f.store.addTodo(
      'todo',
      'ask',
      {
        title: 'Approval',
        check,
        instruction: null,
        named: null,
        doneWhen: pack.doneWhen!(check)!,
      },
      1
    );
    expect(await pack.check(todo, { readOnly: true, detached: true })).toMatchObject({
      done: true,
    });
    expect(pack.repository!(todo)).toBe('github.com/synthetic/project');
    const facts = await pack.readFacts(todo);
    expect(pack.judge(todo, facts)).toMatchObject({ state: 'done' });
  } finally {
    f.db.close();
  }
});

test('failure of the confirming head read is not approval', async () => {
  const r = reader();
  r.state.duringDecision = () => {
    r.state.fail = 'view';
  };
  expect(await r.check()).toEqual({ done: false, evidence: null });
});

test('a changed configured reviewer invalidates an in-flight approval', async () => {
  const r = reader();
  r.state.duringDecision = () => {
    r.state.policy.reviewBot = 'new-review-bot';
  };
  expect(await r.check()).toEqual({ done: false, evidence: null });
});
