import { describe, expect, test } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { CodingAssignmentsRepository } from '../../../../src/lib/neo/packs/coding/assignments.ts';
import {
  CodingTodoPrRepository,
  createCodingTodoPack,
} from '../../../../src/lib/neo/packs/coding/todo-prs.ts';
import { createCodingSmokeOperation } from '../../../../src/lib/neo/packs/coding/smoke-operation.ts';
import type { CodingSmoke } from '../../../../src/lib/neo/packs/coding/delivery-facts.ts';
import type { CodingStageFact } from '../../../../src/lib/neo/packs/coding/stage-facts.ts';
import type { NeoWorkPr } from '@hyperneo/shared/types/neo-snapshot';

const url = 'https://github.com/synthetic/delivery/pull/7';
const write = { adapter: 'test', id: 'author' },
  ref = { adapter: 'test', id: 'qa' };
const actor = { kind: 'agent', id: ref.id, harness: ref.adapter, model: 'gpt-6' } as const;
const qa: CodingStageFact = {
  url,
  head: 'head-a',
  stage: 'qa',
  ref,
  actor,
  verdict: 'pass',
  acceptanceContract: 'artifact:acceptance',
  evidence: ['artifact:qa'],
};
const smoke: CodingSmoke = {
  actor,
  ref,
  verdict: 'pass',
  mergeCommit: 'merge-a',
  build: { daemon: 'target', commit: 'build-a' },
  evidence: ['artifact:smoke'],
};

async function setup(kind: 'pr_merged' | 'issue_closed' = 'pr_merged', marked = true) {
  const db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  const repo = new CodingTodoPrRepository(db),
    store = new NeoAskTodoRepository(db);
  store.openAsk({
    id: 'ask',
    sessionId: 'synthetic',
    projectId: null,
    originMessageId: null,
    title: 'Deliver',
    request: 'Deliver',
    createdAt: 1,
  });
  let pr: NeoWorkPr = {
    url,
    head: qa.head,
    state: 'MERGED',
    checks: 'passing',
    review: 'approved',
  };
  const pack = createCodingTodoPack(
    repo,
    async () => [pr],
    undefined,
    async () => [
      {
        kind: 'issue',
        url: 'https://github.com/synthetic/delivery/issues/1',
        state: 'CLOSED',
        stateReason: 'COMPLETED',
        closingPrs: [url],
      },
    ]
  );
  pack.schema(db);
  const todo = store.addTodo(
    'todo',
    'ask',
    {
      title: 'Deliver',
      doneWhen: 'Delivered',
      instruction: null,
      named: null,
      check: {
        pack: 'coding',
        kind,
        params: kind === 'pr_merged' ? { urls: [url] } : { issue: 'synthetic/delivery#1' },
      },
    },
    1
  );
  await repo.write('record', todo.id, [pr], 1);
  const assignments = new CodingAssignmentsRepository(db);
  if (marked) {
    const base = {
      url,
      head: qa.head,
      acceptanceContract: qa.acceptanceContract,
      newDispatch: true as const,
      write,
    };
    await assignments.recordLater(todo.id, 'review', { ...base, bot: 'review-bot' });
    await assignments.recordLater(todo.id, 'qa', { ...base, ref, actor });
  }
  const gate = async () => {
    repo.stageFacts.record(qa);
    await repo.deliveryFacts.write('recordGate', todo.id, {
      url,
      head: qa.head,
      acceptanceContract: qa.acceptanceContract,
      write,
      qa: ref,
      reviewer: 'review-bot',
      evidence: qa.evidence,
    });
  };
  let reads = 0;
  const operation = createCodingSmokeOperation(repo.deliveryFacts, assignments, async () => {
    reads++;
    return {
      prs: [{ url, head: pr.head, mergeCommit: 'merge-a' }],
      daemons: [{ daemon: 'target', commit: 'build-a', contains: ['merge-a'] }],
    };
  });
  const record = (input = smoke) =>
    operation.execute(
      { todoId: todo.id, url, head: qa.head, smoke: input },
      { source: 'internal', role: 'neo' }
    );
  return {
    db,
    repo,
    todo,
    pack,
    gate,
    record,
    readCount: () => reads,
    push: () => {
      pr = { ...pr, head: 'head-b' };
    },
  };
}

describe('coding delivery completion', () => {
  test.each(['pr_merged', 'issue_closed'] as const)(
    'unmarked legacy %s still completes on its original condition',
    async (kind) => {
      const s = await setup(kind, false);
      try {
        expect((await s.pack.check(s.todo))?.done).toBe(true);
      } finally {
        s.db.close();
      }
    }
  );

  test.each(['pr_merged', 'issue_closed'] as const)(
    'marked %s stays open through merge and failed smoke',
    async (kind) => {
      const s = await setup(kind);
      try {
        expect((await s.pack.check(s.todo))?.done).toBe(false);
        await s.gate();
        expect((await s.pack.check(s.todo))?.done).toBe(false);
        expect(await s.record({ ...smoke, verdict: 'fail' })).toEqual({ accepted: true });
        expect(await s.pack.check(s.todo)).toEqual({ done: false, evidence: null });
        const facts = await s.pack.readFacts(s.todo);
        expect(s.pack.judge(s.todo, facts)).toEqual({ state: 'no_opinion' });
        expect(await s.record()).toEqual({ accepted: true });
        expect((await s.pack.check(s.todo))?.done).toBe(true);
        expect(s.pack.judge(s.todo, await s.pack.readFacts(s.todo)).state).toBe('done');
      } finally {
        s.db.close();
      }
    }
  );

  test('explicit non-deployable reason satisfies smoke; missing reason does not', async () => {
    const s = await setup();
    try {
      await s.gate();
      expect(await s.record({ ...smoke, verdict: 'inapplicable', build: undefined })).toEqual({
        accepted: false,
        reason: 'inapplicability_reason_required',
      });
      expect((await s.pack.check(s.todo))?.done).toBe(false);
      expect(
        await s.record({
          ...smoke,
          verdict: 'inapplicable',
          build: undefined,
          reason: 'Documentation only',
        })
      ).toEqual({ accepted: true });
      expect((await s.pack.check(s.todo))?.done).toBe(true);
    } finally {
      s.db.close();
    }
  });

  test('a new head cannot revert a gated todo to legacy completion', async () => {
    const s = await setup();
    try {
      await s.gate();
      await s.record();
      s.push();
      expect((await s.pack.check(s.todo))?.done).toBe(false);
    } finally {
      s.db.close();
    }
  });

  test('smoke requires the assigned actor before reading deployment facts', async () => {
    const s = await setup();
    try {
      await s.gate();
      expect(await s.record({ ...smoke, actor: { ...actor, id: write.id }, ref: write })).toEqual({
        accepted: false,
        reason: 'stage_assignment_mismatch',
      });
      expect(s.readCount()).toBe(0);
    } finally {
      s.db.close();
    }
  });

  test('invalidated QA cannot approve completion using an older receipt', async () => {
    const s = await setup();
    try {
      await s.gate();
      await s.record();
      s.repo.stageFacts.observeHead(url, 'different', Date.now() + 1);
      expect((await s.pack.check(s.todo))?.done).toBe(false);
    } finally {
      s.db.close();
    }
  });

  test('judgement replays its captured receipt and facts without touching storage', async () => {
    const s = await setup();
    await s.gate();
    await s.record();
    const facts = await s.pack.readFacts(s.todo);
    s.db.close();
    expect(s.pack.judge(s.todo, facts).state).toBe('done');
  });
});

test('a receipt cannot cover newer QA evidence it never recorded', async () => {
  const s = await setup();
  try {
    await s.gate();
    await s.record();
    expect(s.repo.stageFacts.record({ ...qa, evidence: ['artifact:new-qa'] })).toBe(true);
    expect((await s.pack.check(s.todo))?.done).toBe(false);
  } finally {
    s.db.close();
  }
});

test('smoke cannot acknowledge a receipt for a different acceptance contract', async () => {
  const s = await setup();
  try {
    s.repo.stageFacts.record(qa);
    await s.repo.deliveryFacts.write('recordGate', s.todo.id, {
      url,
      head: qa.head,
      acceptanceContract: 'other',
      write,
      qa: ref,
      reviewer: 'review-bot',
      evidence: qa.evidence,
    });
    expect(await s.record()).toEqual({ accepted: false, reason: 'stage_assignment_mismatch' });
    expect(s.readCount()).toBe(0);
  } finally {
    s.db.close();
  }
});
