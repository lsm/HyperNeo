import { prepareCodingMerge } from '../../../../src/lib/neo/packs/coding/merge-gates.ts';
import { describe, expect, test } from 'bun:test';
import { CodingStageFact } from '../../../../src/lib/neo/packs/coding/stage-facts.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import {
  CodingDeliveryFactsRepository,
  recordCodingSmoke,
  type CodingMergeGate,
  type CodingSmoke,
} from '../../../../src/lib/neo/packs/coding/delivery-facts.ts';
import type { NeoDeployRead } from '../../../../src/lib/neo/packs/coding/deploy-checks.ts';

const url = 'https://github.com/example/app/pull/7';
const gate: CodingMergeGate = {
  url,
  head: 'head-a',
  acceptanceContract: 'artifact:acceptance',
  write: { adapter: 'test', id: 'author' },
  reviewer: 'review-bot',
  qa: { adapter: 'test', id: 'qa' },
  evidence: ['artifact:qa', 'ci:7'],
};
const smoke: CodingSmoke = {
  actor: { kind: 'agent', id: 'qa', model: 'claude-opus-5-5', harness: 'test' },
  ref: { adapter: 'test', id: 'qa' },
  mergeCommit: 'merge-a',
  verdict: 'pass',
  evidence: ['artifact:smoke'],
  build: { daemon: 'target', commit: 'build-a' },
};
const deploys: NeoDeployRead = {
  prs: [{ url, head: gate.head, mergeCommit: 'merge-a' }],
  daemons: [{ daemon: 'target', commit: 'build-a', contains: ['merge-a'] }],
};

function setup() {
  const db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  createCodingPackTables(db);
  const todos = new NeoAskTodoRepository(db);
  todos.openAsk({
    id: 'ask',
    sessionId: 'synthetic',
    projectId: null,
    originMessageId: null,
    title: 'Deliver change',
    request: 'Change behavior',
    createdAt: 1,
  });
  todos.addTodo(
    'todo',
    'ask',
    { title: 'Ship', doneWhen: 'Smoke passes', check: null, instruction: null, named: null },
    1
  );
  const repo = new CodingDeliveryFactsRepository(db);
  return {
    db,
    repo,
    record: (input = smoke, builds = deploys, head = gate.head) =>
      recordCodingSmoke(repo, 'todo', url, head, input, builds),
  };
}

const candidate = {
  url,
  head: gate.head,
  open: true,
  requiredCiGreen: true,
  findingsResolved: true,
  humanSignoffSatisfied: true,
  ciEvidence: ['ci:7'],
  reviewEvidence: ['review:7'],
};
const contract = { reference: gate.acceptanceContract, write: gate.write, qa: gate.qa };
const review = { kind: 'bot', head: gate.head, login: gate.reviewer, approved: true };
const qa: CodingStageFact = {
  url,
  head: gate.head,
  stage: 'qa',
  ref: gate.qa,
  actor: smoke.actor,
  verdict: 'pass',
  acceptanceContract: gate.acceptanceContract,
  evidence: ['artifact:qa'],
};

describe('coding manual merge preparation', () => {
  test('records matching gates, rereads head, and returns only a pinned manual command', async () => {
    const { db, repo } = setup();
    try {
      let reads = 0;
      const result = await prepareCodingMerge(
        repo,
        'todo',
        candidate,
        contract,
        review,
        [qa],
        async () => {
          reads++;
          return gate.head;
        }
      );
      expect(result).toEqual({
        accepted: true,
        head: gate.head,
        command: ['gh', 'pr', 'merge', url, '--squash', '--match-head-commit', gate.head],
      });
      expect(reads).toBe(1);
      expect(repo.read('todo', url, gate.head)).toEqual({
        gate: { ...gate, evidence: ['ci:7', 'review:7', 'artifact:qa'] },
        smoke: null,
      });
    } finally {
      db.close();
    }
  });

  test('missing merge prerequisites never record authorization', async () => {
    const { db, repo } = setup();
    try {
      for (const patch of [
        { open: false },
        { requiredCiGreen: false },
        { findingsResolved: false },
        { humanSignoffSatisfied: false },
        { ciEvidence: [] },
      ]) {
        expect(
          await prepareCodingMerge(
            repo,
            'todo',
            { ...candidate, ...patch },
            contract,
            review,
            [qa],
            async () => gate.head
          )
        ).toEqual({ accepted: false, reason: 'merge_requirements_not_satisfied' });
      }
      expect(repo.read('todo', url, gate.head)).toBeNull();
    } finally {
      db.close();
    }
  });

  test('bot rejection has no fallback to a passing reviewer session fact', async () => {
    const { db, repo } = setup();
    try {
      const reviewFact: CodingStageFact = {
        ...qa,
        stage: 'review',
        actor: { ...smoke.actor, id: 'session-reviewer' },
      };
      for (const rejected of [
        { ...review, approved: false },
        { ...review, head: 'old-head' },
      ])
        expect(
          await prepareCodingMerge(
            repo,
            'todo',
            candidate,
            contract,
            rejected,
            [qa, reviewFact],
            async () => gate.head
          )
        ).toEqual({ accepted: false, reason: 'matching_head_review_required' });
      expect(repo.read('todo', url, gate.head)).toBeNull();
    } finally {
      db.close();
    }
  });

  test('QA must pass for this PR, head, contract and independent assigned actor', async () => {
    const { db, repo } = setup();
    try {
      for (const patch of [
        { head: 'old' },
        { url: url.replace('/7', '/8') },
        { acceptanceContract: 'other' },
        { verdict: 'fail' as const },
        { verdict: 'inconclusive' as const },
        { evidence: [] },
        { actor: { ...smoke.actor, id: 'other' } },
      ])
        expect(
          await prepareCodingMerge(
            repo,
            'todo',
            candidate,
            contract,
            review,
            [{ ...qa, ...patch }],
            async () => gate.head
          )
        ).toEqual({ accepted: false, reason: 'independent_matching_head_qa_required' });
      for (const id of [gate.write.id, 'reviewer-session'])
        expect(
          await prepareCodingMerge(
            repo,
            'todo',
            candidate,
            {
              ...contract,
              qa: { adapter: 'test', id },
              reviewer: { adapter: 'test', id: 'reviewer-session' },
            },
            review,
            [{ ...qa, actor: { ...qa.actor, id } }],
            async () => gate.head
          )
        ).toEqual({ accepted: false, reason: 'independent_matching_head_qa_required' });
      expect(repo.read('todo', url, gate.head)).toBeNull();
    } finally {
      db.close();
    }
  });

  test('a concurrent head push refuses authorization', async () => {
    const { db, repo } = setup();
    try {
      expect(
        await prepareCodingMerge(
          repo,
          'todo',
          candidate,
          contract,
          review,
          [qa],
          async () => 'head-b'
        )
      ).toEqual({ accepted: false, reason: 'head_changed_before_manual_merge' });
      expect(repo.read('todo', url, gate.head)).toBeNull();
    } finally {
      db.close();
    }
  });

  test('a non-bot review uses its matching-head passing stage fact', async () => {
    const { db, repo } = setup();
    try {
      const sessionReview = { kind: 'session', head: gate.head, sessionId: 'reviewer-session' };
      expect(
        await prepareCodingMerge(
          repo,
          'todo',
          candidate,
          { ...contract, reviewer: { adapter: 'test', id: sessionReview.sessionId } },
          sessionReview,
          [qa],
          async () => gate.head
        )
      ).toEqual({ accepted: false, reason: 'matching_head_review_required' });
      const result = await prepareCodingMerge(
        repo,
        'todo',
        candidate,
        { ...contract, reviewer: { adapter: 'test', id: sessionReview.sessionId } },
        sessionReview,
        [
          qa,
          {
            ...qa,
            stage: 'review',
            ref: { adapter: 'test', id: sessionReview.sessionId },
            actor: { ...qa.actor, id: sessionReview.sessionId },
          },
        ],
        async () => gate.head
      );
      expect(result.accepted).toBe(true);
      expect(repo.read('todo', url, gate.head)?.gate.reviewer).toEqual({
        adapter: 'test',
        id: 'reviewer-session',
      });
    } finally {
      db.close();
    }
  });
});

test('unbound or colliding local identities cannot supply QA approval', async () => {
  const { db, repo } = setup();
  try {
    for (const ref of [
      undefined,
      { ...contract.qa, adapter: 'other' },
      { ...contract.qa, daemon: 'other' },
    ]) {
      expect(
        await prepareCodingMerge(
          repo,
          'todo',
          candidate,
          contract,
          review,
          [{ ...qa, ref }],
          async () => gate.head
        )
      ).toEqual({ accepted: false, reason: 'independent_matching_head_qa_required' });
    }
    const wrongHarness = { ...qa, ref: contract.qa, actor: { ...smoke.actor, harness: 'other' } };
    expect(
      await prepareCodingMerge(
        repo,
        'todo',
        candidate,
        contract,
        review,
        [wrongHarness],
        async () => gate.head
      )
    ).toEqual({ accepted: false, reason: 'independent_matching_head_qa_required' });
    expect(repo.read('todo', url, gate.head)).toBeNull();
  } finally {
    db.close();
  }
});

test('a conflicting existing receipt never authorizes a different assignment', async () => {
  const { db, repo } = setup();
  try {
    await repo.write('recordGate', 'todo', { ...gate, qa: { adapter: 'other', id: gate.qa.id } });
    expect(
      await prepareCodingMerge(
        repo,
        'todo',
        candidate,
        contract,
        review,
        [qa],
        async () => gate.head
      )
    ).toEqual({ accepted: false, reason: 'merge_receipt_changed' });
  } finally {
    db.close();
  }
});

test('bot approval without a durable review evidence reference is insufficient', async () => {
  const { db, repo } = setup();
  try {
    expect(
      await prepareCodingMerge(
        repo,
        'todo',
        { ...candidate, reviewEvidence: [] },
        contract,
        review,
        [qa],
        async () => gate.head
      )
    ).toEqual({ accepted: false, reason: 'matching_head_review_required' });
  } finally {
    db.close();
  }
});

test('repeated preparation keeps the latest evidence while preserving assignment identity', async () => {
  const { db, repo } = setup();
  try {
    const first = await prepareCodingMerge(
      repo,
      'todo',
      candidate,
      contract,
      review,
      [qa],
      async () => gate.head
    );
    expect(first.accepted).toBe(true);
    const rerun = { ...candidate, ciEvidence: ['ci:new-run'] };
    expect(
      (await prepareCodingMerge(repo, 'todo', rerun, contract, review, [qa], async () => gate.head))
        .accepted
    ).toBe(true);
    expect(repo.read('todo', url, gate.head)?.gate.evidence).toEqual([
      'ci:new-run',
      'review:7',
      'artifact:qa',
    ]);
  } finally {
    db.close();
  }
});
