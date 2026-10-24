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

describe('coding delivery evidence', () => {
  test('requires a matching-head merge gate before recording smoke', async () => {
    const { db, repo, record } = setup();
    try {
      expect(await record()).toEqual({ accepted: false, reason: 'matching_merge_gate_required' });
      await repo.write('recordGate', 'todo', gate);
      expect(await record(smoke, deploys, 'head-b')).toEqual({
        accepted: false,
        reason: 'matching_merge_gate_required',
      });
      expect(await record()).toEqual({ accepted: true });
      expect(repo.read('todo', url, gate.head)?.smoke).toEqual(smoke);
    } finally {
      db.close();
    }
  });

  test('checks the exact target build and merge ancestry', async () => {
    const { db, repo, record } = setup();
    try {
      await repo.write('recordGate', 'todo', gate);
      for (const daemons of [
        [],
        [{ ...deploys.daemons[0], contains: [] }],
        [{ ...deploys.daemons[0], daemon: 'other' }],
        [{ ...deploys.daemons[0], commit: 'old' }],
      ]) {
        expect(await record(smoke, { ...deploys, daemons })).toEqual({
          accepted: false,
          reason: 'running_build_must_contain_merge',
        });
      }
      expect(await record({ ...smoke, mergeCommit: 'other-merge' })).toEqual({
        accepted: false,
        reason: 'matching_merge_commit_required',
      });
      expect(repo.read('todo', url, gate.head)?.smoke).toBeNull();
    } finally {
      db.close();
    }
  });

  test('only the assigned independent QA actor can record smoke', async () => {
    const { db, repo, record } = setup();
    try {
      await repo.write('recordGate', 'todo', gate);
      for (const id of ['author', 'review-bot', 'unassigned'])
        expect(await record({ ...smoke, actor: { ...smoke.actor, id } })).toEqual({
          accepted: false,
          reason: 'independent_qa_required',
        });
    } finally {
      db.close();
    }
  });

  test('records failure after a pass, and an explicit non-deployable reason', async () => {
    const { db, repo, record } = setup();
    try {
      await repo.write('recordGate', 'todo', gate);
      await record();
      await record({ ...smoke, verdict: 'fail' });
      expect(repo.read('todo', url, gate.head)?.smoke?.verdict).toBe('fail');
      const notApplicable: CodingSmoke = { ...smoke, verdict: 'inapplicable', build: undefined };
      expect(await record(notApplicable)).toEqual({
        accepted: false,
        reason: 'inapplicability_reason_required',
      });
      expect(
        await record(
          { ...notApplicable, reason: 'Documentation only; no running behavior changed' },
          { ...deploys, daemons: [] }
        )
      ).toEqual({ accepted: true });
      expect(repo.read('todo', url, gate.head)?.smoke?.reason).toBe(
        'Documentation only; no running behavior changed'
      );
    } finally {
      db.close();
    }
  });

  test('preserves the accepted gate and historical heads', async () => {
    const { db, repo, record } = setup();
    try {
      await repo.write('recordGate', 'todo', gate);
      await record();
      await repo.write('recordGate', 'todo', {
        ...gate,
        qa: { adapter: 'test', id: 'replacement' },
      });
      await repo.write('recordGate', 'todo', { ...gate, head: 'head-b' });
      expect(repo.read('todo', url, 'head-a')).toEqual({ gate, smoke });
      expect(repo.read('todo', url, 'head-b')?.smoke).toBeNull();
    } finally {
      db.close();
    }
  });
});

test('a containing build for an ungated merged head cannot record smoke', async () => {
  const { db, repo, record } = setup();
  try {
    await repo.write('recordGate', 'todo', gate);
    for (const head of ['head-b', undefined]) {
      expect(
        await record(smoke, { ...deploys, prs: [{ url, head, mergeCommit: smoke.mergeCommit }] })
      ).toEqual({ accepted: false, reason: 'matching_merge_commit_required' });
    }
    expect(repo.read('todo', url, gate.head)?.smoke).toBeNull();
  } finally {
    db.close();
  }
});

test('stage facts preserve full refs while accepting historical unbound facts', () => {
  const fact = {
    url,
    head: gate.head,
    stage: 'qa',
    actor: smoke.actor,
    verdict: 'pass',
    acceptanceContract: gate.acceptanceContract,
    evidence: ['artifact:qa'],
  };
  expect(CodingStageFact.parse(fact).ref).toBeUndefined();
  expect(CodingStageFact.parse({ ...fact, ref: gate.qa }).ref).toEqual(gate.qa);
});

test('a removed gate cannot acknowledge a smoke write', async () => {
  const { db, repo } = setup();
  try {
    await repo.write('recordGate', 'todo', gate);
    db.prepare('DELETE FROM pack_coding_delivery_facts WHERE todo_id = ?').run('todo');
    expect(await repo.write('recordSmoke', 'todo', gate, smoke)).toBe(false);
    expect(repo.read('todo', url, gate.head)).toBeNull();
  } finally { db.close(); }
});
